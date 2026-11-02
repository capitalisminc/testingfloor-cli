import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdtemp, opendir, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { chunkBuildDirectory, readObject } from "./chunks.js";
import { readSavedLogin } from "./credentials.js";
import { login, logout, whoami } from "./login.js";
import { prepareRecordingPlan, uploadRecordings } from "./recordings.js";

const DEFAULT_API_URL = "https://api.testingfloor.com";
const DESCRIPTION_MAX_LENGTH = 1000;
const PLATFORMS = new Set(["windows", "macos", "linux"]);
const AXES = new Set(["x", "y", "z"]);
const IMAGE_MIME_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};
const ARRAY_OPTIONS = new Set(["launch-arg", "source-ref"]);
const VALUE_OPTIONS = new Set([
  "api-url",
  "app-version",
  "apply-to-history",
  "build-id",
  "corrects-map-id",
  "correction-reason",
  "archive",
  "bounds",
  "branch",
  "build-directory",
  "config",
  "description",
  "filename",
  "file",
  "game-id",
  "git-sha",
  "horizontal-axis",
  "image",
  "idempotency-key",
  "presentation",
  "launch-path",
  "level-id",
  "map-version",
  "organization-id",
  "platform",
  "playtest-id",
  "recorded-at",
  "source-ref-json",
  "schema",
  "mode",
  "token",
  "tester-id",
  "tester-name",
  "tester-email",
  "default-variant",
  "variant",
  "variant-key",
  "version",
  "vertical-axis",
  "working-directory",
  "written-feedback",
  "world-units-per-meter"
]);
const REMOVED_OPTIONS = {
  "archive-kind": "--archive-kind was removed. Uploads send the build directory as chunks."
};

