import { appendFileSync, createReadStream, createWriteStream } from "node:fs";
import { access, lstat, mkdir, opendir, readlink, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { finished } from "node:stream/promises";

import ZipStream from "zip-stream";
import { resolveUploadPlan, uploadBuild } from "./cli.js";

export async function runAction(env = process.env, cwd = process.cwd()) {
  const inputs = readInputs(env);
  const build = resolveActionBuild(inputs, cwd, env);
  const archivePath = build.archivePath ?? await zipBuildDirectory({
    buildDirectory: build.buildDirectory,
    archiveName: build.filename,
    runnerTemp: env.RUNNER_TEMP ?? os.tmpdir()
  });

  const plan = await resolveUploadPlan(
    {
      apiUrl: inputs.apiUrl,
      archive: archivePath,
      filename: build.filename,
      gameId: inputs.gameId,
      gitSha: inputs.gitSha,
      launchArg: build.launchArgs,
      launchPath: build.launchPath,
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
    apiUrl: input(env, "api-url") || "https://testingfloor.com",
    archive: input(env, "archive"),
    buildDirectory: input(env, "build-directory"),
    filename: input(env, "filename"),
    gameId: requiredInput(env, "game-id"),
    gitSha: input(env, "git-sha"),
    launchArgs: parseJsonInput(input(env, "launch-args") || "[]", "launch-args"),
    launchPath: requiredInput(env, "launch-path"),
    platform: requiredInput(env, "platform"),
    sourceRef: parseJsonInput(input(env, "source-ref") || "{}", "source-ref"),
    version: requiredInput(env, "version"),
    workingDirectory: input(env, "working-directory") || "."
  };
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

function input(env, name) {
  const actionName = `INPUT_${name.replaceAll(" ", "_").toUpperCase()}`;
  const shellName = `INPUT_${name.toUpperCase().replaceAll("-", "_")}`;
  const value = env[actionName] ?? env[shellName];
  return value === undefined || value === "" ? null : value;
}

function requiredInput(env, name) {
  const value = input(env, name);
  if (!value) {
    throw new Error(`Missing required input: ${name}`);
  }

  return value;
}

function writeOutput(name, value, env) {
  if (value === undefined || value === null) {
    return;
  }

  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
    return;
  }

  process.stdout.write(`${name}=${value}\n`);
}
