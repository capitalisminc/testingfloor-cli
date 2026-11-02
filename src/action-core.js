import path from "node:path";
import process from "node:process";

import { input, requiredInput, writeOutput } from "./action-io.js";
import { resolveUploadPlan, uploadBuild } from "./cli.js";

export { input, requiredInput, writeOutput } from "./action-io.js";

export async function runAction(env = process.env, cwd = process.cwd()) {
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

// archive-kind is still declared (deprecated) so old workflows only get a
// warning; its value no longer matters.
export function readInputs(env) {
  if (input(env, "archive")) {
    throw new Error("The archive input was removed. Set build-directory to the unzipped build folder.");
  }

  return {
    apiToken: requiredInput(env, "api-token"),
    apiUrl: input(env, "api-url") || "https://api.testingfloor.com",
    branch: input(env, "branch") || undefined,
    buildDirectory: requiredInput(env, "build-directory"),
    description: input(env, "description") ?? undefined,
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

export function resolveActionBuild(inputs, cwd = process.cwd(), env = process.env) {
  if (!inputs.buildDirectory) {
    throw new Error("Set build-directory.");
  }

  return {
    buildDirectory: path.resolve(cwd, inputs.buildDirectory),
    filename: inputs.filename || defaultArchiveName({ env, inputs }),
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

function defaultArchiveName({ env, inputs }) {
  const version = inputs.version || env.GITHUB_SHA || "build";
  return `build-${inputs.platform}-${version}.zip`;
}