// deps lets bin/ pass the package version and tests swap out the browser,
// clock and output.
export async function main(argv = process.argv.slice(2), env = process.env, cwd = process.cwd(), deps = {}) {
  const parsed = parseArgs(argv);

  if (parsed.help || parsed.command === "help" || !parsed.command) {
    process.stdout.write(helpText());
    return;
  }

  if (parsed.command === "login") {
    await login({ ...deps, apiUrl: resolveApiUrl(parsed.options, env), env, noBrowser: parsed.options.noBrowser });
    return;
  }

  if (parsed.command === "logout") {
    await logout({ env, print: deps.print });
    return;
  }

  if (parsed.command === "whoami") {
    await whoami({ apiUrl: resolveApiUrl(parsed.options, env), env, print: deps.print });
    return;
  }

  if (["upload-build", "upload"].includes(parsed.command)) {
    const plan = await resolveUploadPlan(parsed.options, env, cwd);
    const log = parsed.options.json ? () => {} : console.error;
    const results = [];
    for (const build of plan.builds) {
      results.push(await uploadBuild(plan, build, { log }));
    }
    process.stdout.write(`${JSON.stringify({ builds: results }, null, 2)}\n`);
    return;
  }

  if (parsed.command === "upload-map") {
    const plan = await resolveMapPlan(parsed.options, env, cwd);
    const log = parsed.options.json ? () => {} : console.error;
    const results = [];
    for (const map of plan.maps) {

      results.push(await uploadMap(plan, map, { log }));
    }
    process.stdout.write(`${JSON.stringify({ maps: results }, null, 2)}\n`);
    return;
  }

  if (["upload-recording", "upload-recordings"].includes(parsed.command)) {
    const plan = await resolveRecordingPlan(parsed.options, env, cwd);
    const controller = new AbortController();
    const cancel = () => controller.abort(new Error("Upload cancelled"));
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      const recordings = await uploadRecordings(plan, {
        log: parsed.options.json ? () => {} : deps.log ?? console.error,
        signal: controller.signal
      });
      const output = JSON.stringify({ recordings }, null, 2);
      if (deps.print) deps.print(output);
      else process.stdout.write(`${output}\n`);
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
    return;
  }

  if (["get-event-presentation", "set-event-presentation"].includes(parsed.command)) {
    const plan = await resolveTelemetryPlan({ ...parsed.options, schema: parsed.options.presentation }, env, cwd);
    const updating = parsed.command === "set-event-presentation";
    if (parsed.options.schema) throw new Error("Use --presentation for event styling, and --schema for data mappings.");
    if (updating && !plan.schemaConfig) throw new Error("Missing --presentation JSON file.");
    if (!updating && plan.schemaConfig) throw new Error("Use set-event-presentation to apply --presentation.");
    const result = await eventPresentation(plan, { update: updating });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (["get-telemetry-schema", "set-telemetry-schema"].includes(parsed.command)) {
    if (parsed.options.presentation) throw new Error("Use set-event-presentation to apply --presentation.");
    const plan = await resolveTelemetryPlan(parsed.options, env, cwd);
    const updating = parsed.command === "set-telemetry-schema";
    if (updating && !plan.schemaConfig) throw new Error("Missing --schema JSON file.");
    if (!updating && plan.schemaConfig) throw new Error("Use set-telemetry-schema to apply --schema.");
    const result = await telemetrySchema(plan, { update: updating });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  throw new Error(`Unknown command "${parsed.command}". Run "testingfloor help".`);
}

export async function resolveRecordingPlan(options, env = {}, cwd = process.cwd()) {
  const configPath = options.config ? path.resolve(cwd, options.config) : null;
  const config = configPath ? await readJson(configPath) : {};
  const apiUrl = normalizeApiUrl(firstPresent(options.apiUrl, env.TESTING_FLOOR_API_URL, config.apiUrl, DEFAULT_API_URL));
  const file = firstPresent(options.file, config.file);
  return prepareRecordingPlan({
    apiUrl,
    token: await resolveToken({ options, env, config, apiUrl }),
    organizationId: firstPresent(options.organizationId, env.TESTING_FLOOR_ORGANIZATION_ID, config.organizationId),
    gameId: firstPresent(options.gameId, env.TESTING_FLOOR_GAME_ID, config.gameId),
    playtestId: firstPresent(options.playtestId, env.TESTING_FLOOR_PLAYTEST_ID, config.playtestId),
    file: file ? path.resolve(options.file ? cwd : configPath ? path.dirname(configPath) : cwd, file) : undefined,
    testerId: firstPresent(options.testerId, config.testerId),
    testerName: firstPresent(options.testerName, config.testerName),
    testerEmail: firstPresent(options.testerEmail, config.testerEmail),
    recordedAt: firstPresent(options.recordedAt, config.recordedAt),
    writtenFeedback: firstPresent(options.writtenFeedback, config.writtenFeedback),
    version: firstPresent(options.version, env.TESTING_FLOOR_VERSION, config.version),
    idempotencyKey: options.idempotencyKey ?? config.idempotencyKey
  });
}

export async function resolveTelemetryPlan(options, env = {}, cwd = process.cwd()) {
  const config = options.config ? await readJson(path.resolve(cwd, options.config)) : {};
  const apiUrl = normalizeApiUrl(firstPresent(options.apiUrl, env.TESTING_FLOOR_API_URL, config.apiUrl, DEFAULT_API_URL));
  const plan = {
    apiUrl,
    token: await resolveToken({ options, env, config, apiUrl }),
    organizationId: firstPresent(options.organizationId, env.TESTING_FLOOR_ORGANIZATION_ID, config.organizationId),
    gameId: firstPresent(options.gameId, env.TESTING_FLOOR_GAME_ID, config.gameId),
    mode: options.mode ?? "merge"
  };
  if (!plan.organizationId) throw new Error("Missing organization id. Pass --organization-id or set TESTING_FLOOR_ORGANIZATION_ID.");
  if (!plan.gameId || !/^[A-Za-z0-9_-]+$/.test(String(plan.gameId))) throw new Error("Missing or invalid game id. Pass --game-id or set TESTING_FLOOR_GAME_ID.");
  if (!["merge", "replace"].includes(plan.mode)) throw new Error("--mode must be merge or replace.");
  if (options.schema) {
    plan.schemaConfig = await readJson(path.resolve(cwd, options.schema));
    if (!plan.schemaConfig || typeof plan.schemaConfig !== "object" || Array.isArray(plan.schemaConfig)) {
      throw new Error("Schema file must contain a JSON object.");
    }
  }
  return plan;
}

export async function telemetrySchema(plan, { update = false } = {}) {
  return requestJson(gameApiUrl(plan, "/telemetry/schema"), plan.token, {
    method: update ? "PATCH" : "GET",
    headers: update ? { "Content-Type": "application/json" } : {},
    body: update ? JSON.stringify({ schema_config: plan.schemaConfig, mode: plan.mode }) : undefined
  });
}

export async function eventPresentation(plan, { update = false } = {}) {
  return requestJson(gameApiUrl(plan, "/analytics/event-presentation"), plan.token, {
    method: update ? "PATCH" : "GET",
    headers: update ? { "Content-Type": "application/json" } : {},
    body: update ? JSON.stringify({ presentation_config: plan.schemaConfig, mode: plan.mode }) : undefined
  });
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

    if (raw === "--no-browser") {
      result.options.noBrowser = true;
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

    if (REMOVED_OPTIONS[name]) {
      throw new Error(REMOVED_OPTIONS[name]);
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
  const buildIdentifier = firstPresent(options.buildId, env.TESTING_FLOOR_BUILD_ID, config.buildId, config.build_id);
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
  const builds = rawBuilds.map((build) =>
    normalizeBuild(build, {
      configDir,
      cwd,
      commonVersion: version,
      commonBuildIdentifier: buildIdentifier,
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
    idempotencyKey: firstPresent(options.idempotencyKey, env.TESTING_FLOOR_IDEMPOTENCY_KEY, config.idempotencyKey),
    builds
  };
}

export async function resolveMapPlan(options, env = {}, cwd = process.cwd()) {
  const configPath = options.config ? path.resolve(cwd, options.config) : null;
  const config = configPath ? await readJson(configPath) : {};
  const configDir = configPath ? path.dirname(configPath) : cwd;

  const cliMapRequested = Boolean(
    options.levelId ||
      options.image ||
      options.bounds ||
      options.horizontalAxis ||
      options.verticalAxis ||
      options.variant ||
      options.variantKey ||
      options.defaultVariant ||
      options.worldUnitsPerMeter
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

  const buildIdentifier = firstPresent(options.buildId, env.TESTING_FLOOR_BUILD_ID, config.buildId, config.build_id);
  const rawMaps = cliMapRequested ? [mapFromOptions(options)] : configuredMaps;
  const maps = rawMaps.map((map) =>
    normalizeMap(map, { configDir, cwd, commonAppVersion: appVersion, commonMapVersion: mapVersion, commonBuildIdentifier: buildIdentifier })
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

export function parseBoundsString(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }

  if (typeof raw === "object" && !Array.isArray(raw)) {
    const centerX = numericValue(raw.centerX ?? raw.center_x, "bounds.centerX");
    const centerZ = numericValue(raw.centerZ ?? raw.center_z, "bounds.centerZ");
    const sizeX = numericValue(raw.sizeX ?? raw.size_x, "bounds.sizeX");
    const sizeZ = numericValue(raw.sizeZ ?? raw.size_z, "bounds.sizeZ");
    return validateBounds({ centerX, centerZ, sizeX, sizeZ });
  }

  if (typeof raw !== "string") {
    throw new Error("bounds must be a string \"cx,cz,sx,sz\" or an object.");
  }

  const parts = raw.split(",").map((piece) => piece.trim());
  if (parts.length !== 4) {
    throw new Error("bounds must be four comma-separated numbers: center_x,center_z,size_x,size_z.");
  }

  const [centerX, centerZ, sizeX, sizeZ] = parts.map((piece, index) =>
    numericValue(piece, ["bounds.centerX", "bounds.centerZ", "bounds.sizeX", "bounds.sizeZ"][index])
  );

  return validateBounds({ centerX, centerZ, sizeX, sizeZ });
}

export async function uploadMap(plan, map, { log = console.error } = {}) {
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
    app_version: map.appVersion || undefined,
    build_id: map.buildIdentifier ?? undefined,
    corrects_map_id: map.correctsMapId ?? undefined,
    correction_reason: map.correctionReason ?? undefined,
    apply_to_history: map.applyToHistory ?? undefined,
    variant_key: map.variantKey || undefined,
    version: map.version || undefined,
    default_variant:
      map.defaultVariant === null || map.defaultVariant === undefined ? undefined : map.defaultVariant,
    world_units_per_meter: map.worldUnitsPerMeter ?? undefined,
    image_signed_id: imageUpload.signed_id
  });

  return {
    id: response.id,
    levelId: response.level_id ?? map.levelId,
    version: response.version ?? map.version ?? null,
    pinned: response.pinned ?? null,
    appVersion: response.app_version ?? map.appVersion ?? null,
    buildIdentifier: response.build_id ?? map.buildIdentifier ?? null,
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
    buildId: options.buildId,
    correctsMapId: options.correctsMapId,
    correctionReason: options.correctionReason,
    applyToHistory: options.applyToHistory,
    variantKey: options.variantKey ?? options.variant,
    mapVersion: options.mapVersion,
    defaultVariant: options.defaultVariant,
    worldUnitsPerMeter: options.worldUnitsPerMeter
  };
}

function normalizeMap(map, { configDir, cwd, commonAppVersion, commonMapVersion, commonBuildIdentifier }) {
  const image = map.image ?? map.path;
  const imagePath = image ? resolveBuildPath(image, map.fromConfig === false ? cwd : configDir) : null;
  const bounds = parseBoundsString(map.bounds);
  const imageFilename = imagePath ? path.basename(imagePath) : null;
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
    buildIdentifier: optionalBuildIdentifier(map.buildId ?? map.build_id ?? commonBuildIdentifier),
    correctsMapId: optionalPositiveInteger(map.correctsMapId ?? map.corrects_map_id, "map.correctsMapId"),
    correctionReason: optionalString(map.correctionReason ?? map.correction_reason),
    applyToHistory: optionalBoolean(map.applyToHistory ?? map.apply_to_history, "map.applyToHistory"),
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
    throw new Error("Missing game id. Set gameId in config or pass --game-id. Accepts numeric id or game key (e.g. \"crux\").");
  }

  if (plan.maps.length === 0) {
    throw new Error("No maps configured. Pass --level-id/--image/--bounds or provide config maps.");
  }

  for (const map of plan.maps) {
    if (map.correctsMapId && !map.correctionReason) throw new Error("Map corrections require --correction-reason.");
    if (!map.correctsMapId && (map.correctionReason || map.applyToHistory !== null)) {
      throw new Error("Correction reason and history choice require --corrects-map-id.");
    }
    if (map.correctsMapId && !map.applyToHistory && !map.buildIdentifier) {
      throw new Error("Future-only map corrections require a new --build-id, or choose --apply-to-history true.");
    }
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
  if (value === undefined || value === null || value === "") {
    throw new Error(`${name} is required.`);
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a finite number, got "${value}".`);
  }

  return parsed;
}

function optionalPositiveNumber(value, name) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number, got "${value}".`);
  }

  return parsed;
}

function optionalPositiveInteger(value, name) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer, got "${value}".`);
  }

  return parsed;
}

function optionalBoolean(value, name) {
  if (value === undefined || value === null || value === "") {
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

function optionalBuildIdentifier(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim() === "" || Array.from(value).length > 255) {
    throw new Error("buildId must be nonblank text of at most 255 characters.");
  }
  return value;
}

function optionalString(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const string = String(value).trim();
  return string === "" ? null : string;
}

function mimeTypeForImage(filename) {
  return IMAGE_MIME_TYPES[path.extname(filename).toLowerCase()] ?? null;
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

// A build becomes available only after every referenced chunk is verified.
export async function uploadBuild(plan, build, { log = console.error, pollIntervalMs, retryDelaysMs = REQUEST_RETRY_DELAYS_MS } = {}) {
  const source = await pathInfo(build.buildDirectory, { allowDirectory: true, label: "Build source" });
  const directory = (await stat(build.buildDirectory)).isDirectory();
  if (!directory && path.extname(build.buildDirectory).toLowerCase() !== ".zip") {
    throw new Error("Build source must be a folder or a ZIP archive.");
  }
  const chunks = directory ? await chunkBuildDirectory(build.buildDirectory) : null;
  const hashes = directory ? null : await hashFile(build.buildDirectory);
  const contentDigest = directory ? createHash("sha256").update(JSON.stringify(chunks.entries)).digest("hex") : hashes.sha256Hex;
  const idempotencyKey = plan.idempotencyKey
    ? createHash("sha256").update(JSON.stringify([plan.idempotencyKey, build.branch ?? null, build.platform, build.filename])).digest("hex")
    : randomUUID();
  const created = await postJson(gameApiUrl(plan, "/builds"), plan.token, {
    platform: build.platform, branch: build.branch, version: build.version, build_id: build.buildIdentifier ?? undefined,
    description: build.description, git_sha: build.gitSha, archive_kind: directory ? "chunks" : "zip",
    filename: build.filename, byte_size: source.size, launch_path: build.launchPath,
    checksum_md5: hashes?.md5Base64,
    launch_args: build.launchArgs, working_directory: build.workingDirectory,
    source_ref: { ...build.sourceRef, content_sha256: contentDigest }
  }, { retryDelaysMs, headers: { "Idempotency-Key": idempotencyKey } });
  if (created.status && !["pending", "ready"].includes(created.status)) {
    throw new Error(`Build ${created.id} cannot resume from status ${created.status}.`);
  }
  let manifest = {};
  let completionBody = {};
  if (!created.status || created.status === "pending") {
    if (directory) {
      manifest = await uploadChunkManifest(plan, created.id, build.buildDirectory, { log, pollIntervalMs, retryDelaysMs, chunks });
    } else {
      completionBody.signed_id = created.signed_id;
      if (created.upload_strategy === "multipart") {
        const multipart = created.multipart_upload;
        const parts = [];
        for (const part of multipart.parts) {
          const start = (part.part_number - 1) * multipart.part_size;
          const end = Math.min(source.size, start + multipart.part_size) - 1;
          const headers = await withRetries(`Part ${part.part_number}`, () => uploadFile(part.upload_url, part.upload_headers ?? {}, build.buildDirectory, end - start + 1, { start, end }));
          const etag = headerValue(headers, "etag");
          if (!etag) throw new Error(`Part ${part.part_number} returned no ETag.`);
          parts.push({ part_number: part.part_number, etag });
        }
        completionBody.multipart_upload = { upload_id: multipart.upload_id, parts };
      } else {
        await withRetries("ZIP upload", () => uploadFile(created.upload_url, created.upload_headers ?? {}, build.buildDirectory, source.size));
      }
    }
    log(`Completing build ${created.id}`);
  }
  const completed = created.status && created.status !== "pending"
    ? created
    : await postJson(`${plan.apiUrl}/api/game_builds/${created.id}/complete`, plan.token, completionBody, { retryDelaysMs });
  return {
    buildId: completed.id ?? created.id, buildIdentifier: completed.build_id ?? created.build_id ?? build.buildIdentifier ?? null, platform: build.platform, version: build.version,
    gitSha: build.gitSha, filename: build.filename, checksumSha256: hashes?.sha256Hex ?? null,
    sizeBytes: source.size, status: completed.status ?? "ready", readyAt: completed.ready_at,
    zipSizeBytes: manifest.zip_size_bytes ?? null
  };
}

const CHUNK_ANNOUNCE_BATCH = 1000;
const CHUNK_UPLOAD_CONCURRENCY = 8;
const MANIFEST_VERIFY_TIMEOUT_MS = 45 * 60 * 1000;

// Uploads the build folder as chunks plus a manifest, then waits until
// Testing Floor has verified every chunk and file checksum. Only chunks the
// game hasn't stored before are uploaded.
async function uploadChunkManifest(plan, buildId, buildDirectory, { log, pollIntervalMs = 5000, retryDelaysMs, chunks }) {
  log(`Splitting ${buildDirectory} into chunks for zip downloads and recorder installs`);
  const { entries, objects } = chunks ?? await chunkBuildDirectory(buildDirectory);
  const objectList = [...objects.entries()];
  const totalBytes = objectList.reduce((sum, [, object]) => sum + object.size, 0);
  log(`${entries.length} entries in ${objectList.length} chunks (${formatBytes(totalBytes)})`);

  const missing = [];
  for (let index = 0; index < objectList.length; index += CHUNK_ANNOUNCE_BATCH) {
    const batch = objectList.slice(index, index + CHUNK_ANNOUNCE_BATCH);
    // Safe to repeat: announcing a chunk again just presigns it again.
    const response = await postJson(`${plan.apiUrl}/api/game_builds/${buildId}/chunks`, plan.token, {
      chunks: batch.map(([sha256, object]) => ({ sha256, byte_size: object.size }))
    }, { retryDelaysMs });
    missing.push(...(response.missing ?? []));
  }

  const missingBytes = missing.reduce((sum, chunk) => sum + objects.get(chunk.sha256).size, 0);
  log(`Uploading ${missing.length} new chunks (${formatBytes(missingBytes)}); the other ${objectList.length - missing.length} are already stored`);
  await mapWithConcurrency(missing, CHUNK_UPLOAD_CONCURRENCY, (chunk) =>
    withRetries(`Chunk ${chunk.sha256}`, async () => {
      const object = objects.get(chunk.sha256);
      await uploadBuffer(chunk.upload_url, chunk.upload_headers ?? {}, await readObject(object), { label: `Chunk ${chunk.sha256}` });
    })
  );

  // Safe to repeat: sending the manifest again replaces the pending one.
  await postJson(`${plan.apiUrl}/api/game_builds/${buildId}/manifest`, plan.token, {
    manifest: { modified_at: new Date().toISOString(), entries }
  }, { retryDelaysMs });

  log("Waiting for Testing Floor to verify the chunks");
  const deadline = Date.now() + MANIFEST_VERIFY_TIMEOUT_MS;
  for (;;) {
    let status = null;
    try {
      status = await getJson(`${plan.apiUrl}/api/game_builds/${buildId}/manifest`, plan.token, { retryDelaysMs });
    } catch (error) {
      // The build is already uploaded, so a check that doesn't get through
      // is no reason to give up: keep checking until the deadline.
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
  const client = url.protocol === "https:" ? https : http;
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
  const raw = await readFile(filePath, "utf8");

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
    buildId: options.buildId,
    workingDirectory: options.workingDirectory
  };
}

function normalizeBuild(build, { configDir, cwd, commonVersion, commonDescription, commonGitSha, commonSourceRef, commonBranch, commonBuildIdentifier }) {
  // The source may be a build folder or an existing ZIP archive.
  const directory = build.buildDirectory ?? build.build_directory ?? build.archive ?? build.path;

  return {
    buildDirectory: directory ? resolveBuildPath(directory, build.fromConfig === false ? cwd : configDir) : null,
    branch: build.branch ?? commonBranch ?? undefined,
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
    buildIdentifier: optionalBuildIdentifier(build.buildId ?? build.build_id ?? commonBuildIdentifier),
    workingDirectory: build.workingDirectory ?? build.working_directory ?? "."
  };
}

function defaultBuildFilename(directory) {
  if (!directory) {
    return null;
  }

  const name = path.basename(directory);
  return path.extname(name).toLowerCase() === ".zip" ? name : `${name}.zip`;
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
  if (!plan.organizationId) {
    throw new Error(
      "Missing organization id. Set organizationId in config, TESTING_FLOOR_ORGANIZATION_ID, or pass --organization-id."
    );
  }

  if (!plan.gameId || !/^[A-Za-z0-9_-]+$/.test(String(plan.gameId))) {
    throw new Error("Missing game id. Set gameId in config or pass --game-id. Accepts numeric id or game key (e.g. \"crux\").");
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

    if (build.description !== undefined && (typeof build.description !== "string" || Array.from(build.description).length > DESCRIPTION_MAX_LENGTH)) {
      throw new Error(`Build description must be text of at most ${DESCRIPTION_MAX_LENGTH} characters.`);
    }

    if (!build.launchPath) {
      throw new Error(`Missing launchPath for ${build.platform}.`);
    }
  }
}

async function fileInfo(filePath) {
  return pathInfo(filePath, { allowDirectory: false, label: "Archive" });
}

async function pathInfo(filePath, { allowDirectory, label }) {
  let stats;
  try {
    await access(filePath);
    stats = await stat(filePath);
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
  const handle = await opendir(dir);
  for await (const entry of handle) {
    const fullPath = path.join(dir, entry.name);
    const entryStats = await stat(fullPath);
    if (entryStats.isDirectory()) {
      total += await directorySize(fullPath);
    } else if (entryStats.isFile()) {
      total += entryStats.size;
    }
  }
  return total;
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

// Waits before each retry of a request that's safe to repeat. About 15
// seconds in all, enough to ride out a dropped connection or a deploy.
const REQUEST_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];
const RETRYABLE_STATUSES = new Set([408, 429]);

// A request that got no answer, or an answer saying the server is busy or
// failing. Repeating it may work; repeating any other 4xx won't.
class TransientRequestError extends Error {}

// Callers opt in only after establishing that repeating the operation is safe.
async function postJson(url, token, body, { retryDelaysMs = [], headers = {} } = {}) {
  return withRequestRetries(retryDelaysMs, () =>
    requestJson(url, token, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
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
    response = await fetch(url, { method, headers: { "Authorization": `Bearer ${token}`, "TestingFloor-Api-Version": "1", ...headers }, body });
    text = await response.text();
  } catch (error) {
    throw new TransientRequestError(`couldn't reach ${url}: ${error.cause?.code ?? error.cause?.message ?? error.message}`);
  }

  if (!response.ok) {
    const message = jsonError(text) || `${response.status} ${response.statusText} from ${url}`;
    let retryable;
    try { retryable = JSON.parse(text)?.retryable; } catch { /* Proxy errors may be HTML. */ }
    const transient = typeof retryable === "boolean" ? retryable : response.status >= 500 || RETRYABLE_STATUSES.has(response.status);
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

// An error response's message, when it's JSON with one. Proxies answer
// failures with HTML, which isn't an error from Testing Floor itself.
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
  const client = url.protocol === "https:" ? https : http;
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
    createReadStream(filePath, streamOptions({ start, end })).on("error", reject).pipe(request);
  });
}

function compactHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).filter(([, value]) => value !== undefined && value !== null && value !== "")
  );
}

