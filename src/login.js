import { spawn as spawnProcess } from "node:child_process";
import os from "node:os";
import process from "node:process";

import { credentialsPath, deleteSavedLogin, readSavedLogin, saveLogin } from "./credentials.js";

const DEFAULT_POLL_INTERVAL_SECONDS = 3;
const MAX_WAIT_MS = 15 * 60 * 1000;
// RFC 8628 device sign-in: each "slow down" answer adds 5 seconds to the
// interval for the rest of the wait.
const SLOW_DOWN_STEP_MS = 5000;
// A request that stalls counts as a missed poll, so waiting ends at most one
// timeout after expires_at.
const REQUEST_TIMEOUT_MS = 30 * 1000;
const ENV_TOKEN_IN_USE = "TESTING_FLOOR_API_TOKEN is set, so commands use that token instead of a saved login.";

// Device sign-in: Testing Floor issues a short code, the person approves it
// in their browser, and the CLI saves the token it gets back.
export async function login({
  apiUrl,
  env = process.env,
  cliVersion,
  noBrowser = false,
  openBrowser = openInBrowser,
  sleep = defaultSleep,
  now = Date.now,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  log = console.error,
  print = console.log
}) {
  const activation = await startActivation(apiUrl, { device_name: os.hostname(), cli_version: cliVersion }, requestTimeoutMs);

  log(`Your code: ${activation.code}`);
  log(`Approve it at ${activation.claimUrl}`);
  if (!noBrowser && !(await openBrowser(activation.claimUrl))) {
    log("Couldn't open a browser. Open the link above to approve.");
  }
  log("Waiting for approval...");

  const claim = await waitForClaim(activation, { sleep, now, log, requestTimeoutMs });
  await saveLogin(env, {
    apiUrl,
    token: claim.token,
    user: { name: stringOrNull(claim.user?.name), email: stringOrNull(claim.user?.email) },
    createdAt: new Date(now()).toISOString()
  });

  print(`Signed in as ${describeUser(claim.user)}.`);
  if (env.TESTING_FLOOR_API_TOKEN) {
    log(ENV_TOKEN_IN_USE);
  }
}

export async function logout({ env = process.env, print = console.log } = {}) {
  if (await deleteSavedLogin(env)) {
    print(`Signed out. Deleted the saved login at ${credentialsPath(env)}.`);
  } else {
    print("Not signed in, so there was no saved login to delete.");
  }

  if (env.TESTING_FLOOR_API_TOKEN) {
    print(ENV_TOKEN_IN_USE);
  }
}

export async function whoami({ apiUrl, env = process.env, print = console.log }) {
  const saved = await readSavedLogin(env);

  if (env.TESTING_FLOOR_API_TOKEN) {
    print(ENV_TOKEN_IN_USE);
    if (saved) {
      print(`Saved login: ${describeUser(saved.user)} for ${saved.apiUrl}.`);
    }
    return;
  }

  if (!saved) {
    print('Not signed in. Run "testingfloor login" to sign in.');
    return;
  }

  print(`Signed in as ${describeUser(saved.user)}.`);
  print(`API URL: ${saved.apiUrl}`);
  if (saved.apiUrl !== apiUrl) {
    print(`Commands that use ${apiUrl} don't use this login. To sign in there, run "testingfloor login --api-url ${apiUrl}".`);
  }
}

