import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, mkdtemp, opendir, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { chunkBuildDirectory, readObject } from "./chunks.js";

const DEFAULT_API_URL = "https://api.testingfloor.com";
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
  "archive",
  "bounds",
  "branch",
  "build-directory",
  "butler-path",
  "config",
  "filename",
  "game-id",
  "git-sha",
  "horizontal-axis",
  "image",
  "launch-path",
  "level-id",
  "map-version",
  "organization-id",
  "platform",
  "source-ref-json",
  "token",
  "default-variant",
  "variant",
  "variant-key",
  "version",
  "vertical-axis",
  "working-directory"
]);
const REMOVED_OPTIONS = {
  "archive-kind": "--archive-kind was removed. Uploads always send the build directory as chunks for zip downloads, plus a wharf patch for the recorder."
};

export async function main(argv = process.argv.slice(2), env = process.env, cwd = process.cwd()) {
  const parsed = parseArgs(argv);

  if (parsed.help || parsed.command === "help" || !parsed.command) {
    process.stdout.write(helpText());
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

  throw new Error(`Unknown command "${parsed.command}". Run "testingfloor help".`);
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
  const token = firstPresent(options.token, env.TESTING_FLOOR_API_TOKEN, config.token);
  const organizationId = firstPresent(
    options.organizationId,
    env.TESTING_FLOOR_ORGANIZATION_ID,
    config.organizationId,
    config.organization_id
  );
  const butlerPath = firstPresent(
    options.butlerPath,
    env.TESTING_FLOOR_BUTLER_PATH,
    config.butlerPath,
    config.butler_path,
    "butler"
  );
  const gameId = firstPresent(options.gameId, env.TESTING_FLOOR_GAME_ID, config.gameId);
  const version = firstPresent(options.version, env.TESTING_FLOOR_VERSION, config.version);
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
      commonGitSha: gitSha,
      commonSourceRef: sourceRef,
      commonBranch: branch
    })
  );

  validatePlan({ apiUrl, token, organizationId, gameId, builds });

  return {
    apiUrl,
    butlerPath,
    token,
    organizationId: String(organizationId),
    gameId: String(gameId),
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
      options.defaultVariant
  );
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
  const mapVersion = firstPresent(
    options.mapVersion,
    env.TESTING_FLOOR_MAP_VERSION,
    config.mapVersion,
    config.map_version
  );

  const rawMaps = cliMapRequested ? [mapFromOptions(options)] : configuredMaps;
  const maps = rawMaps.map((map) =>
    normalizeMap(map, { configDir, cwd, commonAppVersion: appVersion, commonMapVersion: mapVersion })
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
    variant_key: map.variantKey || undefined,
    version: map.version || undefined,
    default_variant:
      map.defaultVariant === null || map.defaultVariant === undefined ? undefined : map.defaultVariant,
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
    defaultVariant: options.defaultVariant
  };
}

