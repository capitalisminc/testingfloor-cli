import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import process from "node:process";

const DEFAULT_API_URL = "https://testingfloor.com";
const PLATFORMS = new Set(["windows", "macos", "linux"]);
const ARRAY_OPTIONS = new Set(["launch-arg", "source-ref"]);
const VALUE_OPTIONS = new Set([
  "api-url",
  "archive",
  "archive-kind",
  "config",
  "filename",
  "game-id",
  "git-sha",
  "launch-path",
  "platform",
  "source-ref-json",
  "token",
  "version",
  "working-directory"
]);

export async function main(argv = process.argv.slice(2), env = process.env, cwd = process.cwd()) {
  const parsed = parseArgs(argv);

  if (parsed.help || parsed.command === "help" || !parsed.command) {
    process.stdout.write(helpText());
    return;
  }

  if (!["upload-build", "upload"].includes(parsed.command)) {
    throw new Error(`Unknown command "${parsed.command}". Run "testingfloor help".`);
  }

  const plan = await resolveUploadPlan(parsed.options, env, cwd);

  if (parsed.options.json) {
    const results = [];
    for (const build of plan.builds) {
      results.push(await uploadBuild(plan, build, { log: () => {} }));
    }
    process.stdout.write(`${JSON.stringify({ builds: results }, null, 2)}\n`);
    return;
  }

  const results = [];
  for (const build of plan.builds) {
    results.push(await uploadBuild(plan, build, { log: console.error }));
  }

  process.stdout.write(`${JSON.stringify({ builds: results }, null, 2)}\n`);
}

export function parseArgs(argv) {
  const result = { command: null, help: false, options: {} };
  const args = [...argv];

  if (args[0] && !args[0].startsWith("-")) {
    result.command = args.shift();
  }

  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index];

    if (raw === "--help" || raw === "-h") {
      result.help = true;
      continue;
    }

    if (raw === "--json") {
      result.options.json = true;
      continue;
    }

    if (raw === "-c") {
      result.options.config = takeValue(args, ++index, raw);
      continue;
    }

    if (!raw.startsWith("--")) {
      throw new Error(`Unexpected positional argument "${raw}".`);
    }

    const [name, inlineValue] = raw.slice(2).split(/=(.*)/s, 2);
    if (ARRAY_OPTIONS.has(name)) {
      const value = inlineValue ?? takeValue(args, ++index, raw);
      result.options[toCamel(name)] ||= [];
      result.options[toCamel(name)].push(value);
      continue;
    }

    if (VALUE_OPTIONS.has(name)) {
      result.options[toCamel(name)] = inlineValue ?? takeValue(args, ++index, raw);
      continue;
    }

    throw new Error(`Unknown option "--${name}".`);
  }

  return result;
}

export async function resolveUploadPlan(options, env = {}, cwd = process.cwd()) {
  const configPath = options.config ? path.resolve(cwd, options.config) : null;
  const config = configPath ? await readJson(configPath) : {};
  const configDir = configPath ? path.dirname(configPath) : cwd;

  const cliBuildRequested = Boolean(options.platform || options.archive || options.launchPath);
  const configuredBuilds = normalizeConfiguredBuilds(config);
  if (cliBuildRequested && configuredBuilds.length > 0) {
    throw new Error("Use either --config builds or --platform/--archive flags, not both.");
  }

  const apiUrl = normalizeApiUrl(
    firstPresent(options.apiUrl, env.TESTING_FLOOR_API_URL, config.apiUrl, DEFAULT_API_URL)
  );
  const token = firstPresent(options.token, env.TESTING_FLOOR_API_TOKEN, config.token);
  const gameId = firstPresent(options.gameId, env.TESTING_FLOOR_GAME_ID, config.gameId);
  const version = firstPresent(options.version, env.TESTING_FLOOR_VERSION, config.version);
  const gitSha = firstPresent(options.gitSha, env.TESTING_FLOOR_GIT_SHA, env.GITHUB_SHA, config.gitSha);
  const sourceRef = {
    ...githubSourceRef(env),
    ...objectValue(config.sourceRef, "sourceRef"),
    ...parseSourceRefJson(options.sourceRefJson),
    ...parseSourceRefEntries(options.sourceRef ?? [])
  };

  const rawBuilds = cliBuildRequested ? [buildFromOptions(options)] : configuredBuilds;
  const builds = rawBuilds.map((build) =>
    normalizeBuild(build, {
      configDir,
      cwd,
      commonVersion: version,
      commonGitSha: gitSha,
      commonSourceRef: sourceRef
    })
  );

  validatePlan({ apiUrl, token, gameId, builds });

  return {
    apiUrl,
    token,
    gameId: String(gameId),
    builds
  };
}

