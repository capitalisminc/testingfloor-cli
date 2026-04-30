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
var import_node_process3 = __toESM(require("node:process"), 1);

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
var import_promises = require("node:fs/promises");
var import_node_path = __toESM(require("node:path"), 1);
var import_node_process2 = __toESM(require("node:process"), 1);
var DEFAULT_API_URL = "https://testingfloor.com";
var AXES = /* @__PURE__ */ new Set(["x", "y", "z"]);
var IMAGE_MIME_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};
async function resolveMapPlan(options, env = {}, cwd = import_node_process2.default.cwd()) {
  const configPath = options.config ? import_node_path.default.resolve(cwd, options.config) : null;
  const config = configPath ? await readJson(configPath) : {};
  const configDir = configPath ? import_node_path.default.dirname(configPath) : cwd;
  const cliMapRequested = Boolean(options.levelId || options.image || options.bounds);
  const configuredMaps = Array.isArray(config.maps) ? config.maps : [];
  if (cliMapRequested && configuredMaps.length > 0) {
    throw new Error("Use either --config maps or --level-id/--image flags, not both.");
  }
  const apiUrl = normalizeApiUrl(
    firstPresent(options.apiUrl, env.TESTING_FLOOR_API_URL, config.apiUrl, DEFAULT_API_URL)
  );
  const token = firstPresent(options.token, env.TESTING_FLOOR_API_TOKEN, config.token);
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
  const rawMaps = cliMapRequested ? [mapFromOptions(options)] : configuredMaps;
  const maps = rawMaps.map(
    (map) => normalizeMap(map, { configDir, cwd, commonAppVersion: appVersion })
  );
  validateMapPlan({ apiUrl, token, organizationId, gameId, maps });
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
  const formData = new FormData();
  formData.append("level_id", map.levelId);
  formData.append("bounds[center_x]", String(map.bounds.centerX));
  formData.append("bounds[center_z]", String(map.bounds.centerZ));
  formData.append("bounds[size_x]", String(map.bounds.sizeX));
  formData.append("bounds[size_z]", String(map.bounds.sizeZ));
  formData.append("map_horizontal_axis", map.horizontalAxis);
  formData.append("map_vertical_axis", map.verticalAxis);
  if (map.appVersion) {
    formData.append("app_version", map.appVersion);
  }
  const imageBytes = await (0, import_promises.readFile)(map.imagePath);
  const imageBlob = new Blob([imageBytes], { type: map.imageMimeType });
  formData.append("image", imageBlob, map.imageFilename);
  const response = await postFormData(gameApiUrl(plan, "/maps"), plan.token, formData);
  return {
    id: response.id,
    levelId: response.level_id ?? map.levelId,
    version: response.version ?? null,
    pinned: response.pinned ?? null,
    appVersion: response.app_version ?? map.appVersion ?? null,
    bounds: response.bounds ?? null,
    horizontalAxis: response.map_horizontal_axis ?? map.horizontalAxis,
    verticalAxis: response.map_vertical_axis ?? map.verticalAxis,
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
    appVersion: options.appVersion
  };
}
function normalizeMap(map, { configDir, cwd, commonAppVersion }) {
  const image = map.image ?? map.path;
  const imagePath = image ? resolveBuildPath(image, map.fromConfig === false ? cwd : configDir) : null;
  const bounds = parseBoundsString(map.bounds);
  const imageFilename = imagePath ? import_node_path.default.basename(imagePath) : null;
  const imageMimeType = imageFilename ? mimeTypeForImage(imageFilename) : null;
  return {
    levelId: typeof map.levelId === "string" ? map.levelId.trim() : map.levelId ?? map.level_id ?? null,
    imagePath,
    imageFilename,
    imageMimeType,
    bounds,
    horizontalAxis: (map.horizontalAxis ?? map.map_horizontal_axis ?? "x").toLowerCase(),
    verticalAxis: (map.verticalAxis ?? map.map_vertical_axis ?? "z").toLowerCase(),
    appVersion: map.appVersion ?? map.app_version ?? commonAppVersion ?? null
  };
}
function validateMapPlan(plan) {
  if (!plan.token) {
    throw new Error("Missing API token. Set TESTING_FLOOR_API_TOKEN or pass --token.");
  }
  if (!plan.organizationId) {
    throw new Error(
      "Missing organization id. Set organizationId in config, TESTING_FLOOR_ORGANIZATION_ID, or pass --organization-id."
    );
  }
  if (!plan.gameId || !/^\d+$/.test(String(plan.gameId))) {
    throw new Error("Missing numeric game id. Set gameId in config or pass --game-id.");
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
function mimeTypeForImage(filename) {
  return IMAGE_MIME_TYPES[import_node_path.default.extname(filename).toLowerCase()] ?? null;
}
async function readJson(filePath) {
  const raw = await (0, import_promises.readFile)(filePath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Could not parse ${filePath}: ${error.message}`);
  }
}
async function postFormData(url, token, formData) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}` },
    body: formData
  });
  const text = await response.text();
  const parsed = text ? parseJsonResponse(text, url) : {};
  if (!response.ok) {
    throw new Error(parsed.error || `${response.status} ${response.statusText} from ${url}`);
  }
  return parsed;
}
function parseJsonResponse(text, url) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON response from ${url}, got: ${text.slice(0, 160)}`);
  }
}
function resolveBuildPath(filePath, baseDir) {
  return import_node_path.default.isAbsolute(filePath) ? filePath : import_node_path.default.resolve(baseDir, filePath);
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
async function runMapAction(env = import_node_process3.default.env, cwd = import_node_process3.default.cwd()) {
  const options = readMapInputs(env);
  const plan = await resolveMapPlan(options, env, cwd);
  const result = await uploadMap(plan, plan.maps[0]);
  writeOutput("map-id", result.id, env);
  writeOutput("level-id", result.levelId, env);
  writeOutput("version", result.version, env);
  writeOutput("pinned", result.pinned, env);
  writeOutput("app-version", result.appVersion, env);
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
    organizationId: input(env, "organization-id") || void 0,
    token: requiredInput(env, "api-token"),
    verticalAxis: input(env, "vertical-axis") || void 0
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