function normalizeMap(map, { configDir, cwd, commonAppVersion, commonMapVersion }) {
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
    variantKey: optionalString(map.variantKey ?? map.variant_key ?? map.variant),
    version: optionalPositiveInteger(map.mapVersion ?? map.map_version ?? map.version ?? commonMapVersion, "map.version"),
    defaultVariant: optionalBoolean(map.defaultVariant ?? map.default_variant, "map.defaultVariant")
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

  if (!plan.gameId || !/^[A-Za-z0-9_-]+$/.test(String(plan.gameId))) {
    throw new Error("Missing game id. Set gameId in config or pass --game-id. Accepts numeric id or game key (e.g. \"crux\").");
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
  if (value === undefined || value === null || value === "") {
    throw new Error(`${name} is required.`);
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a finite number, got "${value}".`);
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

// Every build goes up the same way: a wharf patch the recorder installs from,
// then the folder as content-addressed chunks plus a manifest, which Testing
// Floor's build-delivery Worker streams as the zip download. Only chunks the
// game hasn't stored before are uploaded.
export async function uploadBuild(plan, build, { log = console.error, pollIntervalMs, retryDelaysMs = REQUEST_RETRY_DELAYS_MS } = {}) {
  const source = await pathInfo(build.buildDirectory, { allowDirectory: true, label: "Build directory" });
  if (!(await stat(build.buildDirectory)).isDirectory()) {
    throw new Error(`Build directory must be a folder, not a file: ${build.buildDirectory}`);
  }
  log(`Creating ${build.platform} wharf patch from ${build.buildDirectory}`);

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "testingfloor-wharf-"));
  try {
    const base = await fetchWharfBase(plan, build, { retryDelaysMs });
    const targetSignaturePath = base.signatureUrl
      ? await downloadBaseSignature(base.signatureUrl, tempDir)
      : "/dev/null";
    const patchPath = path.join(tempDir, "patch.pwr");
    const signaturePath = `${patchPath}.sig`;

    await runButlerDiff({
      butlerPath: plan.butlerPath ?? "butler",
      target: targetSignaturePath,
      source: build.buildDirectory,
      patchPath
    });

    const patch = await fileInfo(patchPath);
    const signature = await fileInfo(signaturePath);
    const patchHashes = await hashFile(patchPath);
    const signatureHashes = await hashFile(signaturePath);

    const createResponse = await postJson(gameApiUrl(plan, "/builds"), plan.token, {
      platform: build.platform,
      branch: build.branch,
      version: build.version,
      git_sha: build.gitSha,
      archive_kind: "wharf",
      zip_delivery: "chunk_manifest",
      filename: build.filename,
      byte_size: source.size,
      wharf_patch_from_build_id: base.buildId ?? undefined,
      patch_byte_size: patch.size,
      patch_checksum_md5: patchHashes.md5Base64,
      signature_byte_size: signature.size,
      signature_checksum_md5: signatureHashes.md5Base64,
      launch_path: build.launchPath,
      launch_args: build.launchArgs,
      working_directory: build.workingDirectory,
      source_ref: build.sourceRef
    });

    const uploads = createResponse.uploads ?? {};
    log(`Uploading wharf signature (${formatBytes(signature.size)}) to build ${createResponse.id}`);
    const signatureMultipart = await uploadArtifact(uploads.signature, signaturePath, signature.size, {
      label: "Wharf signature",
      log
    });
    log(`Uploading wharf patch (${formatBytes(patch.size)}) to build ${createResponse.id}`);
    const patchMultipart = await uploadArtifact(uploads.patch, patchPath, patch.size, {
      label: "Wharf patch",
      log
    });

    log(`Completing build ${createResponse.id}`);
    const completeResponse = await postJson(
      `${plan.apiUrl}/api/game_builds/${createResponse.id}/complete`,
      plan.token,
      {
        patch_signed_id: uploads.patch?.signed_id,
        signature_signed_id: uploads.signature?.signed_id,
        patch_multipart_upload: patchMultipart ?? undefined,
        signature_multipart_upload: signatureMultipart ?? undefined
      }
    );

    const buildId = completeResponse.id ?? createResponse.id;
    const manifest = await uploadChunkManifest(plan, buildId, build.buildDirectory, { log, pollIntervalMs, retryDelaysMs });

    return {
      buildId,
      platform: build.platform,
      version: build.version,
      gitSha: build.gitSha,
      filename: build.filename,
      checksumSha256: completeResponse.checksum_sha256 ?? null,
      sizeBytes: source.size,
      status: completeResponse.status ?? "processing",
      readyAt: completeResponse.ready_at,
      zipSizeBytes: manifest.zip_size_bytes ?? null
    };
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

async function fetchWharfBase(plan, build, { retryDelaysMs }) {
  const query = new URLSearchParams({ platform: build.platform });
  if (build.branch) {
    query.set("branch", build.branch);
  }
  query.set("zip_delivery", "chunk_manifest");
  const response = await getJson(
    gameApiUrl(plan, `/builds/wharf/base?${query.toString()}`),
    plan.token,
    { retryDelaysMs }
  );
  return {
    buildId: response.build_id ?? response.buildId ?? null,
    signatureUrl: response.signature_url ?? response.signatureUrl ?? null
  };
}

const CHUNK_ANNOUNCE_BATCH = 1000;
const CHUNK_UPLOAD_CONCURRENCY = 8;
const MANIFEST_VERIFY_TIMEOUT_MS = 45 * 60 * 1000;

// Uploads the build folder as chunks plus a manifest, then waits until
// Testing Floor has verified every chunk and file checksum. Only chunks the
// game hasn't stored before are uploaded.
async function uploadChunkManifest(plan, buildId, buildDirectory, { log, pollIntervalMs = 5000, retryDelaysMs }) {
  log(`Splitting ${buildDirectory} into chunks for zip downloads`);
  const { entries, objects } = await chunkBuildDirectory(buildDirectory);
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

async function downloadBaseSignature(signatureUrl, tempDir) {
  const response = await fetch(signatureUrl);
  if (!response.ok) {
    throw new Error(`Base signature download failed with ${response.status}: ${await response.text()}`);
  }

  const signaturePath = path.join(tempDir, "base.pwr.sig");
  await writeFile(signaturePath, Buffer.from(await response.arrayBuffer()));
  return signaturePath;
}

function runButlerDiff({ butlerPath, target, source, patchPath }) {
  return new Promise((resolve, reject) => {
    const child = spawn(butlerPath, ["diff", target, source, patchPath], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error((stderr || stdout || `butler diff exited with ${code}`).trim()));
    });
  });
}

async function uploadArtifact(uploadSpec, filePath, size, { label, log }) {
  if (!uploadSpec) {
    throw new Error(`${label} upload response is missing.`);
  }

  if (uploadSpec.multipart_upload) {
    return uploadMultipartFile(uploadSpec.multipart_upload, filePath, size, { log });
  }

  await uploadFile(uploadSpec.upload_url, uploadSpec.upload_headers ?? {}, filePath, size, { label });
  return null;
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

function normalizeBuild(build, { configDir, cwd, commonVersion, commonGitSha, commonSourceRef, commonBranch }) {
  // archive and path are older names for the same folder.
  const directory = build.buildDirectory ?? build.build_directory ?? build.archive ?? build.path;

  return {
    buildDirectory: directory ? resolveBuildPath(directory, build.fromConfig === false ? cwd : configDir) : null,
    branch: build.branch ?? commonBranch ?? undefined,
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
  if (!plan.token) {
    throw new Error("Missing API token. Set TESTING_FLOOR_API_TOKEN or pass --token.");
  }

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

// POSTs don't retry unless the caller passes retryDelaysMs: only some are
// safe to repeat (creating a build twice makes two builds).
async function postJson(url, token, body, { retryDelaysMs = [] } = {}) {
  return withRequestRetries(retryDelaysMs, () =>
    requestJson(url, token, {
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

async function uploadMultipartFile(multipartUpload, filePath, size, { log = console.error } = {}) {
  const uploadId = multipartUpload.upload_id ?? multipartUpload.uploadId;
  const partSize = Number(multipartUpload.part_size ?? multipartUpload.partSize);
  const parts = multipartUpload.parts ?? [];

  if (!uploadId) {
    throw new Error("Multipart upload response is missing upload_id.");
  }

  if (!Number.isSafeInteger(partSize) || partSize <= 0) {
    throw new Error("Multipart upload response has an invalid part_size.");
  }

  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error("Multipart upload response is missing parts.");
  }

  const completedParts = [];
  for (const part of parts) {
    const partNumber = Number(part.part_number ?? part.partNumber);
    if (!Number.isSafeInteger(partNumber) || partNumber <= 0) {
      throw new Error("Multipart upload response has an invalid part number.");
    }

    const start = (partNumber - 1) * partSize;
    const end = Math.min(start + partSize, size) - 1;
    if (start >= size || end < start) {
      throw new Error(`Multipart part ${partNumber} is outside the archive size.`);
    }

    const partLength = end - start + 1;
    log(`Uploading part ${partNumber}/${parts.length} (${formatBytes(partLength)})`);
    const headers = await uploadFile(part.upload_url ?? part.uploadUrl, part.upload_headers ?? {}, filePath, partLength, {
      end,
      label: `Multipart part ${partNumber}`,
      start
    });
    const etag = headerValue(headers, "etag");
    if (!etag) {
      throw new Error(`Multipart part ${partNumber} did not return an ETag.`);
    }

    completedParts.push({ part_number: partNumber, etag });
  }

  return {
    upload_id: uploadId,
    parts: completedParts.sort((left, right) => left.part_number - right.part_number)
  };
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
  testingfloor upload-build --organization-id gamedepartment --game-id 42 --platform windows --build-directory ./Builds/Windows --version 0.4.12 --launch-path Game.exe
  testingfloor upload-build --config testingfloor-builds.json
  testingfloor upload-map --organization-id gamedepartment --game-id 42 --level-id factory --image ./maps/factory.png --bounds 0,0,200,200
  testingfloor upload-map --config testingfloor-maps.json

Environment:
  TESTING_FLOOR_API_TOKEN       API key (builds:create or maps:sync scope)
  TESTING_FLOOR_API_URL         Defaults to ${DEFAULT_API_URL}
  TESTING_FLOOR_ORGANIZATION_ID Organization slug or numeric id
  TESTING_FLOOR_GAME_ID         Numeric game id
  TESTING_FLOOR_VERSION         Build version / map app_version metadata
  TESTING_FLOOR_MAP_VERSION     Telemetry map version number
  TESTING_FLOOR_GIT_SHA         Git SHA metadata (builds)
  TESTING_FLOOR_BUTLER_PATH     Path to butler (makes the recorder's patch)

Build options:
  --platform <platform>     windows, macos, or linux
  --build-directory <path>  The ready-to-run build folder
  --filename <name>         Name for the zip download, defaults to the folder name
  --butler-path <path>      Path to butler (makes the recorder's patch)
  --version <version>       Version metadata
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
  --app-version <version>   App version associated with this map snapshot
  --map-version <number>    Telemetry map version number to update
  --variant-key <key>       Variant key for floors, modes, or alternate map views
  --variant <key>           Alias for --variant-key
  --default-variant <bool>  Whether this variant is the default for the version

Common options:
  --api-url <url>           Testing Floor base URL
  --token <token>           API token
  --organization-id <id>    Organization slug or numeric id
  --game-id <id>            Numeric Testing Floor game id
  --config, -c <path>       JSON config with builds, platforms, or maps
  --json                    Print only JSON results
`;
}