export function normalizeConfiguredBuilds(config) {
  if (Array.isArray(config.builds)) {
    return config.builds;
  }

  if (config.platforms && typeof config.platforms === "object" && !Array.isArray(config.platforms)) {
    return Object.entries(config.platforms).map(([platform, build]) => ({ platform, ...build }));
  }

  return [];
}

export function parseSourceRefEntries(entries) {
  return entries.reduce((sourceRef, entry) => {
    const separator = entry.indexOf("=");
    if (separator === -1) {
      throw new Error(`Source ref "${entry}" must be key=value.`);
    }

    const key = entry.slice(0, separator).trim();
    if (!key) {
      throw new Error("Source ref keys cannot be blank.");
    }

    sourceRef[key] = entry.slice(separator + 1);
    return sourceRef;
  }, {});
}

export async function uploadBuild(plan, build, { log = console.error } = {}) {
  const file = await fileInfo(build.archivePath);
  log(`Creating ${build.platform} build from ${build.archivePath}`);
  const hashes = await hashFile(build.archivePath);

  const createResponse = await postJson(`${plan.apiUrl}/api/games/${plan.gameId}/builds`, plan.token, {
    platform: build.platform,
    version: build.version,
    git_sha: build.gitSha,
    archive_kind: build.archiveKind,
    filename: build.filename,
    byte_size: file.size,
    checksum_md5: hashes.md5Base64,
    checksum_sha256: hashes.sha256Hex,
    launch_path: build.launchPath,
    launch_args: build.launchArgs,
    working_directory: build.workingDirectory,
    source_ref: build.sourceRef
  });

  log(`Uploading ${build.filename} (${formatBytes(file.size)}) to build ${createResponse.id}`);
  await uploadFile(createResponse.upload_url, createResponse.upload_headers ?? {}, build.archivePath, file.size);

  log(`Completing build ${createResponse.id}`);
  const completeResponse = await postJson(
    `${plan.apiUrl}/api/game_builds/${createResponse.id}/complete`,
    plan.token,
    { signed_id: createResponse.signed_id }
  );

  return {
    buildId: completeResponse.id ?? createResponse.id,
    platform: build.platform,
    version: build.version,
    gitSha: build.gitSha,
    filename: build.filename,
    checksumSha256: hashes.sha256Hex,
    sizeBytes: file.size,
    status: completeResponse.status ?? "ready",
    readyAt: completeResponse.ready_at
  };
}

