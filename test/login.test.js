import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main, resolveMapPlan, resolveTelemetryPlan, resolveUploadPlan } from "../src/cli.js";
import { credentialsDirectory, credentialsPath, readSavedLogin, saveLogin } from "../src/credentials.js";
import { browserCommand, login, openInBrowser } from "../src/login.js";

const TOKEN = "tf_api_login_secret";
const POLL_TOKEN = "poll-secret";
const USER = { name: "Ada Lovelace", email: "ada@example.com" };

// A Testing Floor stand-in that answers polls from a script of
// [status, body, headers] replies, repeating the last one. A "stall" reply
// starts the response and never finishes it.
function activationServer(polls, { expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString() } = {}) {
  const state = { activationRequests: [], pollRequests: [] };
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const url = new URL(request.url, "http://localhost");

    if (request.method === "POST" && url.pathname === "/api/cli/activations") {
      state.activationRequests.push({ headers: request.headers, body: JSON.parse(body) });
      const base = `http://127.0.0.1:${server.address().port}`;
      return writeJson(response, 201, {
        status: "pending",
        code: "ABC123",
        expires_at: expiresAt,
        claim_url: `${base}/cli/activate/ABC123`,
        poll_url: `${base}/api/cli/activations/ABC123?poll_token=${POLL_TOKEN}`,
        interval_seconds: 3
      });
    }

    if (request.method === "GET" && url.pathname === "/api/cli/activations/ABC123") {
      state.pollRequests.push({ headers: request.headers, pollToken: url.searchParams.get("poll_token") });
      const [status, reply, headers] = polls[Math.min(state.pollRequests.length - 1, polls.length - 1)];
      if (status === "stall") {
        response.writeHead(200, { "Content-Type": "application/json" });
        return response.write('{"status":');
      }
      return writeJson(response, status, reply, headers);
    }

    writeJson(response, 404, { error: "not found" });
  });
  return { server, state };
}

