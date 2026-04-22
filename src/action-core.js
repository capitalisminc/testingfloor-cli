import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { access, mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

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

  if (process.platform === "win32") {
    await zipWithPowerShell(directory, archivePath);
  } else {
    await zipWithZip(directory, archivePath);
  }

  await access(archivePath);
  return archivePath;
}

function zipWithPowerShell(directory, archivePath) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Remove-Item -Force $env:TF_ARCHIVE_PATH -ErrorAction SilentlyContinue",
    "Compress-Archive -Path (Join-Path $env:TF_BUILD_DIR '*') -DestinationPath $env:TF_ARCHIVE_PATH -Force"
  ].join("; ");

  return runFirstAvailable([
    { command: "pwsh", args: ["-NoProfile", "-NonInteractive", "-Command", script] },
    { command: "powershell", args: ["-NoProfile", "-NonInteractive", "-Command", script] }
  ], {
    ...process.env,
    TF_ARCHIVE_PATH: archivePath,
    TF_BUILD_DIR: directory
  });
}

function zipWithZip(directory, archivePath) {
  return runCommand("zip", ["-qr", archivePath, "."], { cwd: directory });
}

function runFirstAvailable(commands, env) {
  return new Promise((resolve, reject) => {
    const tryNext = (index) => {
      const spec = commands[index];
      if (!spec) {
        reject(new Error("PowerShell is required to zip builds on Windows."));
        return;
      }

      runCommand(spec.command, spec.args, { env })
        .then(resolve)
        .catch((error) => {
          if (error.code === "ENOENT") {
            tryNext(index + 1);
          } else {
            reject(error);
          }
        });
    };

    tryNext(0);
  });
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: "inherit"
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with ${code}`));
      }
    });
  });
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