async function readJson(filePath) {
  const raw = await readFile(filePath, "utf8");

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Could not parse ${filePath}: ${error.message}`);
  }
}

function buildFromOptions(options) {
  return {
    archive: options.archive,
    archiveKind: options.archiveKind,
    filename: options.filename,
    gitSha: options.gitSha,
    launchArgs: options.launchArg,
    launchPath: options.launchPath,
    platform: options.platform,
    sourceRef: parseSourceRefEntries(options.sourceRef ?? []),
    version: options.version,
    workingDirectory: options.workingDirectory
  };
}

function normalizeBuild(build, { configDir, cwd, commonVersion, commonGitSha, commonSourceRef }) {
  const archive = build.archive ?? build.path;

  return {
    archivePath: archive ? resolveBuildPath(archive, build.fromConfig === false ? cwd : configDir) : null,
    archiveKind: build.archiveKind ?? build.archive_kind ?? "zip",
    filename: build.filename ?? (archive ? path.basename(archive) : null),
    gitSha: build.gitSha ?? build.git_sha ?? commonGitSha,
    launchArgs: normalizeLaunchArgs(build.launchArgs ?? build.launch_args),
    launchPath: build.launchPath ?? build.launch_path,
    platform: build.platform,
    sourceRef: {
      ...commonSourceRef,
      ...objectValue(build.sourceRef ?? build.source_ref, "build.sourceRef")
    },
    version: build.version ?? commonVersion,
    workingDirectory: build.workingDirectory ?? build.working_directory ?? "."
  };
}

function normalizeLaunchArgs(value) {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error("launchArgs must be an array.");
  }

  return value.map(String);
}

function validatePlan(plan) {
  if (!plan.token) {
    throw new Error("Missing API token. Set TESTING_FLOOR_API_TOKEN or pass --token.");
  }

  if (!plan.gameId || !/^\d+$/.test(String(plan.gameId))) {
    throw new Error("Missing numeric game id. Set gameId in config or pass --game-id.");
  }

  if (plan.builds.length === 0) {
    throw new Error("No builds configured. Pass --platform/--archive or provide config builds.");
  }

  for (const build of plan.builds) {
    if (!PLATFORMS.has(build.platform)) {
      throw new Error(`Invalid platform "${build.platform}". Expected windows, macos, or linux.`);
    }

    if (build.archiveKind !== "zip") {
      throw new Error(`Unsupported archive kind "${build.archiveKind}". Only zip is supported.`);
    }

    if (!build.archivePath) {
      throw new Error(`Missing archive path for ${build.platform}.`);
    }

    if (!build.version) {
      throw new Error(`Missing version for ${build.platform}.`);
    }

    if (!build.launchPath) {
      throw new Error(`Missing launchPath for ${build.platform}.`);
    }
  }
}

async function fileInfo(filePath) {
  let stats;
  try {
    await access(filePath);
    stats = await stat(filePath);
  } catch {
    throw new Error(`Archive not found: ${filePath}`);
  }

  if (!stats.isFile()) {
    throw new Error(`Archive must be a file: ${filePath}`);
  }

  if (stats.size <= 0) {
    throw new Error(`Archive is empty: ${filePath}`);
  }

  return stats;
}

async function hashFile(filePath) {
  const md5 = createHash("md5");
  const sha256 = createHash("sha256");

  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => {
      md5.update(chunk);
      sha256.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", resolve);
  });

  return {
    md5Base64: md5.digest("base64"),
    sha256Hex: sha256.digest("hex")
  };
}

async function postJson(url, token, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(compact(body))
  });

  const text = await response.text();
  const parsed = text ? parseJsonResponse(text, url) : {};
  if (!response.ok) {
    throw new Error(parsed.error || `${response.status} ${response.statusText} from ${url}`);
  }

  return parsed;
}

function uploadFile(uploadUrl, uploadHeaders, filePath, size) {
  const url = new URL(uploadUrl);
  const client = url.protocol === "https:" ? https : http;
  const headers = { ...uploadHeaders, "Content-Length": size };

  return new Promise((resolve, reject) => {
    const request = client.request(url, { method: "PUT", headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`Direct upload failed with ${response.statusCode}: ${body}`));
        }
      });
    });

    request.on("error", reject);
    createReadStream(filePath).on("error", reject).pipe(request);
  });
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function parseJsonResponse(text, url) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON response from ${url}, got: ${text.slice(0, 160)}`);
  }
}

function parseSourceRefJson(raw) {
  if (!raw) {
    return {};
  }

  try {
    return objectValue(JSON.parse(raw), "source-ref-json");
  } catch (error) {
    throw new Error(`Could not parse --source-ref-json: ${error.message}`);
  }
}

function githubSourceRef(env) {
  if (env.GITHUB_ACTIONS !== "true") {
    return {};
  }

  return compact({
    provider: "github_actions",
    repository: env.GITHUB_REPOSITORY,
    ref: env.GITHUB_REF,
    ref_name: env.GITHUB_REF_NAME,
    run_id: env.GITHUB_RUN_ID,
    run_number: env.GITHUB_RUN_NUMBER,
    sha: env.GITHUB_SHA
  });
}

function objectValue(value, name) {
  if (value === undefined || value === null) {
    return {};
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }

  return value;
}

function resolveBuildPath(filePath, baseDir) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath);
}

function normalizeApiUrl(raw) {
  const url = new URL(raw);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function takeValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}.`);
  }

  return value;
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function helpText() {
  return `Testing Floor CLI

Usage:
  testingfloor upload-build --game-id 42 --platform windows --archive ./game-windows.zip --version 0.4.12 --launch-path Game.exe
  testingfloor upload-build --config testingfloor-builds.json

Environment:
  TESTING_FLOOR_API_TOKEN   API key with builds:create scope
  TESTING_FLOOR_API_URL     Defaults to ${DEFAULT_API_URL}
  TESTING_FLOOR_GAME_ID     Numeric game id
  TESTING_FLOOR_VERSION     Build version metadata
  TESTING_FLOOR_GIT_SHA     Git SHA metadata

Options:
  --api-url <url>           Testing Floor base URL
  --token <token>           API token
  --game-id <id>            Numeric Testing Floor game id
  --platform <platform>     windows, macos, or linux
  --archive <path>          Zip file to upload
  --version <version>       Version metadata
  --git-sha <sha>           Git SHA metadata
  --launch-path <path>      Executable path inside the extracted archive
  --launch-arg <arg>        Launch argument, repeatable
  --working-directory <dir> Working directory inside the extracted archive, defaults to "."
  --source-ref <key=value>  Source metadata, repeatable
  --source-ref-json <json>  Source metadata object
  --config, -c <path>       JSON config with builds or platforms
  --json                    Print only JSON results
`;
}
