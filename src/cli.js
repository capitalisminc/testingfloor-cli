import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, mkdtemp, opendir, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import process from "node:process";

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
  "archive-kind",
  "bounds",
  "branch",
  "butler-path",
  "config",
  "filename",
  "game-id",
  "git-sha",
  "horizontal-axis",
  "image",
  "launch-path",
  "level-id",
  "organization-id",
  "platform",
  "source-ref-json",
  "token",
  "version",
  "vertical-axis",
  "working-directory"
]);

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
  const maps = rawMaps.map((map) =>
    normalizeMap(map, { configDir, cwd, commonAppVersion: appVersion })
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

  const imageBytes = await readFile(map.imagePath);
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
  if (value === undefined || value === null || value === "") {
    throw new Error(`${name} is required.`);
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a finite number, got "${value}".`);
  }

  return parsed;
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

export async function uploadBuild(plan, build, { log = console.error } = {}) {
  if (build.archiveKind === "wharf") {
    return uploadWharfBuild(plan, build, { log });
  }

  const file = await fileInfo(build.archivePath);
  log(`Creating ${build.platform} build from ${build.archivePath}`);
  const hashes = await hashFile(build.archivePath);

  const createResponse = await postJson(gameApiUrl(plan, "/builds"), plan.token, {
    platform: build.platform,
    branch: build.branch,
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
  let multipartUpload = null;
  if (createResponse.multipart_upload) {
    multipartUpload = await uploadMultipartFile(
      createResponse.multipart_upload,
      build.archivePath,
      file.size,
      { log }
    );
  } else {
    await uploadFile(createResponse.upload_url, createResponse.upload_headers ?? {}, build.archivePath, file.size, {
      label: "Direct upload"
    });
  }

  log(`Completing build ${createResponse.id}`);
  const completeResponse = await postJson(
    `${plan.apiUrl}/api/game_builds/${createResponse.id}/complete`,
    plan.token,
    {
      signed_id: createResponse.signed_id,
      multipart_upload: multipartUpload
    }
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

async function uploadWharfBuild(plan, build, { log = console.error } = {}) {
  const source = await pathInfo(build.archivePath, { allowDirectory: true, label: "Build source" });
  log(`Creating ${build.platform} wharf patch from ${build.archivePath}`);

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "testingfloor-wharf-"));
  try {
    const base = await fetchWharfBase(plan, build);
    const targetSignaturePath = base.signatureUrl
      ? await downloadBaseSignature(base.signatureUrl, tempDir)
      : "/dev/null";
    const patchPath = path.join(tempDir, "patch.pwr");
    const signaturePath = `${patchPath}.sig`;

    await runButlerDiff({
      butlerPath: plan.butlerPath ?? "butler",
      target: targetSignaturePath,
      source: build.archivePath,
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

    return {
      buildId: completeResponse.id ?? createResponse.id,
      platform: build.platform,
      version: build.version,
      gitSha: build.gitSha,
      filename: build.filename,
      checksumSha256: completeResponse.checksum_sha256 ?? null,
      sizeBytes: source.size,
      status: completeResponse.status ?? "processing",
      readyAt: completeResponse.ready_at
    };
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

async function fetchWharfBase(plan, build) {
  const query = new URLSearchParams({ platform: build.platform });
  if (build.branch) {
    query.set("branch", build.branch);
  }
  const response = await getJson(
    gameApiUrl(plan, `/builds/wharf/base?${query.toString()}`),
    plan.token
  );
  return {
    buildId: response.build_id ?? response.buildId ?? null,
    signatureUrl: response.signature_url ?? response.signatureUrl ?? null
  };
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
    archive: options.archive,
    archiveKind: options.archiveKind,
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
  const archive = build.archive ?? build.path;
  const archiveKind = build.archiveKind ?? build.archive_kind ?? "zip";

  return {
    archivePath: archive ? resolveBuildPath(archive, build.fromConfig === false ? cwd : configDir) : null,
    archiveKind,
    branch: build.branch ?? commonBranch ?? undefined,
    filename: build.filename ?? defaultBuildFilename(archive, archiveKind),
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

function defaultBuildFilename(archive, archiveKind) {
  if (!archive) {
    return null;
  }

  const name = path.basename(archive);
  if (archiveKind === "wharf" && !path.extname(name)) {
    return `${name}.zip`;
  }
  return name;
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

    if (!["zip", "wharf"].includes(build.archiveKind)) {
      throw new Error(`Unsupported archive kind "${build.archiveKind}". Expected zip or wharf.`);
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

async function getJson(url, token) {
  const response = await fetch(url, {
    method: "GET",
    headers: { "Authorization": `Bearer ${token}` }
  });

  const text = await response.text();
  const parsed = text ? parseJsonResponse(text, url) : {};
  if (!response.ok) {
    throw new Error(parsed.error || `${response.status} ${response.statusText} from ${url}`);
  }

  return parsed;
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
  testingfloor upload-build --organization-id gamedepartment --game-id 42 --platform windows --archive ./game-windows.zip --version 0.4.12 --launch-path Game.exe
  testingfloor upload-build --config testingfloor-builds.json
  testingfloor upload-map --organization-id gamedepartment --game-id 42 --level-id factory --image ./maps/factory.png --bounds 0,0,200,200
  testingfloor upload-map --config testingfloor-maps.json

Environment:
  TESTING_FLOOR_API_TOKEN       API key (builds:create or maps:sync scope)
  TESTING_FLOOR_API_URL         Defaults to ${DEFAULT_API_URL}
  TESTING_FLOOR_ORGANIZATION_ID Organization slug or numeric id
  TESTING_FLOOR_GAME_ID         Numeric game id
  TESTING_FLOOR_VERSION         Build version / map app_version metadata
  TESTING_FLOOR_GIT_SHA         Git SHA metadata (builds)
  TESTING_FLOOR_BUTLER_PATH     Path to butler for wharf uploads

Build options:
  --platform <platform>     windows, macos, or linux
  --archive <path>          Zip file, wharf-readable archive, or build directory
  --archive-kind <kind>     zip or wharf, defaults to zip
  --butler-path <path>      Path to butler for wharf uploads
  --version <version>       Version metadata
  --git-sha <sha>           Git SHA metadata
  --launch-path <path>      Executable path inside the extracted archive
  --launch-arg <arg>        Launch argument, repeatable
  --working-directory <dir> Working directory inside the extracted archive, defaults to "."
  --source-ref <key=value>  Source metadata, repeatable
  --source-ref-json <json>  Source metadata object

Map options:
  --level-id <id>           Level identifier the map belongs to
  --image <path>            PNG/JPG/WEBP image to upload
  --bounds <cx,cz,sx,sz>    World-space bounds: center_x,center_z,size_x,size_z
  --horizontal-axis <axis>  Horizontal world axis (x|y|z), defaults to x
  --vertical-axis <axis>    Vertical world axis (x|y|z), defaults to z
  --app-version <version>   App version associated with this map snapshot

Common options:
  --api-url <url>           Testing Floor base URL
  --token <token>           API token
  --organization-id <id>    Organization slug or numeric id
  --game-id <id>            Numeric Testing Floor game id
  --config, -c <path>       JSON config with builds, platforms, or maps
  --json                    Print only JSON results
`;
}
