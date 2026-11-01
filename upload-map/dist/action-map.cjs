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

// src/action-map.js
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
var import_node_crypto = require("node:crypto");
var import_node_fs2 = require("node:fs");
var import_promises2 = require("node:fs/promises");
var import_node_http = __toESM(require("node:http"), 1);
var import_node_https = __toESM(require("node:https"), 1);
var import_node_path2 = __toESM(require("node:path"), 1);
var import_node_process3 = __toESM(require("node:process"), 1);

// src/chunks.js
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

// src/credentials.js
var import_promises = require("node:fs/promises");
var import_node_os = __toESM(require("node:os"), 1);
var import_node_path = __toESM(require("node:path"), 1);
var import_node_process2 = __toESM(require("node:process"), 1);
var CREDENTIALS_FILE = "credentials.json";
function credentialsDirectory(env = import_node_process2.default.env, platform = import_node_process2.default.platform) {
  const paths = platform === "win32" ? import_node_path.default.win32 : import_node_path.default.posix;
  if (env.TESTING_FLOOR_CONFIG_DIR) {
    return paths.resolve(env.TESTING_FLOOR_CONFIG_DIR);
  }
  if (platform === "win32") {
    return paths.join(env.APPDATA || paths.join(import_node_os.default.homedir(), "AppData", "Roaming"), "testingfloor");
  }
  return paths.join(env.XDG_CONFIG_HOME || paths.join(import_node_os.default.homedir(), ".config"), "testingfloor");
}
function credentialsPath(env = import_node_process2.default.env, platform = import_node_process2.default.platform) {
  const paths = platform === "win32" ? import_node_path.default.win32 : import_node_path.default.posix;
  return paths.join(credentialsDirectory(env, platform), CREDENTIALS_FILE);
}
async function readSavedLogin(env = import_node_process2.default.env) {
  const file = credentialsPath(env);
  let raw;
  try {
    raw = await (0, import_promises.readFile)(file, "utf8");
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
var AXES = /* @__PURE__ */ new Set(["x", "y", "z"]);
var IMAGE_MIME_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};
async function resolveMapPlan(options, env = {}, cwd = import_node_process3.default.cwd()) {
  const configPath = options.config ? import_node_path2.default.resolve(cwd, options.config) : null;
  const config = configPath ? await readJson(configPath) : {};
  const configDir = configPath ? import_node_path2.default.dirname(configPath) : cwd;
  const cliMapRequested = Boolean(
    options.levelId || options.image || options.bounds || options.horizontalAxis || options.verticalAxis || options.variant || options.variantKey || options.defaultVariant || options.worldUnitsPerMeter
  );
  const configuredMaps = Array.isArray(config.maps) ? config.maps : [];
  if (cliMapRequested && configuredMaps.length > 0) {
    throw new Error("Use either --config maps or --level-id/--image flags, not both.");
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
  const appVersion = firstPresent(
    options.appVersion,
    env.TESTING_FLOOR_VERSION,
    config.appVersion,
    config.version
  );
  const mapVersion = firstPresent(
    options.mapVersion,
    env.TESTING_FLOOR_MAP_VERSION,
    config.mapVersion,
    config.map_version
  );
  const rawMaps = cliMapRequested ? [mapFromOptions(options)] : configuredMaps;
  const maps = rawMaps.map(
    (map) => normalizeMap(map, { configDir, cwd, commonAppVersion: appVersion, commonMapVersion: mapVersion })
  );
  validateMapPlan({ organizationId, gameId, maps });
  return {
    apiUrl,
    token,
    organizationId: String(organizationId),
    gameId: String(gameId),
    maps
  };
}
function parseBoundsString(raw) {
  if (raw === void 0 || raw === null || raw === "") {
    return null;
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const centerX2 = numericValue(raw.centerX ?? raw.center_x, "bounds.centerX");
    const centerZ2 = numericValue(raw.centerZ ?? raw.center_z, "bounds.centerZ");
    const sizeX2 = numericValue(raw.sizeX ?? raw.size_x, "bounds.sizeX");
    const sizeZ2 = numericValue(raw.sizeZ ?? raw.size_z, "bounds.sizeZ");
    return validateBounds({ centerX: centerX2, centerZ: centerZ2, sizeX: sizeX2, sizeZ: sizeZ2 });
  }
  if (typeof raw !== "string") {
    throw new Error('bounds must be a string "cx,cz,sx,sz" or an object.');
  }
  const parts = raw.split(",").map((piece) => piece.trim());
  if (parts.length !== 4) {
    throw new Error("bounds must be four comma-separated numbers: center_x,center_z,size_x,size_z.");
  }
  const [centerX, centerZ, sizeX, sizeZ] = parts.map(
    (piece, index) => numericValue(piece, ["bounds.centerX", "bounds.centerZ", "bounds.sizeX", "bounds.sizeZ"][index])
  );
  return validateBounds({ centerX, centerZ, sizeX, sizeZ });
}
async function uploadMap(plan, map, { log = console.error } = {}) {
  log(`Uploading map ${map.levelId} from ${map.imagePath}`);
  const image = await pathInfo(map.imagePath, { allowDirectory: false, label: "Map image" });
  const hashes = await hashFile(map.imagePath);
  const directUploadResponse = await postJson(gameApiUrl(plan, "/maps/direct_uploads"), plan.token, {
    filename: map.imageFilename,
    byte_size: image.size,
    checksum: hashes.md5Base64,
    content_type: map.imageMimeType
  });
  const imageUpload = directUploadResponse.image;
  if (!imageUpload?.signed_id) {
    throw new Error("Map direct upload response is missing image.signed_id.");
  }
  if (!imageUpload.upload_url) {
    throw new Error("Map direct upload response is missing image.upload_url.");
  }
  await uploadFile(imageUpload.upload_url, imageUpload.upload_headers ?? {}, map.imagePath, image.size, {
    label: "Map image direct upload"
  });
  const response = await postJson(gameApiUrl(plan, "/maps"), plan.token, {
    level_id: map.levelId,
    bounds: {
      center_x: map.bounds.centerX,
      center_z: map.bounds.centerZ,
      size_x: map.bounds.sizeX,
      size_z: map.bounds.sizeZ
    },
    map_horizontal_axis: map.horizontalAxis,
    map_vertical_axis: map.verticalAxis,
    app_version: map.appVersion || void 0,
    variant_key: map.variantKey || void 0,
    version: map.version || void 0,
    default_variant: map.defaultVariant === null || map.defaultVariant === void 0 ? void 0 : map.defaultVariant,
    world_units_per_meter: map.worldUnitsPerMeter ?? void 0,
    image_signed_id: imageUpload.signed_id
  });
  return {
    id: response.id,
    levelId: response.level_id ?? map.levelId,
    version: response.version ?? map.version ?? null,
    pinned: response.pinned ?? null,
    appVersion: response.app_version ?? map.appVersion ?? null,
    variantKey: response.variant_key ?? map.variantKey ?? null,
    variantLabel: response.variant_label ?? null,
    defaultVariant: response.default_variant ?? map.defaultVariant ?? null,
    bounds: response.bounds ?? null,
    horizontalAxis: response.map_horizontal_axis ?? map.horizontalAxis,
    verticalAxis: response.map_vertical_axis ?? map.verticalAxis,
    worldUnitsPerMeter: response.world_units_per_meter ?? map.worldUnitsPerMeter ?? null,
    configured: response.configured ?? null,
    created: response.created ?? null
  };
}
function mapFromOptions(options) {
  return {
    levelId: options.levelId,
    image: options.image,
    bounds: options.bounds,
    horizontalAxis: options.horizontalAxis,
    verticalAxis: options.verticalAxis,
    appVersion: options.appVersion,
    variantKey: options.variantKey ?? options.variant,
    mapVersion: options.mapVersion,
    defaultVariant: options.defaultVariant,
    worldUnitsPerMeter: options.worldUnitsPerMeter
  };
}
function normalizeMap(map, { configDir, cwd, commonAppVersion, commonMapVersion }) {
  const image = map.image ?? map.path;
  const imagePath = image ? resolveBuildPath(image, map.fromConfig === false ? cwd : configDir) : null;
  const bounds = parseBoundsString(map.bounds);
  const imageFilename = imagePath ? import_node_path2.default.basename(imagePath) : null;
  const imageMimeType = imageFilename ? mimeTypeForImage(imageFilename) : null;
  return {
    levelId: typeof map.levelId === "string" ? map.levelId.trim() : map.levelId ?? map.level_id ?? null,
    imagePath,
    imageFilename,
    imageMimeType,
    bounds,
    horizontalAxis: (map.horizontalAxis ?? map.map_horizontal_axis ?? "x").toLowerCase(),
    verticalAxis: (map.verticalAxis ?? map.map_vertical_axis ?? "z").toLowerCase(),
    appVersion: map.appVersion ?? map.app_version ?? commonAppVersion ?? null,
    variantKey: optionalString(map.variantKey ?? map.variant_key ?? map.variant),
    version: optionalPositiveInteger(map.mapVersion ?? map.map_version ?? map.version ?? commonMapVersion, "map.version"),
    defaultVariant: optionalBoolean(map.defaultVariant ?? map.default_variant, "map.defaultVariant"),
    // Unset means the map takes the game's scale, which is what most games want.
    worldUnitsPerMeter: optionalPositiveNumber(map.worldUnitsPerMeter ?? map.world_units_per_meter, "map.worldUnitsPerMeter")
  };
}
function validateMapPlan(plan) {
  if (!plan.organizationId) {
    throw new Error(
      "Missing organization id. Set organizationId in config, TESTING_FLOOR_ORGANIZATION_ID, or pass --organization-id."
    );
  }
  if (!plan.gameId || !/^[A-Za-z0-9_-]+$/.test(String(plan.gameId))) {
    throw new Error('Missing game id. Set gameId in config or pass --game-id. Accepts numeric id or game key (e.g. "crux").');
  }
  if (plan.maps.length === 0) {
    throw new Error("No maps configured. Pass --level-id/--image/--bounds or provide config maps.");
  }
  for (const map of plan.maps) {
    if (!map.levelId) {
      throw new Error("Missing levelId for map.");
    }
    if (!map.imagePath) {
      throw new Error(`Missing image path for map ${map.levelId}.`);
    }
    if (!map.imageMimeType) {
      throw new Error(`Unsupported image type for ${map.imageFilename}. Use .png, .jpg, .jpeg, or .webp.`);
    }
    if (!map.bounds) {
      throw new Error(`Missing bounds for map ${map.levelId}.`);
    }
    if (!AXES.has(map.horizontalAxis)) {
      throw new Error(`Invalid horizontal axis "${map.horizontalAxis}". Expected x, y, or z.`);
    }
    if (!AXES.has(map.verticalAxis)) {
      throw new Error(`Invalid vertical axis "${map.verticalAxis}". Expected x, y, or z.`);
    }
    if (map.horizontalAxis === map.verticalAxis) {
      throw new Error(`Horizontal and vertical axes must differ (got "${map.horizontalAxis}").`);
    }
  }
}
function validateBounds({ centerX, centerZ, sizeX, sizeZ }) {
  if (!(sizeX > 0)) {
    throw new Error("bounds.sizeX must be greater than zero.");
  }
  if (!(sizeZ > 0)) {
    throw new Error("bounds.sizeZ must be greater than zero.");
  }
  return { centerX, centerZ, sizeX, sizeZ };
}
function numericValue(value, name) {
  if (value === void 0 || value === null || value === "") {
    throw new Error(`${name} is required.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a finite number, got "${value}".`);
  }
  return parsed;
}
function optionalPositiveNumber(value, name) {
  if (value === void 0 || value === null || value === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number, got "${value}".`);
  }
  return parsed;
}
function optionalPositiveInteger(value, name) {
  if (value === void 0 || value === null || value === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer, got "${value}".`);
  }
  return parsed;
}
function optionalBoolean(value, name) {
  if (value === void 0 || value === null || value === "") {
    return null;
  }
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no"].includes(normalized)) {
    return false;
  }
  throw new Error(`${name} must be true or false.`);
}
function optionalString(value) {
  if (value === void 0 || value === null) {
    return null;
  }
  const string = String(value).trim();
  return string === "" ? null : string;
}
function mimeTypeForImage(filename) {
  return IMAGE_MIME_TYPES[import_node_path2.default.extname(filename).toLowerCase()] ?? null;
}
var MANIFEST_VERIFY_TIMEOUT_MS = 45 * 60 * 1e3;
async function readJson(filePath) {
  const raw = await (0, import_promises2.readFile)(filePath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Could not parse ${filePath}: ${error.message}`);
  }
}
async function pathInfo(filePath, { allowDirectory, label }) {
  let stats;
  try {
    await (0, import_promises2.access)(filePath);
    stats = await (0, import_promises2.stat)(filePath);
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
  const handle = await (0, import_promises2.opendir)(dir);
  for await (const entry of handle) {
    const fullPath = import_node_path2.default.join(dir, entry.name);
    const entryStats = await (0, import_promises2.stat)(fullPath);
    if (entryStats.isDirectory()) {
      total += await directorySize(fullPath);
    } else if (entryStats.isFile()) {
      total += entryStats.size;
    }
  }
  return total;
}
async function hashFile(filePath) {
  const md5 = (0, import_node_crypto.createHash)("md5");
  const sha256 = (0, import_node_crypto.createHash)("sha256");
  await new Promise((resolve, reject) => {
    const stream = (0, import_node_fs2.createReadStream)(filePath);
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
function uploadFile(uploadUrl, uploadHeaders, filePath, size, { start, end, label = "Upload" } = {}) {
  const url = new URL(uploadUrl);
  const client = url.protocol === "https:" ? import_node_https.default : import_node_http.default;
  const headers = compactHeaders({ ...uploadHeaders, "Content-Length": String(size) });
  return new Promise((resolve, reject) => {
    const request = client.request(url, { method: "PUT", headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(response.headers);
        } else {
          reject(new Error(`${label} failed with ${response.statusCode}: ${body}`));
        }
      });
    });
    request.on("error", reject);
    (0, import_node_fs2.createReadStream)(filePath, streamOptions({ start, end })).on("error", reject).pipe(request);
  });
}
function compactHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).filter(([, value]) => value !== void 0 && value !== null && value !== "")
  );
}
function streamOptions({ start, end }) {
  return compact({ start, end });
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
function resolveBuildPath(filePath, baseDir) {
  return import_node_path2.default.isAbsolute(filePath) ? filePath : import_node_path2.default.resolve(baseDir, filePath);
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

// src/action-map.js
async function runMapAction(env = import_node_process4.default.env, cwd = import_node_process4.default.cwd()) {
  const options = readMapInputs(env);
  const plan = await resolveMapPlan(options, env, cwd);
  const result = await uploadMap(plan, plan.maps[0]);
  writeOutput("map-id", result.id, env);
  writeOutput("level-id", result.levelId, env);
  writeOutput("version", result.version, env);
  writeOutput("pinned", result.pinned, env);
  writeOutput("app-version", result.appVersion, env);
  writeOutput("variant-key", result.variantKey, env);
  writeOutput("variant-label", result.variantLabel, env);
  writeOutput("default-variant", result.defaultVariant, env);
  writeOutput("configured", result.configured, env);
}
function readMapInputs(env) {
  return {
    apiUrl: input(env, "api-url") || void 0,
    appVersion: input(env, "app-version") || void 0,
    bounds: boundsFromInputs(env),
    gameId: requiredInput(env, "game-id"),
    horizontalAxis: input(env, "horizontal-axis") || void 0,
    image: requiredInput(env, "image"),
    levelId: requiredInput(env, "level-id"),
    mapVersion: input(env, "map-version") || void 0,
    organizationId: input(env, "organization-id") || void 0,
    token: requiredInput(env, "api-token"),
    variantKey: input(env, "variant-key") || input(env, "variant") || void 0,
    defaultVariant: input(env, "default-variant") || void 0,
    verticalAxis: input(env, "vertical-axis") || void 0,
    worldUnitsPerMeter: input(env, "world-units-per-meter") || void 0
  };
}
function boundsFromInputs(env) {
  const single = input(env, "bounds");
  if (single) {
    return single;
  }
  const centerX = requiredInput(env, "bounds-center-x");
  const centerZ = requiredInput(env, "bounds-center-z");
  const sizeX = requiredInput(env, "bounds-size-x");
  const sizeZ = requiredInput(env, "bounds-size-z");
  return { centerX, centerZ, sizeX, sizeZ };
}

// src/action-map-entry.js
runMapAction().catch((error) => {
  console.error(`::error::${escapeCommand(error.message)}`);
  process.exitCode = 1;
});
function escapeCommand(value) {
  return String(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}
