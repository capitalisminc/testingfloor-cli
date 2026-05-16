import { createReadStream, createWriteStream } from "node:fs";
import { access, chmod, lstat, mkdir, opendir, readlink, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { finished } from "node:stream/promises";

import { addPath } from "@actions/core";
import { cacheFile, downloadTool, extractZip, find as findTool } from "@actions/tool-cache";
import ZipStream from "zip-stream";
import { input, requiredInput, writeOutput } from "./action-io.js";
import { resolveUploadPlan, uploadBuild } from "./cli.js";

export { input, requiredInput, writeOutput } from "./action-io.js";

const BUTLER_TOOL_NAME = "butler";

export async function runAction(env = process.env, cwd = process.cwd()) {
  const inputs = readInputs(env);
  const build = resolveActionBuild(inputs, cwd, env);
  const butlerPath = await resolveActionButlerPath({
    archiveKind: build.archiveKind,
    butlerPath: inputs.butlerPath,
    butlerVersion: inputs.butlerVersion,
    env
  });
  const archivePath = build.archivePath ?? (
    build.archiveKind === "wharf"
      ? build.buildDirectory
      : await zipBuildDirectory({
        buildDirectory: build.buildDirectory,
        archiveName: build.filename,
        runnerTemp: env.RUNNER_TEMP ?? os.tmpdir()
      })
  );

  const plan = await resolveUploadPlan(
    {
      apiUrl: inputs.apiUrl,
      archive: archivePath,
      archiveKind: inputs.archiveKind,
      branch: inputs.branch,
      butlerPath,
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

export function readInputs(env) {
  return {
    apiToken: requiredInput(env, "api-token"),
    apiUrl: input(env, "api-url") || "https://api.testingfloor.com",
    archive: input(env, "archive"),
    archiveKind: input(env, "archive-kind") || "zip",
    branch: input(env, "branch") || undefined,
    butlerPath: input(env, "butler-path"),
    butlerVersion: input(env, "butler-version") || "LATEST",
    buildDirectory: input(env, "build-directory"),
    filename: input(env, "filename"),
    gameId: requiredInput(env, "game-id"),
    gitSha: input(env, "git-sha"),
    launchArgs: parseJsonInput(input(env, "launch-args") || "[]", "launch-args"),
    launchPath: requiredInput(env, "launch-path"),
    organizationId: input(env, "organization-id") || undefined,
    platform: requiredInput(env, "platform"),
    sourceRef: parseJsonInput(input(env, "source-ref") || "{}", "source-ref"),
    version: requiredInput(env, "version"),
    workingDirectory: input(env, "working-directory") || "."
  };
}

export async function resolveActionButlerPath({
  archiveKind,
  butlerPath,
  butlerVersion = "LATEST",
  env = process.env,
  setup = setupButler
} = {}) {
  if (archiveKind !== "wharf") {
    return butlerPath;
  }

  if (butlerPath) {
    return butlerPath;
  }

  if (env.TESTING_FLOOR_BUTLER_PATH) {
    return env.TESTING_FLOOR_BUTLER_PATH;
  }

  if (env.GITHUB_ACTIONS !== "true") {
    return BUTLER_TOOL_NAME;
  }

  return setup({ version: butlerVersion });
}

export async function setupButler({ version = "LATEST", log = console.error } = {}) {
  const binaryName = butlerBinaryName();
  const cacheable = isCacheableButlerVersion(version);
  let toolDir = cacheable ? findTool(BUTLER_TOOL_NAME, version) : "";

  if (!toolDir) {
    log(`Installing butler ${version} for wharf upload`);
    const downloadPath = await downloadTool(butlerDownloadUrl({ version }));
    const extractedDir = await extractZip(downloadPath);
    const extractedBinary = path.join(extractedDir, binaryName);
    await chmod(extractedBinary, 0o755).catch(() => {});

    toolDir = cacheable
      ? await cacheFile(extractedBinary, binaryName, BUTLER_TOOL_NAME, version)
      : extractedDir;
  }

  addPath(toolDir);
  return path.join(toolDir, binaryName);
}

export function butlerDownloadUrl({ platform = os.platform(), arch = os.arch(), version = "LATEST" } = {}) {
  return `https://broth.itch.zone/butler/${butlerPlatform(platform)}-${butlerArch(arch, platform)}/${version}/archive/default`;
}

export function butlerBinaryName(platform = os.platform()) {
  return platform === "win32" ? "butler.exe" : "butler";
}

function butlerPlatform(platform = os.platform()) {
  if (platform === "win32") {
    return "windows";
  }
  if (platform === "darwin" || platform === "linux") {
    return platform;
  }
  throw new Error(`Unsupported butler platform: ${platform}`);
}

function butlerArch(arch = os.arch(), platform = os.platform()) {
  if (arch === "x64") {
    return "amd64";
  }
  if (arch === "arm64") {
    return platform === "win32" ? "amd64" : "arm64";
  }
  if (arch === "arm" || arch === "ia32") {
    return "386";
  }
  throw new Error(`Unsupported butler architecture: ${arch}`);
}

function isCacheableButlerVersion(version) {
  return /^\d+\.\d+\.\d+/.test(version);
}

export function resolveActionBuild(inputs, cwd = process.cwd(), env = process.env) {
  if (!inputs.archive && !inputs.buildDirectory) {
    throw new Error("Set either archive or build-directory.");
  }

  const archivePath = inputs.archive ? path.resolve(cwd, inputs.archive) : null;
  const buildDirectory = inputs.buildDirectory ? path.resolve(cwd, inputs.buildDirectory) : null;
  const filename = inputs.filename ||
    (archivePath ? path.basename(archivePath) : defaultArchiveName({ env, inputs }));

  return {
    archivePath,
    buildDirectory,
    filename,
    archiveKind: inputs.archiveKind,
    launchArgs: inputs.launchArgs,
    launchPath: inputs.launchPath,
    platform: inputs.platform
  };
}

export function parseJsonInput(raw, name) {
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

export async function zipBuildDirectory({ buildDirectory, archiveName, runnerTemp = os.tmpdir() }) {
  const directory = path.resolve(buildDirectory);
  const stats = await stat(directory).catch(() => null);
  if (!stats?.isDirectory()) {
    throw new Error(`Build directory not found: ${directory}`);
  }

  await mkdir(runnerTemp, { recursive: true });
  const archivePath = path.join(runnerTemp, archiveName);

  await createZipArchive({ directory, archivePath });
  await access(archivePath);
  return archivePath;
}

async function createZipArchive({ directory, archivePath }) {
  const archive = new ZipStream({ forceZip64: true, zlib: { level: 6 } });
  const output = createWriteStream(archivePath);
  archive.pipe(output);

  const archiveDone = finished(archive);
  const outputDone = finished(output);

  try {
    for await (const entry of walkArchiveEntries(directory)) {
      if (entry.type === "directory") {
        await addZipEntry(archive, Buffer.alloc(0), {
          date: entry.stats.mtime,
          mode: entry.stats.mode,
          name: entry.name,
          type: "directory"
        });
      } else if (entry.type === "symlink") {
        await addZipEntry(archive, entry.linkname, {
          date: entry.stats.mtime,
          mode: entry.stats.mode,
          name: entry.name,
          type: "symlink"
        });
      } else {
        await addZipEntry(archive, createReadStream(entry.fullPath), {
          date: entry.stats.mtime,
          mode: entry.stats.mode,
          name: entry.name
        });
      }
    }

    archive.finish();
    await Promise.all([archiveDone, outputDone]);
  } catch (error) {
    archive.destroy(error);
    output.destroy(error);
    await Promise.allSettled([archiveDone, outputDone]);
    throw error;
  }
}

async function* walkArchiveEntries(root, current = root) {
  const directory = await opendir(current);

  for await (const dirent of directory) {
    const fullPath = path.join(current, dirent.name);
    const stats = await lstat(fullPath);
    const name = normalizeZipPath(path.relative(root, fullPath));

    if (stats.isDirectory()) {
      yield { fullPath, name: `${name}/`, stats, type: "directory" };
      yield* walkArchiveEntries(root, fullPath);
    } else if (stats.isSymbolicLink()) {
      yield { fullPath, linkname: await readlink(fullPath), name, stats, type: "symlink" };
    } else if (stats.isFile()) {
      yield { fullPath, name, stats, type: "file" };
    }
  }
}

function addZipEntry(archive, source, data) {
  return new Promise((resolve, reject) => {
    archive.entry(source, data, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function normalizeZipPath(value) {
  return value.split(path.sep).join("/");
}

function defaultArchiveName({ env, inputs }) {
  const version = inputs.version || env.GITHUB_SHA || "build";
  return `build-${inputs.platform}-${version}.zip`;
}