// Opens the URL in the default browser. Never throws: when it can't open
// one, it resolves false and the caller relies on the printed link.
export function openInBrowser(url, { platform = process.platform, spawn = spawnProcess } = {}) {
  const { command, args, options } = browserCommand(url, platform);
  return new Promise((resolve) => {
    let child;
    try {
      // Detached so the browser doesn't get Ctrl-C when the person stops the CLI.
      child = spawn(command, args, { stdio: "ignore", detached: platform !== "win32", windowsHide: true, ...options });
    } catch {
      resolve(false);
      return;
    }
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

export function browserCommand(url, platform = process.platform) {
  if (platform === "darwin") {
    return { command: "open", args: [url], options: {} };
  }

  if (platform === "win32") {
    // The quotes keep cmd from treating & in the URL as a command separator.
    // The empty title is there because start reads its first quoted argument
    // as the window title.
    return { command: "cmd", args: ["/c", "start", '""', `"${url}"`], options: { windowsVerbatimArguments: true } };
  }

  return { command: "xdg-open", args: [url], options: {} };
}

async function startActivation(apiUrl, details, timeoutMs) {
  const url = `${apiUrl}/api/cli/activations`;
  const response = await send(url, { method: "POST", body: details, timeoutMs });
  if (response.unreachable) {
    throw new Error(`Couldn't start signing in: ${response.unreachable}`);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Couldn't start signing in: ${errorText(response, url)}`);
  }

  const body = response.body ?? {};
  if (!body.code || !body.claim_url || !body.poll_url) {
    throw new Error(`Testing Floor's sign-in response from ${url} is missing its code, claim_url or poll_url.`);
  }

  return {
    code: String(body.code),
    claimUrl: httpUrl(body.claim_url, apiUrl, "claim_url"),
    pollUrl: httpUrl(body.poll_url, apiUrl, "poll_url"),
    expiresAt: Date.parse(body.expires_at),
    intervalMs: positiveNumber(body.interval_seconds, DEFAULT_POLL_INTERVAL_SECONDS) * 1000
  };
}

async function waitForClaim(activation, { sleep, now, log, requestTimeoutMs }) {
  const startedAt = now();
  // expires_at is the server's clock. If it already looks past, this clock is
  // probably ahead, so wait the usual 15 minutes; the server still answers
  // 410 once the code really expires.
  const deadline = activation.expiresAt > startedAt ? activation.expiresAt : startedAt + MAX_WAIT_MS;
  let intervalMs = activation.intervalMs;
  let delayMs = intervalMs;
  let unreachable = false;

  for (;;) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      throw expiredError(activation.code);
    }
    await sleep(Math.min(delayMs, remainingMs));

    const outcome = pollOutcome(await send(activation.pollUrl, { method: "GET", timeoutMs: requestTimeoutMs }), now);
    delayMs = intervalMs;

    switch (outcome.kind) {
      case "claimed":
        return outcome;
      case "pending":
        unreachable = false;
        break;
      case "slow_down":
        intervalMs += SLOW_DOWN_STEP_MS;
        delayMs = Math.max(intervalMs, outcome.retryAfterMs);
        break;
      case "unreachable":
        // Log once per outage, not on every poll.
        if (!unreachable) {
          log(`Couldn't check for approval just now (${outcome.reason}); still waiting.`);
        }
        unreachable = true;
        break;
      case "expired":
        throw expiredError(activation.code);
      default:
        throw new Error(`Signing in failed: ${outcome.message}. Run "testingfloor login" to try again.`);
    }
  }
}

function pollOutcome(response, now) {
  if (response.unreachable) {
    return { kind: "unreachable", reason: response.unreachable };
  }
  if (response.status >= 500 || response.status === 408) {
    return { kind: "unreachable", reason: `${response.status} ${response.statusText}` };
  }
  if (response.status === 429) {
    return { kind: "slow_down", retryAfterMs: retryAfterMs(response.headers.get("retry-after"), now) };
  }

  const status = response.body?.status;
  if (response.status === 410 || status === "expired") {
    return { kind: "expired" };
  }
  if (response.status >= 400) {
    return { kind: "failed", message: errorText(response) };
  }
  if (status === "claimed") {
    if (typeof response.body.token !== "string" || response.body.token === "") {
      return { kind: "failed", message: "Testing Floor approved the code but didn't send a token" };
    }
    return { kind: "claimed", token: response.body.token, user: response.body.user ?? null };
  }
  if (status === "pending" || response.status === 202) {
    return { kind: "pending" };
  }

  return { kind: "failed", message: status ? `the code is ${status}` : `unexpected ${response.status} response` };
}

// The poll URL carries a secret, so errors name the host, never the URL.
async function send(url, { method, body, timeoutMs }) {
  const headers = { Accept: "application/json" };
  if (body) {
    headers["Content-Type"] = "application/json";
  }

  let response;
  let text;
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    response = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal });
    text = await response.text();
  } catch (error) {
    const reason = error.name === "TimeoutError" ? "no answer in time" : (error.cause?.code ?? error.cause?.message ?? error.message);
    return { unreachable: `couldn't reach ${new URL(url).host}: ${reason}` };
  }

  return { status: response.status, statusText: response.statusText, headers: response.headers, body: parseJson(text) };
}

function errorText(response, url) {
  const message = typeof response.body?.error === "string" ? response.body.error : null;
  if (message) {
    return message;
  }
  return url ? `${response.status} ${response.statusText} from ${url}` : `${response.status} ${response.statusText}`;
}

function expiredError(code) {
  return new Error(`Code ${code} expired before it was approved. Run "testingfloor login" again.`);
}

function httpUrl(raw, base, name) {
  let url;
  try {
    url = new URL(String(raw), base);
  } catch {
    url = null;
  }
  if (!url || !["http:", "https:"].includes(url.protocol)) {
    throw new Error(`Testing Floor's sign-in response has an invalid ${name}.`);
  }
  return url.href;
}

function retryAfterMs(header, now) {
  if (!header) {
    return 0;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now()) : 0;
}

function describeUser(user) {
  const name = stringOrNull(user?.name);
  const email = stringOrNull(user?.email);
  if (name && email) {
    return `${name} (${email})`;
  }
  return name ?? email ?? "your Testing Floor account";
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