function headerValue(headers, name) {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function streamOptions({ start, end }) {
  return compact({ start, end });
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

// The first token found: --token, TESTING_FLOOR_API_TOKEN, the config file,
// then the saved login. A saved login is only sent to the API URL that issued
// it, and the file is only read when nothing else supplies a token.
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

function resolveApiUrl(options, env) {
  return normalizeApiUrl(firstPresent(options.apiUrl, env.TESTING_FLOOR_API_URL, DEFAULT_API_URL));
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
  testingfloor login
  testingfloor whoami
  testingfloor logout
  testingfloor upload-build --organization-id gamedepartment --game-id 42 --platform windows --build-directory ./Builds/Windows --version 0.4.12 --launch-path Game.exe
  testingfloor upload-build --config testingfloor-builds.json
  testingfloor upload-map --organization-id gamedepartment --game-id 42 --level-id factory --image ./maps/factory.png --bounds 0,0,200,200
  testingfloor upload-map --config testingfloor-maps.json
  testingfloor upload-recording --playtest-id 123 --file ./gameplay.mp4 --tester-name "Playtester"
  testingfloor upload-recording --organization-id example-studio --game-id my-game --file ./recordings --tester-name "Playtester"
  testingfloor get-event-presentation --organization-id example-studio --game-id my-game
  testingfloor set-event-presentation --organization-id example-studio --game-id my-game --presentation event-presentation.json
  testingfloor get-telemetry-schema --organization-id example-studio --game-id my-game
  testingfloor set-telemetry-schema --organization-id example-studio --game-id my-game --schema telemetry-schema.json

Sign in:
  login                     Approve this computer in your browser and save its token
  whoami                    Show who is signed in, and for which API URL
  logout                    Delete the saved token from this computer
  --no-browser              Print the approval link without opening a browser (login)

  Commands use the first token they find: --token, TESTING_FLOOR_API_TOKEN,
  the config file's token, then the saved login. In CI, use an API token.

Environment:
  TESTING_FLOOR_API_TOKEN       API key (builds:create, maps:sync, or telemetry:configure scope)
  TESTING_FLOOR_API_URL         Defaults to ${DEFAULT_API_URL}
  TESTING_FLOOR_CONFIG_DIR      Folder for the saved login, defaults to ~/.config/testingfloor
                                ($XDG_CONFIG_HOME/testingfloor, or %APPDATA%\\testingfloor on Windows)
  TESTING_FLOOR_ORGANIZATION_ID Organization slug or numeric id
  TESTING_FLOOR_GAME_ID         Numeric game id
  TESTING_FLOOR_PLAYTEST_ID     Playtest for recording uploads
  TESTING_FLOOR_VERSION         Build version / map app_version metadata
  TESTING_FLOOR_BUILD_ID        Immutable artifact ID shared with the SDK and map
  TESTING_FLOOR_DESCRIPTION     Optional build description (up to 1000 characters)
  TESTING_FLOOR_MAP_VERSION     Telemetry map version number
  TESTING_FLOOR_GIT_SHA         Git SHA metadata (builds)

Build options:
  --platform <platform>     windows, macos, or linux
  --build-directory <path>  The ready-to-run build folder
  --archive <path>          An existing ZIP archive
  --idempotency-key <key>   Reuse for retries of the same CI upload; change for a new build
  --filename <name>         Name for the zip download, defaults to the folder name
  --version <version>       Version metadata
  --description <text>      Optional plain text, up to 1000 characters; website build list only
  --git-sha <sha>           Git SHA metadata
  --launch-path <path>      Executable path inside the build folder
  --launch-arg <arg>        Launch argument, repeatable
  --working-directory <dir> Working directory inside the build folder, defaults to "."
  --source-ref <key=value>  Source metadata, repeatable
  --source-ref-json <json>  Source metadata object

Map options:
  --level-id <id>           Level identifier the map belongs to
  --image <path>            PNG/JPG/WEBP image to upload
  --bounds <cx,cz,sx,sz>    World-space bounds: center_x,center_z,size_x,size_z
  --horizontal-axis <axis>  Horizontal world axis (x|y|z), defaults to x
  --vertical-axis <axis>    Vertical world axis (x|y|z), defaults to z
  --app-version <version>   Human-readable app version (legacy routing fallback)
  --corrects-map-id <id>     Explicitly correct a published map revision
  --correction-reason <text> Required reason for the correction
  --apply-to-history <bool>  true deliberately updates saved map selections; defaults to false
  --map-version <number>    Telemetry map version number to update
  --variant-key <key>       Variant key for floors, modes, or alternate map views
  --variant <key>           Alias for --variant-key
  --default-variant <bool>  Whether this variant is the default for the version
  --world-units-per-meter <n>
                            Override the game's world units per meter for this map.
                            Leave unset so the map uses the game's setting

Recording options:
  --file <path>            Video file, or folder of videos (searched recursively)
  --playtest-id <id>       Named playtest; otherwise use --organization-id and --game-id
  --tester-id <id>         Existing tester; or provide a name/email below
  --tester-name <name>     Who played (applies to every video in a folder)
  --tester-email <email>   Tester email, optionally with --tester-name
  --recorded-at <time>     ISO 8601 recording time, including timezone
  --written-feedback <text> Feedback from the tester
  --version <version>     Recorded game version
  --idempotency-key <key>  Optional batch key; change to intentionally import again

  Recording uploads require uploads:create. Run login again if an older
  saved login lacks it. Rerun the same command to resume without duplicates.

Telemetry schema options:
  --presentation <path>    JSON event styling (set-event-presentation)
  --schema <path>          JSON field mappings to apply (set-telemetry-schema)
  --mode <merge|replace>   Merge mappings by default; replace removes unspecified mappings

Common options:
  --build-id <id>           Immutable artifact ID for build/map uploads (also TESTING_FLOOR_BUILD_ID)
  --api-url <url>           Testing Floor base URL
  --token <token>           API token
  --organization-id <id>    Organization slug or numeric id
  --game-id <id>            Numeric Testing Floor game id
  --config, -c <path>       JSON config for builds, maps, or recording uploads
  --json                    Print only JSON results
`;
}
