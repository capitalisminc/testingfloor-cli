var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/action-core.js
var import_node_path4 = __toESM(require("node:path"), 1);
var import_node_process4 = __toESM(require("node:process"), 1);

// src/action-io.js
var import_node_fs = require("node:fs");
var import_node_process = __toESM(require("node:process"), 1);
function input(env, name) {
  const actionName = `INPUT_${name.replaceAll(" ", "_").toUpperCase()}`;
  const shellName = `INPUT_${name.toUpperCase().replaceAll("-", "_")}`;
  const value = env[actionName] ?? env[shellName];
  return value === void 0 || value === "" ? null : value;
}
function requiredInput(env, name) {
  const value = input(env, name);
  if (!value) {
    throw new Error(`Missing required input: ${name}`);
  }
  return value;
}
function writeOutput(name, value, env) {
  if (value === void 0 || value === null) {
    return;
  }
  if (env.GITHUB_OUTPUT) {
    (0, import_node_fs.appendFileSync)(env.GITHUB_OUTPUT, `${name}=${value}
`);
    return;
  }
  import_node_process.default.stdout.write(`${name}=${value}
`);
}

// src/cli.js
var import_promises3 = require("node:fs/promises");
var import_node_http = __toESM(require("node:http"), 1);
var import_node_https = __toESM(require("node:https"), 1);
var import_node_path3 = __toESM(require("node:path"), 1);
var import_node_process3 = __toESM(require("node:process"), 1);