async function startServer(t, polls, options) {
  const { server, state } = activationServer(polls, options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { apiUrl: `http://127.0.0.1:${server.address().port}`, state };
}

function writeJson(response, status, body, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

async function configDir() {
  return mkdtemp(path.join(os.tmpdir(), "testingfloor-login-"));
}

// Output, a browser and a clock that tests can inspect. sleep advances the
// clock instead of waiting.
function fakes({ opens = true, start = Date.parse("2030-01-01T00:00:00Z") } = {}) {
  const fake = { logged: [], printed: [], opened: [], delays: [], clock: start };
  fake.deps = {
    cliVersion: "1.2.3",
    log: (line) => fake.logged.push(line),
    print: (line) => fake.printed.push(line),
    openBrowser: async (url) => {
      fake.opened.push(url);
      return opens;
    },
    sleep: async (ms) => {
      fake.delays.push(ms);
      fake.clock += ms;
    },
    now: () => fake.clock
  };
  return fake;
}

test("login saves the token once the code is approved, and never prints it", async (t) => {
  const { apiUrl, state } = await startServer(t, [
    [202, { status: "pending" }],
    [200, { status: "pending" }],
    [200, { status: "claimed", token: TOKEN, user: USER }]
  ]);
  const env = { TESTING_FLOOR_CONFIG_DIR: await configDir() };
  const fake = fakes();

  await main(["login", "--api-url", `${apiUrl}/`], env, process.cwd(), fake.deps);

  assert.deepEqual(state.activationRequests[0].body, { device_name: os.hostname(), cli_version: "1.2.3" });
  assert.equal(state.activationRequests[0].headers.authorization, undefined);
  assert.equal(state.pollRequests.length, 3);
  assert.ok(state.pollRequests.every((poll) => poll.pollToken === POLL_TOKEN && !poll.headers.authorization));
  assert.deepEqual(fake.delays, [3000, 3000, 3000]);

  assert.deepEqual(fake.opened, [`${apiUrl}/cli/activate/ABC123`]);
  assert.ok(fake.logged.includes("Your code: ABC123"));
  assert.ok(fake.logged.includes(`Approve it at ${apiUrl}/cli/activate/ABC123`));
  assert.deepEqual(fake.printed, ["Signed in as Ada Lovelace (ada@example.com)."]);
  const output = [...fake.logged, ...fake.printed].join("\n");
  assert.ok(!output.includes(TOKEN), "the token is never printed");
  assert.ok(!output.includes(POLL_TOKEN), "the poll URL's secret is never printed");

  const saved = JSON.parse(await readFile(credentialsPath(env), "utf8"));
  assert.deepEqual(saved, { apiUrl, token: TOKEN, user: USER, createdAt: "2030-01-01T00:00:09.000Z" });
});

test("login with --no-browser only prints the link, and says so when a browser won't open", async (t) => {
  const { apiUrl } = await startServer(t, [[200, { status: "claimed", token: TOKEN, user: USER }]]);

  const skipped = fakes();
  await main(["login", "--api-url", apiUrl, "--no-browser"], { TESTING_FLOOR_CONFIG_DIR: await configDir() }, process.cwd(), skipped.deps);
  assert.deepEqual(skipped.opened, []);
  assert.ok(skipped.logged.includes(`Approve it at ${apiUrl}/cli/activate/ABC123`));

  const failed = fakes({ opens: false });
  await main(["login", "--api-url", apiUrl], { TESTING_FLOOR_CONFIG_DIR: await configDir() }, process.cwd(), failed.deps);
  assert.equal(failed.opened.length, 1);
  assert.ok(failed.logged.includes("Couldn't open a browser. Open the link above to approve."));
  assert.deepEqual(failed.printed, ["Signed in as Ada Lovelace (ada@example.com)."]);
});

test("login fails with a way forward when the code expires, and saves nothing", async (t) => {
  const { apiUrl } = await startServer(t, [[200, { status: "pending" }], [410, { status: "expired" }]]);
  const env = { TESTING_FLOOR_CONFIG_DIR: await configDir() };
  const fake = fakes();

  await assert.rejects(login({ ...fake.deps, apiUrl, env }), /Code ABC123 expired before it was approved\. Run "testingfloor login" again\./);
  assert.equal(await readSavedLogin(env), null);

  const bare = await startServer(t, [[410, {}]]);
  await assert.rejects(login({ ...fakes().deps, apiUrl: bare.apiUrl, env }), /Code ABC123 expired/, "a 410 means expired whatever its body says");
});

test("login stops waiting at expires_at even if the server keeps saying pending", async (t) => {
  const fake = fakes();
  const { apiUrl, state } = await startServer(t, [[200, { status: "pending" }]], {
    expiresAt: new Date(fake.clock + 10_000).toISOString()
  });

  await assert.rejects(login({ ...fake.deps, apiUrl, env: { TESTING_FLOOR_CONFIG_DIR: await configDir() } }), /expired before it was approved/);
  assert.deepEqual(fake.delays, [3000, 3000, 3000, 1000], "the last wait ends at expires_at");
  assert.equal(state.pollRequests.length, 4);
});

test("a poll that never finishes counts as a missed poll, and waiting still ends at expires_at", { timeout: 5000 }, async (t) => {
  const fake = fakes();
  const { apiUrl, state } = await startServer(t, [["stall"]], { expiresAt: new Date(fake.clock + 10_000).toISOString() });

  await assert.rejects(
    login({ ...fake.deps, requestTimeoutMs: 50, apiUrl, env: { TESTING_FLOOR_CONFIG_DIR: await configDir() } }),
    /expired before it was approved/
  );
  assert.equal(state.pollRequests.length, 4);
  assert.deepEqual(fake.logged.filter((line) => line.startsWith("Couldn't check for approval just now")), [
    `Couldn't check for approval just now (couldn't reach ${new URL(apiUrl).host}: no answer in time); still waiting.`
  ]);
});

test("login slows down when asked to and keeps polling", async (t) => {
  const { apiUrl, state } = await startServer(t, [
    [429, { error: "slow down" }, { "Retry-After": "20" }],
    [429, { error: "slow down" }],
    [200, { status: "pending" }],
    [200, { status: "claimed", token: TOKEN, user: USER }]
  ]);
  const env = { TESTING_FLOOR_CONFIG_DIR: await configDir() };
  const fake = fakes();

  await login({ ...fake.deps, apiUrl, env });

  // Each 429 adds 5 seconds to the interval for good; Retry-After stretches
  // only the next wait.
  assert.deepEqual(fake.delays, [3000, 20000, 13000, 13000]);
  assert.equal(state.pollRequests.length, 4);
  assert.equal((await readSavedLogin(env)).token, TOKEN);
});

test("login keeps waiting through server errors, and stops on a refusal", async (t) => {
  const flaky = await startServer(t, [
    [502, { error: "bad gateway" }],
    [503, { error: "unavailable" }],
    [200, { status: "claimed", token: TOKEN, user: USER }]
  ]);
  const fake = fakes();
  await login({ ...fake.deps, apiUrl: flaky.apiUrl, env: { TESTING_FLOOR_CONFIG_DIR: await configDir() } });
  assert.equal(fake.logged.filter((line) => line.startsWith("Couldn't check for approval just now")).length, 1, "an outage is logged once");

  const refused = await startServer(t, [[404, { error: "Activation not found" }]]);
  await assert.rejects(
    login({ ...fakes().deps, apiUrl: refused.apiUrl, env: { TESTING_FLOOR_CONFIG_DIR: await configDir() } }),
    /Signing in failed: Activation not found\. Run "testingfloor login" to try again\./
  );
  assert.equal(refused.state.pollRequests.length, 1);
});

test("commands use --token, then TESTING_FLOOR_API_TOKEN, then the config token, then the saved login", async () => {
  const cwd = await configDir();
  const apiUrl = "https://api.example.test";
  const loginEnv = { TESTING_FLOOR_CONFIG_DIR: cwd, TESTING_FLOOR_API_URL: apiUrl };
  await saveLogin(loginEnv, { apiUrl, token: "tf_saved", user: USER, createdAt: "2030-01-01T00:00:00.000Z" });
  await writeFile(path.join(cwd, "with-token.json"), JSON.stringify({ token: "tf_config" }));
  await writeFile(path.join(cwd, "without-token.json"), JSON.stringify({}));
  const common = { organizationId: "my-studio", gameId: "42" };
  const withEnv = { ...loginEnv, TESTING_FLOOR_API_TOKEN: "tf_env" };

  const tokenFor = async (options, env) => (await resolveTelemetryPlan({ ...common, ...options }, env, cwd)).token;
  assert.equal(await tokenFor({ token: "tf_flag", config: "with-token.json" }, withEnv), "tf_flag");
  assert.equal(await tokenFor({ config: "with-token.json" }, withEnv), "tf_env");
  assert.equal(await tokenFor({ config: "with-token.json" }, loginEnv), "tf_config");
  assert.equal(await tokenFor({ config: "without-token.json" }, loginEnv), "tf_saved");

  await writeFile(path.join(cwd, "map.png"), "png bytes");
  await writeFile(path.join(cwd, "Game.exe"), "exe bytes");
  const map = await resolveMapPlan({ ...common, levelId: "factory", image: "map.png", bounds: "0,0,10,10" }, loginEnv, cwd);
  const build = await resolveUploadPlan({ ...common, platform: "windows", archive: ".", version: "1.2.3", launchPath: "Game.exe" }, loginEnv, cwd);
  assert.equal(map.token, "tf_saved");
  assert.equal(build.token, "tf_saved");
});

test("a saved login is never sent to a different API URL", async () => {
  const dir = await configDir();
  await saveLogin({ TESTING_FLOOR_CONFIG_DIR: dir }, { apiUrl: "https://api.example.test", token: "tf_saved", user: USER, createdAt: "2030-01-01T00:00:00.000Z" });
  const env = { TESTING_FLOOR_CONFIG_DIR: dir, TESTING_FLOOR_API_URL: "https://staging.example.test" };

  await assert.rejects(
    resolveTelemetryPlan({ organizationId: "my-studio", gameId: "42" }, env, dir),
    /Missing API token for https:\/\/staging\.example\.test\. You're signed in to https:\/\/api\.example\.test; run "testingfloor login --api-url https:\/\/staging\.example\.test"/
  );
  await assert.rejects(
    resolveTelemetryPlan({ organizationId: "my-studio", gameId: "42" }, { TESTING_FLOOR_CONFIG_DIR: await configDir() }, dir),
    /Missing API token\. Run "testingfloor login", set TESTING_FLOOR_API_TOKEN, or pass --token\./
  );
});

test("logout deletes the saved login and says whether there was one", async () => {
  const env = { TESTING_FLOOR_CONFIG_DIR: await configDir() };
  const file = await saveLogin(env, { apiUrl: "https://api.example.test", token: TOKEN, user: USER, createdAt: "2030-01-01T00:00:00.000Z" });
  const printed = [];
  const print = (line) => printed.push(line);

  await main(["logout"], env, process.cwd(), { print });
  await assert.rejects(stat(file), { code: "ENOENT" });
  await main(["logout"], { ...env, TESTING_FLOOR_API_TOKEN: "tf_env" }, process.cwd(), { print });

  assert.deepEqual(printed, [
    `Signed out. Deleted the saved login at ${file}.`,
    "Not signed in, so there was no saved login to delete.",
    "TESTING_FLOOR_API_TOKEN is set, so commands use that token instead of a saved login."
  ]);
});

test("whoami shows the saved login, the env token in use, or how to sign in", async () => {
  const env = { TESTING_FLOOR_CONFIG_DIR: await configDir() };
  const whoami = async (args, extraEnv = {}) => {
    const printed = [];
    await main(["whoami", ...args], { ...env, ...extraEnv }, process.cwd(), { print: (line) => printed.push(line) });
    return printed;
  };

  assert.deepEqual(await whoami([]), ['Not signed in. Run "testingfloor login" to sign in.']);

  await saveLogin(env, { apiUrl: "https://api.example.test", token: TOKEN, user: USER, createdAt: "2030-01-01T00:00:00.000Z" });
  assert.deepEqual(await whoami(["--api-url", "https://api.example.test/"]), [
    "Signed in as Ada Lovelace (ada@example.com).",
    "API URL: https://api.example.test"
  ]);
  assert.deepEqual(await whoami([], { TESTING_FLOOR_API_URL: "https://staging.example.test" }), [
    "Signed in as Ada Lovelace (ada@example.com).",
    "API URL: https://api.example.test",
    'Commands that use https://staging.example.test don\'t use this login. To sign in there, run "testingfloor login --api-url https://staging.example.test".'
  ]);
  assert.deepEqual(await whoami([], { TESTING_FLOOR_API_TOKEN: "tf_env" }), [
    "TESTING_FLOOR_API_TOKEN is set, so commands use that token instead of a saved login.",
    "Saved login: Ada Lovelace (ada@example.com) for https://api.example.test."
  ]);
  assert.ok(!(await whoami([])).join("\n").includes(TOKEN));
});

test("the saved login is readable only by its owner", { skip: process.platform === "win32" }, async () => {
  const dir = path.join(await configDir(), "nested", "testingfloor");
  const file = await saveLogin({ TESTING_FLOOR_CONFIG_DIR: dir }, { apiUrl: "https://api.example.test", token: TOKEN, user: USER, createdAt: "2030-01-01T00:00:00.000Z" });

  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);

  await chmod(file, 0o644);
  await saveLogin({ TESTING_FLOOR_CONFIG_DIR: dir }, { apiUrl: "https://api.example.test", token: TOKEN, user: USER, createdAt: "2030-01-01T00:00:00.000Z" });
  assert.equal((await stat(file)).mode & 0o777, 0o600, "signing in again replaces a file others could read");
});

test("the saved login lives in the per-user config folder", () => {
  assert.equal(credentialsDirectory({ TESTING_FLOOR_CONFIG_DIR: "/tmp/tf-config", XDG_CONFIG_HOME: "/xdg" }, "linux"), "/tmp/tf-config");
  assert.equal(credentialsDirectory({ XDG_CONFIG_HOME: "/xdg" }, "linux"), "/xdg/testingfloor");
  assert.equal(credentialsDirectory({}, "darwin"), path.posix.join(os.homedir(), ".config", "testingfloor"));
  assert.equal(credentialsPath({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "win32"), "C:\\Users\\me\\AppData\\Roaming\\testingfloor\\credentials.json");
});

test("a damaged saved login says how to recover", async () => {
  const env = { TESTING_FLOOR_CONFIG_DIR: await configDir() };
  await writeFile(credentialsPath(env), "not json");

  await assert.rejects(readSavedLogin(env), /is damaged\. Run "testingfloor logout", then "testingfloor login"\./);
});

test("the browser opener uses each platform's default and never throws", async () => {
  const url = "https://example.test/cli/activate/ABC123?a=1&b=2";
  assert.deepEqual(browserCommand(url, "darwin"), { command: "open", args: [url], options: {} });
  assert.deepEqual(browserCommand(url, "linux"), { command: "xdg-open", args: [url], options: {} });
  assert.deepEqual(browserCommand(url, "win32"), {
    command: "cmd",
    args: ["/c", "start", '""', `"${url}"`],
    options: { windowsVerbatimArguments: true }
  });

  const child = (event) => {
    const emitter = new EventEmitter();
    emitter.unref = () => {
      emitter.unrefed = true;
    };
    queueMicrotask(() => emitter.emit(event, event === "error" ? new Error("spawn xdg-open ENOENT") : undefined));
    return emitter;
  };
  let started;
  assert.equal(await openInBrowser(url, { platform: "linux", spawn: () => (started = child("spawn")) }), true);
  assert.ok(started.unrefed, "the CLI doesn't wait for the browser to close");
  assert.equal(await openInBrowser(url, { platform: "linux", spawn: () => child("error") }), false);
  assert.equal(
    await openInBrowser(url, {
      platform: "linux",
      spawn: () => {
        throw new Error("spawn failed");
      }
    }),
    false
  );
});
