import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseJsonInput, readInputs, resolveActionBuild } from "../src/action-core.js";
import { normalizeConfiguredBuilds, parseArgs, parseSourceRefEntries, resolveUploadPlan } from "../src/cli.js";

test("parseArgs parses single build flags", () => {
  const parsed = parseArgs([
    "upload-build",
    "--game-id",
    "42",
    "--platform=windows",
    "--archive",
    "game.zip",
    "--version",
    "0.4.12",
    "--launch-path",
    "Game.exe",
    "--launch-arg",
    "-screen-fullscreen",
    "--launch-arg=0",
    "--source-ref",
    "run_id=123"
  ]);

  assert.equal(parsed.command, "upload-build");
  assert.equal(parsed.options.gameId, "42");
  assert.equal(parsed.options.platform, "windows");
  assert.deepEqual(parsed.options.launchArg, ["-screen-fullscreen", "0"]);
  assert.deepEqual(parsed.options.sourceRef, ["run_id=123"]);
});

test("normalizeConfiguredBuilds supports platforms object", () => {
  assert.deepEqual(
    normalizeConfiguredBuilds({
      platforms: {
        windows: { archive: "win.zip", launchPath: "Game.exe" },
        macos: { archive: "mac.zip", launchPath: "Game.app" }
      }
    }),
    [
      { platform: "windows", archive: "win.zip", launchPath: "Game.exe" },
      { platform: "macos", archive: "mac.zip", launchPath: "Game.app" }
    ]
  );
});

test("resolveUploadPlan builds single upload from flags and env", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "testingfloor-cli-"));
  await writeFile(path.join(cwd, "game.zip"), "zip bytes");

  const plan = await resolveUploadPlan(
    {
      archive: "game.zip",
      gameId: "42",
      launchArg: ["--safe"],
      launchPath: "Game.exe",
      platform: "windows",
      sourceRef: ["run_id=123"],
      version: "0.4.12"
    },
    {
      TESTING_FLOOR_API_TOKEN: "tf_test",
      TESTING_FLOOR_API_URL: "https://tf.test/",
      GITHUB_SHA: "abc123"
    },
    cwd
  );

  assert.equal(plan.apiUrl, "https://tf.test");
  assert.equal(plan.gameId, "42");
  assert.equal(plan.token, "tf_test");
  assert.equal(plan.builds.length, 1);
  assert.equal(plan.builds[0].archivePath, path.join(cwd, "game.zip"));
  assert.equal(plan.builds[0].gitSha, "abc123");
  assert.deepEqual(plan.builds[0].launchArgs, ["--safe"]);
  assert.deepEqual(plan.builds[0].sourceRef, { run_id: "123" });
});

test("resolveUploadPlan supports config builds relative to config file", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "testingfloor-cli-"));
  const configDir = path.join(cwd, "ci");
  await writeFile(path.join(cwd, "game-windows.zip"), "zip bytes");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(configDir));
  await writeFile(
    path.join(configDir, "testingfloor-builds.json"),
    JSON.stringify({
      gameId: 42,
      version: "0.4.12",
      builds: [
        {
          platform: "windows",
          archive: "../game-windows.zip",
          launchPath: "Game.exe"
        }
      ]
    })
  );

  const plan = await resolveUploadPlan(
    { config: path.join(configDir, "testingfloor-builds.json") },
    { TESTING_FLOOR_API_TOKEN: "tf_test" },
    cwd
  );

  assert.equal(plan.builds[0].archivePath, path.join(cwd, "game-windows.zip"));
});

test("parseSourceRefEntries rejects malformed entries", () => {
  assert.throws(() => parseSourceRefEntries(["missing-separator"]), /key=value/);
});

test("resolveActionBuild accepts explicit platform launch metadata and build directory", () => {
  const build = resolveActionBuild(
    {
      buildDirectory: "build/Mono/Release/StandaloneWindows64",
      launchArgs: [],
      launchPath: "Game.exe",
      platform: "windows",
      sourceRef: {},
      version: "0.4.12",
      workingDirectory: "."
    },
    "/repo",
    {}
  );

  assert.equal(build.buildDirectory, "/repo/build/Mono/Release/StandaloneWindows64");
  assert.equal(build.filename, "build-windows-0.4.12.zip");
  assert.equal(build.launchPath, "Game.exe");
  assert.equal(build.platform, "windows");
});

test("readInputs accepts GitHub's hyphenated action input environment names", () => {
  const inputs = readInputs({
    "INPUT_API-TOKEN": "tf_builds",
    "INPUT_GAME-ID": "42",
    INPUT_PLATFORM: "windows",
    "INPUT_BUILD-DIRECTORY": "build/Mono/Release/StandaloneWindows64",
    "INPUT_LAUNCH-PATH": "Game.exe",
    INPUT_VERSION: "0.4.12",
    "INPUT_SOURCE-REF": "{\"run_id\":\"123\"}",
    "INPUT_LAUNCH-ARGS": "[\"--safe\"]"
  });

  assert.equal(inputs.apiToken, "tf_builds");
  assert.equal(inputs.gameId, "42");
  assert.equal(inputs.buildDirectory, "build/Mono/Release/StandaloneWindows64");
  assert.equal(inputs.launchPath, "Game.exe");
  assert.deepEqual(inputs.launchArgs, ["--safe"]);
  assert.deepEqual(inputs.sourceRef, { run_id: "123" });
});

test("parseJsonInput validates action JSON inputs", () => {
  assert.deepEqual(parseJsonInput("[\"--safe\"]", "launch-args"), ["--safe"]);
  assert.deepEqual(parseJsonInput("{\"run_id\":\"123\"}", "source-ref"), { run_id: "123" });
  assert.throws(() => parseJsonInput("{}", "launch-args"), /JSON array/);
  assert.throws(() => parseJsonInput("[]", "source-ref"), /JSON object/);
});