// src/chunks.js
var import_node_crypto = require("node:crypto");
var import_node_fs2 = require("node:fs");
var import_promises = require("node:fs/promises");
var import_node_path = __toESM(require("node:path"), 1);
var import_node_zlib = require("node:zlib");
var CHUNKING = Object.freeze({
  minSize: 1 << 20,
  maskBits: 21,
  maxSize: 8 << 20,
  packThreshold: 256 << 10,
  packTarget: 4 << 20
});
var GEAR = (() => {
  const table = new Uint32Array(256);
  let x = 2654435769;
  for (let index = 0; index < 256; index += 1) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    table[index] = x;
  }
  return table;
})();
var TYPE_BITS = { file: 32768, directory: 16384, symlink: 40960 };
async function chunkBuildDirectory(root, options = {}) {
  const settings = { ...CHUNKING, ...options };
  const objects = /* @__PURE__ */ new Map();
  const entries = [];
  let pack = null;
  const addObject = (sha256, size, source) => {
    if (!objects.has(sha256)) objects.set(sha256, { size, source });
  };
  const flushPack = () => {
    if (!pack) return;
    const sha256 = pack.hash.digest("hex");
    addObject(sha256, pack.size, { kind: "pack", files: pack.files });
    for (const ref of pack.refs) ref.object = sha256;
    pack = null;
  };
  for (const item of await walk(root)) {
    if (item.type === "directory") {
      entries.push({ type: "directory", path: item.path, mode: TYPE_BITS.directory | item.stat.mode & 511 });
    } else if (item.type === "symlink") {
      const target = (await (0, import_promises.readlink)(item.absolutePath)).split(import_node_path.default.sep).join("/");
      entries.push({ type: "symlink", path: item.path, mode: TYPE_BITS.symlink | 511, target });
    } else if (item.stat.size > 0 && item.stat.size < settings.packThreshold) {
      const bytes = await (0, import_promises.readFile)(item.absolutePath);
      if (pack && pack.size + bytes.length > settings.packTarget) flushPack();
      pack ??= { hash: (0, import_node_crypto.createHash)("sha256"), size: 0, files: [], refs: [] };
      const ref = { object: null, offset: pack.size, size: bytes.length };
      pack.hash.update(bytes);
      pack.files.push(item.absolutePath);
      pack.refs.push(ref);
      pack.size += bytes.length;
      entries.push(fileEntry(item, (0, import_node_zlib.crc32)(bytes), [ref]));
    } else {
      const { fileCrc, chunks } = await chunkFile(item.absolutePath, settings);
      for (const chunk of chunks) {
        addObject(chunk.sha256, chunk.size, {
          kind: "range",
          path: item.absolutePath,
          start: chunk.start,
          end: chunk.start + chunk.size - 1
        });
      }
      entries.push(fileEntry(item, fileCrc, chunks.map((chunk) => ({ object: chunk.sha256, offset: 0, size: chunk.size }))));
    }
  }
  flushPack();
  return { entries, objects };
}
async function readObject(object) {
  if (object.source.kind === "pack") {
    return Buffer.concat(await Promise.all(object.source.files.map((file) => (0, import_promises.readFile)(file))));
  }
  const parts = [];
  for await (const part of (0, import_node_fs2.createReadStream)(object.source.path, { start: object.source.start, end: object.source.end })) {
    parts.push(part);
  }
  return Buffer.concat(parts);
}
function fileEntry(item, fileCrc, chunks) {
  return {
    type: "file",
    path: item.path,
    mode: TYPE_BITS.file | item.stat.mode & 511,
    size: item.stat.size,
    crc32: fileCrc,
    chunks
  };
}
async function chunkFile(filePath, { minSize, maskBits, maxSize }) {
  const mask = 2 ** maskBits - 1;
  const chunks = [];
  let fileCrc = 0;
  let chunkStart = 0;
  let chunkLength = 0;
  let gear = 0;
  let hash = (0, import_node_crypto.createHash)("sha256");
  for await (const buffer of (0, import_node_fs2.createReadStream)(filePath, { highWaterMark: 1 << 20 })) {
    fileCrc = (0, import_node_zlib.crc32)(buffer, fileCrc);
    let segmentStart = 0;
    let index = 0;
    while (index < buffer.length) {
      if (chunkLength < minSize) {
        const skip = Math.min(minSize - chunkLength, buffer.length - index);
        chunkLength += skip;
        index += skip;
        continue;
      }
      gear = (gear << 1) + GEAR[buffer[index]] >>> 0;
      chunkLength += 1;
      index += 1;
      if ((gear & mask) === 0 || chunkLength >= maxSize) {
        hash.update(buffer.subarray(segmentStart, index));
        chunks.push({ sha256: hash.digest("hex"), start: chunkStart, size: chunkLength });
        chunkStart += chunkLength;
        chunkLength = 0;
        gear = 0;
        hash = (0, import_node_crypto.createHash)("sha256");
        segmentStart = index;
      }
    }
    if (segmentStart < buffer.length) hash.update(buffer.subarray(segmentStart));
  }
  if (chunkLength > 0) chunks.push({ sha256: hash.digest("hex"), start: chunkStart, size: chunkLength });
  return { fileCrc, chunks };
}
async function walk(root) {
  const items = [];
  async function visit(directory, relativeDirectory) {
    const names = [];
    for await (const entry of await (0, import_promises.opendir)(directory)) names.push(entry.name);
    names.sort();
    for (const name of names) {
      const absolutePath = import_node_path.default.join(directory, name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const stat2 = await (0, import_promises.lstat)(absolutePath);
      if (stat2.isSymbolicLink()) {
        items.push({ type: "symlink", path: relativePath, absolutePath, stat: stat2 });
      } else if (stat2.isDirectory()) {
        items.push({ type: "directory", path: relativePath, absolutePath, stat: stat2 });
        await visit(absolutePath, relativePath);
      } else if (stat2.isFile()) {
        items.push({ type: "file", path: relativePath, absolutePath, stat: stat2 });
      }
    }
  }
  await visit(root, "");
  return items;
}

// src/credentials.js
var import_promises2 = require("node:fs/promises");
var import_node_os = __toESM(require("node:os"), 1);
var import_node_path2 = __toESM(require("node:path"), 1);
var import_node_process2 = __toESM(require("node:process"), 1);
var CREDENTIALS_FILE = "credentials.json";
function credentialsDirectory(env = import_node_process2.default.env, platform = import_node_process2.default.platform) {
  const paths = platform === "win32" ? import_node_path2.default.win32 : import_node_path2.default.posix;
  if (env.TESTING_FLOOR_CONFIG_DIR) {
    return paths.resolve(env.TESTING_FLOOR_CONFIG_DIR);
  }
  if (platform === "win32") {
    return paths.join(env.APPDATA || paths.join(import_node_os.default.homedir(), "AppData", "Roaming"), "testingfloor");
  }
  return paths.join(env.XDG_CONFIG_HOME || paths.join(import_node_os.default.homedir(), ".config"), "testingfloor");
}
function credentialsPath(env = import_node_process2.default.env, platform = import_node_process2.default.platform) {
  const paths = platform === "win32" ? import_node_path2.default.win32 : import_node_path2.default.posix;
  return paths.join(credentialsDirectory(env, platform), CREDENTIALS_FILE);
}
async function readSavedLogin(env = import_node_process2.default.env) {
  const file = credentialsPath(env);
  let raw;
  try {
    raw = await (0, import_promises2.readFile)(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw new Error(`Couldn't read the saved login at ${file}: ${error.message}`);
  }
  let saved;
  try {
    saved = JSON.parse(raw);
  } catch {
    saved = null;
  }
  if (typeof saved?.token !== "string" || typeof saved?.apiUrl !== "string") {
    throw new Error(`The saved login at ${file} is damaged. Run "testingfloor logout", then "testingfloor login".`);
  }
  return saved;
}

// src/login.js
var MAX_WAIT_MS = 15 * 60 * 1e3;
var REQUEST_TIMEOUT_MS = 30 * 1e3;

// src/cli.js
var DEFAULT_API_URL = "https://api.testingfloor.com";
var DESCRIPTION_MAX_LENGTH = 1e3;
var PLATFORMS = /* @__PURE__ */ new Set(["windows", "macos", "linux"]);
async function resolveUploadPlan(options, env = {}, cwd = import_node_process3.default.cwd()) {
  const configPath = options.config ? import_node_path3.default.resolve(cwd, options.config) : null;
  const config = configPath ? await readJson(configPath) : {};
  const configDir = configPath ? import_node_path3.default.dirname(configPath) : cwd;
  const cliBuildRequested = Boolean(options.platform || options.archive || options.launchPath);
  const configuredBuilds = normalizeConfiguredBuilds(config);
  if (cliBuildRequested && configuredBuilds.length > 0) {
    throw new Error("Use either --config builds or --platform/--build-directory flags, not both.");
  }
  const apiUrl = normalizeApiUrl(
    firstPresent(options.apiUrl, env.TESTING_FLOOR_API_URL, config.apiUrl, DEFAULT_API_URL)
  );
  const token = await resolveToken({ options, env, config, apiUrl });
  const organizationId = firstPresent(
    options.organizationId,
    env.TESTING_FLOOR_ORGANIZATION_ID,
    config.organizationId,
    config.organization_id
  );
  const gameId = firstPresent(options.gameId, env.TESTING_FLOOR_GAME_ID, config.gameId);
  const version = firstPresent(options.version, env.TESTING_FLOOR_VERSION, config.version);
  const description = options.description ?? env.TESTING_FLOOR_DESCRIPTION ?? config.description;
  const gitSha = firstPresent(options.gitSha, env.TESTING_FLOOR_GIT_SHA, env.GITHUB_SHA, config.gitSha);
  const sourceRef = {
    ...githubSourceRef(env),
    ...objectValue(config.sourceRef, "sourceRef"),
    ...parseSourceRefJson(options.sourceRefJson),
    ...parseSourceRefEntries(options.sourceRef ?? [])
  };
  const branch = firstPresent(options.branch, env.TESTING_FLOOR_BRANCH, config.branch);
  const rawBuilds = cliBuildRequested ? [buildFromOptions(options)] : configuredBuilds;
  const builds = rawBuilds.map(
    (build) => normalizeBuild(build, {
      configDir,
      cwd,
      commonVersion: version,
      commonDescription: description,
      commonGitSha: gitSha,
      commonSourceRef: sourceRef,
      commonBranch: branch
    })
  );
  validatePlan({ organizationId, gameId, builds });
  return {
    apiUrl,
    token,
    organizationId: String(organizationId),
    gameId: String(gameId),
    builds
  };
}
function normalizeConfiguredBuilds(config) {
  if (Array.isArray(config.builds)) {
    return config.builds;
  }
  if (config.platforms && typeof config.platforms === "object" && !Array.isArray(config.platforms)) {
    return Object.entries(config.platforms).map(([platform, build]) => ({ platform, ...build }));
  }
  return [];
}
function parseSourceRefEntries(entries) {
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
async function uploadBuild(plan, build, { log = console.error, pollIntervalMs, retryDelaysMs = REQUEST_RETRY_DELAYS_MS } = {}) {
  const source = await pathInfo(build.buildDirectory, { allowDirectory: true, label: "Build directory" });
  if (!(await (0, import_promises3.stat)(build.buildDirectory)).isDirectory()) {
    throw new Error(`Build directory must be a folder, not a file: ${build.buildDirectory}`);
  }
  const created = await postJson(gameApiUrl(plan, "/builds"), plan.token, {
    platform: build.platform,
    branch: build.branch,
    version: build.version,
    description: build.description,
    git_sha: build.gitSha,
    archive_kind: "chunks",
    filename: build.filename,
    byte_size: source.size,
    launch_path: build.launchPath,
    launch_args: build.launchArgs,
    working_directory: build.workingDirectory,
    source_ref: build.sourceRef
  });
  const manifest = await uploadChunkManifest(plan, created.id, build.buildDirectory, { log, pollIntervalMs, retryDelaysMs });
  log(`Completing build ${created.id}`);
  const completed = await postJson(`${plan.apiUrl}/api/game_builds/${created.id}/complete`, plan.token, {});
  return {
    buildId: completed.id ?? created.id,
    platform: build.platform,
    version: build.version,
    gitSha: build.gitSha,
    filename: build.filename,
    checksumSha256: null,
    sizeBytes: source.size,
    status: completed.status ?? "ready",
    readyAt: completed.ready_at,
    zipSizeBytes: manifest.zip_size_bytes ?? null
  };
}
var CHUNK_ANNOUNCE_BATCH = 1e3;
var CHUNK_UPLOAD_CONCURRENCY = 8;
var MANIFEST_VERIFY_TIMEOUT_MS = 45 * 60 * 1e3;
async function uploadChunkManifest(plan, buildId, buildDirectory, { log, pollIntervalMs = 5e3, retryDelaysMs }) {
  log(`Splitting ${buildDirectory} into chunks for zip downloads and recorder installs`);
  const { entries, objects } = await chunkBuildDirectory(buildDirectory);
  const objectList = [...objects.entries()];
  const totalBytes = objectList.reduce((sum, [, object]) => sum + object.size, 0);
  log(`${entries.length} entries in ${objectList.length} chunks (${formatBytes(totalBytes)})`);
  const missing = [];
  for (let index = 0; index < objectList.length; index += CHUNK_ANNOUNCE_BATCH) {
    const batch = objectList.slice(index, index + CHUNK_ANNOUNCE_BATCH);
    const response = await postJson(`${plan.apiUrl}/api/game_builds/${buildId}/chunks`, plan.token, {
      chunks: batch.map(([sha256, object]) => ({ sha256, byte_size: object.size }))
    }, { retryDelaysMs });
    missing.push(...response.missing ?? []);
  }
  const missingBytes = missing.reduce((sum, chunk) => sum + objects.get(chunk.sha256).size, 0);
  log(`Uploading ${missing.length} new chunks (${formatBytes(missingBytes)}); the other ${objectList.length - missing.length} are already stored`);
  await mapWithConcurrency(
    missing,
    CHUNK_UPLOAD_CONCURRENCY,
    (chunk) => withRetries(`Chunk ${chunk.sha256}`, async () => {
      const object = objects.get(chunk.sha256);
      await uploadBuffer(chunk.upload_url, chunk.upload_headers ?? {}, await readObject(object), { label: `Chunk ${chunk.sha256}` });
    })
  );
  await postJson(`${plan.apiUrl}/api/game_builds/${buildId}/manifest`, plan.token, {
    manifest: { modified_at: (/* @__PURE__ */ new Date()).toISOString(), entries }
  }, { retryDelaysMs });
  log("Waiting for Testing Floor to verify the chunks");
  const deadline = Date.now() + MANIFEST_VERIFY_TIMEOUT_MS;
  for (; ; ) {
    let status = null;
    try {
      status = await getJson(`${plan.apiUrl}/api/game_builds/${buildId}/manifest`, plan.token, { retryDelaysMs });
    } catch (error) {
      if (!(error instanceof TransientRequestError) || Date.now() > deadline) {
        throw error;
      }
      log(`Couldn't check verification just now (${error.message}); still waiting`);
    }
    if (status?.status === "verified") {
      log(`Zip download ready (${formatBytes(status.zip_size_bytes ?? 0)})`);
      return status;
    }
    if (status?.status === "failed") {
      throw new Error(`Testing Floor rejected build ${buildId}'s chunks: ${status.error}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for Testing Floor to verify build ${buildId}'s chunks`);
    }
    await sleep(pollIntervalMs);
  }
}
async function mapWithConcurrency(items, limit, worker) {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await worker(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}
async function withRetries(label, attempt, { attempts = 3 } = {}) {
  for (let tries = 1; ; tries += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (tries >= attempts) {
        throw new Error(`${label} failed after ${attempts} attempts: ${error.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * tries));
    }
  }
}
function uploadBuffer(uploadUrl, uploadHeaders, body, { label = "Upload" } = {}) {
  const url = new URL(uploadUrl);
  const client = url.protocol === "https:" ? import_node_https.default : import_node_http.default;
  const headers = compactHeaders({ ...uploadHeaders, "Content-Length": String(body.length) });
  return new Promise((resolve, reject) => {
    const request = client.request(url, { method: "PUT", headers }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (part) => {
        text += part;
      });
      response.on("end", () => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`${label} failed with ${response.statusCode}: ${text}`));
        }
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}
async function readJson(filePath) {
  const raw = await (0, import_promises3.readFile)(filePath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Could not parse ${filePath}: ${error.message}`);
  }
}
function buildFromOptions(options) {
  return {
    buildDirectory: options.buildDirectory ?? options.archive,
    branch: options.branch,
    description: options.description,
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
function normalizeBuild(build, { configDir, cwd, commonVersion, commonDescription, commonGitSha, commonSourceRef, commonBranch }) {
  const directory = build.buildDirectory ?? build.build_directory ?? build.archive ?? build.path;
  return {
    buildDirectory: directory ? resolveBuildPath(directory, build.fromConfig === false ? cwd : configDir) : null,
    branch: build.branch ?? commonBranch ?? void 0,
    description: build.description ?? commonDescription,
    filename: build.filename ?? defaultBuildFilename(directory),
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
function defaultBuildFilename(directory) {
  if (!directory) {
    return null;
  }
  const name = import_node_path3.default.basename(directory);
  return import_node_path3.default.extname(name).toLowerCase() === ".zip" ? name : `${name}.zip`;
}
function normalizeLaunchArgs(value) {
  if (value === void 0 || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("launchArgs must be an array.");
  }
  return value.map(String);
}
function validatePlan(plan) {
  if (!plan.organizationId) {
    throw new Error(
      "Missing organization id. Set organizationId in config, TESTING_FLOOR_ORGANIZATION_ID, or pass --organization-id."
    );
  }
  if (!plan.gameId || !/^[A-Za-z0-9_-]+$/.test(String(plan.gameId))) {
    throw new Error('Missing game id. Set gameId in config or pass --game-id. Accepts numeric id or game key (e.g. "crux").');
  }
  if (plan.builds.length === 0) {
    throw new Error("No builds configured. Pass --platform/--build-directory or provide config builds.");
  }
  for (const build of plan.builds) {
    if (!PLATFORMS.has(build.platform)) {
      throw new Error(`Invalid platform "${build.platform}". Expected windows, macos, or linux.`);
    }
    if (!build.buildDirectory) {
      throw new Error(`Missing build directory for ${build.platform}.`);
    }
    if (!build.version) {
      throw new Error(`Missing version for ${build.platform}.`);
    }
    if (build.description !== void 0 && (typeof build.description !== "string" || Array.from(build.description).length > DESCRIPTION_MAX_LENGTH)) {
      throw new Error(`Build description must be text of at most ${DESCRIPTION_MAX_LENGTH} characters.`);
    }
    if (!build.launchPath) {
      throw new Error(`Missing launchPath for ${build.platform}.`);
    }
  }
}
async function pathInfo(filePath, { allowDirectory, label }) {
  let stats;
  try {
    await (0, import_promises3.access)(filePath);
    stats = await (0, import_promises3.stat)(filePath);
  } catch {
    throw new Error(`${label} not found: ${filePath}`);
  }
  if (stats.isDirectory()) {
    if (!allowDirectory) {
      throw new Error(`${label} must be a file: ${filePath}`);
    }
    const size = await directorySize(filePath);
    if (size <= 0) {
      throw new Error(`${label} directory is empty: ${filePath}`);
    }
    return { ...stats, size };
  }
  if (!stats.isFile()) {
    throw new Error(`${label} must be a file${allowDirectory ? " or directory" : ""}: ${filePath}`);
  }
  if (stats.size <= 0) {
    throw new Error(`${label} is empty: ${filePath}`);
  }
  return stats;
}
async function directorySize(dir) {
  let total = 0;
  const handle = await (0, import_promises3.opendir)(dir);
  for await (const entry of handle) {
    const fullPath = import_node_path3.default.join(dir, entry.name);
    const entryStats = await (0, import_promises3.stat)(fullPath);
    if (entryStats.isDirectory()) {
      total += await directorySize(fullPath);
    } else if (entryStats.isFile()) {
      total += entryStats.size;
    }
  }
  return total;
}
var REQUEST_RETRY_DELAYS_MS = [1e3, 2e3, 4e3, 8e3];
var RETRYABLE_STATUSES = /* @__PURE__ */ new Set([408, 429]);
var TransientRequestError = class extends Error {
};
async function postJson(url, token, body, { retryDelaysMs = [] } = {}) {
  return withRequestRetries(
    retryDelaysMs,
    () => requestJson(url, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(compact(body))
    })
  );
}
async function getJson(url, token, { retryDelaysMs = REQUEST_RETRY_DELAYS_MS } = {}) {
  return withRequestRetries(retryDelaysMs, () => requestJson(url, token, { method: "GET" }));
}
async function requestJson(url, token, { method, headers = {}, body }) {
  let response;
  let text;
  try {
    response = await fetch(url, { method, headers: { "Authorization": `Bearer ${token}`, ...headers }, body });
    text = await response.text();
  } catch (error) {
    throw new TransientRequestError(`couldn't reach ${url}: ${error.cause?.code ?? error.cause?.message ?? error.message}`);
  }
  if (!response.ok) {
    const message = jsonError(text) || `${response.status} ${response.statusText} from ${url}`;
    const transient = response.status >= 500 || RETRYABLE_STATUSES.has(response.status);
    throw transient ? new TransientRequestError(message) : new Error(message);
  }
  return text ? parseJsonResponse(text, url) : {};
}
async function withRequestRetries(delaysMs, send) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await send();
    } catch (error) {
      if (!(error instanceof TransientRequestError) || attempt >= delaysMs.length) {
        throw error;
      }
      await sleep(delaysMs[attempt]);
    }
  }
}
function jsonError(text) {
  try {
    return JSON.parse(text)?.error;
  } catch {
    return null;
  }
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function compactHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).filter(([, value]) => value !== void 0 && value !== null && value !== "")
  );
}
function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== void 0));
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
  if (value === void 0 || value === null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value;
}
function resolveBuildPath(filePath, baseDir) {
  return import_node_path3.default.isAbsolute(filePath) ? filePath : import_node_path3.default.resolve(baseDir, filePath);
}
async function resolveToken({ options, env, config, apiUrl }) {
  const token = firstPresent(options.token, env.TESTING_FLOOR_API_TOKEN, config.token);
  if (token) {
    return token;
  }
  const saved = await readSavedLogin(env);
  if (saved?.apiUrl === apiUrl) {
    return saved.token;
  }
  if (saved) {
    throw new Error(
      `Missing API token for ${apiUrl}. You're signed in to ${saved.apiUrl}; run "testingfloor login --api-url ${apiUrl}" to sign in there, set TESTING_FLOOR_API_TOKEN, or pass --token.`
    );
  }
  throw new Error('Missing API token. Run "testingfloor login", set TESTING_FLOOR_API_TOKEN, or pass --token.');
}
function normalizeApiUrl(raw) {
  const url = new URL(raw);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}
function gameApiUrl(plan, suffix) {
  const organizationId = encodeURIComponent(plan.organizationId);
  const gameId = encodeURIComponent(plan.gameId);
  return `${plan.apiUrl}/api/organizations/${organizationId}/games/${gameId}${suffix}`;
}
function firstPresent(...values) {
  return values.find((value) => value !== void 0 && value !== null && value !== "");
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

// src/action-core.js
async function runAction(env = import_node_process4.default.env, cwd = import_node_process4.default.cwd()) {
  const inputs = readInputs(env);
  const build = resolveActionBuild(inputs, cwd, env);
  const plan = await resolveUploadPlan(
    {
      apiUrl: inputs.apiUrl,
      buildDirectory: build.buildDirectory,
      branch: inputs.branch,
      description: inputs.description,
      filename: build.filename,
      gameId: inputs.gameId,
      gitSha: inputs.gitSha,
      launchArg: build.launchArgs,
      launchPath: build.launchPath,
      organizationId: inputs.organizationId,
      platform: build.platform,
      sourceRefJson: JSON.stringify(inputs.sourceRef),
      token: inputs.apiToken,
      version: inputs.version,
      workingDirectory: inputs.workingDirectory
    },
    env,
    cwd
  );
  const result = await uploadBuild(plan, plan.builds[0]);
  writeOutput("build-id", result.buildId, env);
  writeOutput("status", result.status, env);
  writeOutput("ready-at", result.readyAt, env);
  writeOutput("checksum-sha256", result.checksumSha256, env);
  writeOutput("size-bytes", result.sizeBytes, env);
}
function readInputs(env) {
  if (input(env, "archive")) {
    throw new Error("The archive input was removed. Set build-directory to the unzipped build folder.");
  }
  return {
    apiToken: requiredInput(env, "api-token"),
    apiUrl: input(env, "api-url") || "https://api.testingfloor.com",
    branch: input(env, "branch") || void 0,
    buildDirectory: requiredInput(env, "build-directory"),
    description: input(env, "description") ?? void 0,
    filename: input(env, "filename"),
    gameId: requiredInput(env, "game-id"),
    gitSha: input(env, "git-sha"),
    launchArgs: parseJsonInput(input(env, "launch-args") || "[]", "launch-args"),
    launchPath: requiredInput(env, "launch-path"),
    organizationId: input(env, "organization-id") || void 0,
    platform: requiredInput(env, "platform"),
    sourceRef: parseJsonInput(input(env, "source-ref") || "{}", "source-ref"),
    version: requiredInput(env, "version"),
    workingDirectory: input(env, "working-directory") || "."
  };
}
function resolveActionBuild(inputs, cwd = import_node_process4.default.cwd(), env = import_node_process4.default.env) {
  if (!inputs.buildDirectory) {
    throw new Error("Set build-directory.");
  }
  return {
    buildDirectory: import_node_path4.default.resolve(cwd, inputs.buildDirectory),
    filename: inputs.filename || defaultArchiveName({ env, inputs }),
    launchArgs: inputs.launchArgs,
    launchPath: inputs.launchPath,
    platform: inputs.platform
  };
}
function parseJsonInput(raw, name) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${name} must be valid JSON: ${error.message}`);
  }
  if (name === "launch-args" && !Array.isArray(parsed)) {
    throw new Error("launch-args must be a JSON array.");
  }
  if (name === "source-ref" && (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))) {
    throw new Error("source-ref must be a JSON object.");
  }
  return parsed;
}
function defaultArchiveName({ env, inputs }) {
  const version = inputs.version || env.GITHUB_SHA || "build";
  return `build-${inputs.platform}-${version}.zip`;
}

// src/action.js
runAction().catch((error) => {
  console.error(`::error::${escapeCommand(error.message)}`);
  process.exitCode = 1;
});
function escapeCommand(value) {
  return String(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}
