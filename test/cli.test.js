import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseJsonInput, readInputs, resolveActionBuild, zipBuildDirectory } from "../src/action-core.js";
import { normalizeConfiguredBuilds, parseArgs, parseSourceRefEntries, resolveUploadPlan, uploadBuild } from "../src/cli.js";

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

test("zipBuildDirectory creates a ZIP64 archive from a build directory", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "testingfloor-cli-"));
  const buildDirectory = path.join(cwd, "build");
  const runnerTemp = path.join(cwd, "tmp");
  const archivePath = path.join(runnerTemp, "game.zip");
  await mkdir(path.join(buildDirectory, "Data"), { recursive: true });
  await writeFile(path.join(buildDirectory, "Game.exe"), "binary");
  await writeFile(path.join(buildDirectory, "Data", "config.json"), "{\"quality\":\"test\"}");

  const result = await zipBuildDirectory({
    archiveName: "game.zip",
    buildDirectory,
    runnerTemp
  });
  const archive = await readFile(archivePath);

  assert.equal(result, archivePath);
  assert.equal(archive.subarray(0, 4).toString("hex"), "504b0304");
  assert.notEqual(archive.indexOf(Buffer.from("Game.exe")), -1);
  assert.notEqual(archive.indexOf(Buffer.from("Data/config.json")), -1);
  assert.notEqual(archive.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06])), -1);
  assert.notEqual(archive.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07])), -1);
});

test("uploadBuild uploads multipart parts and completes with ETags", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "testingfloor-cli-"));
  const archivePath = path.join(cwd, "game.zip");
  await writeFile(archivePath, "abcdefghij");

  const uploads = [];
  let completePayload = null;
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === "POST" && request.url === "/api/games/42/builds") {
        const body = JSON.parse(await readRequestBody(request));
        assert.equal(body.byte_size, 10);
        assert.equal(body.filename, "game.zip");
        writeJson(response, 201, {
          id: 7,
          signed_id: "signed-blob",
          upload_strategy: "multipart",
          multipart_upload: {
            upload_id: "upload-123",
            part_size: 4,
            parts: [
              { part_number: 1, upload_url: `${serverUrl(server)}/parts/1`, upload_headers: { "x-part": "1" } },
              { part_number: 2, upload_url: `${serverUrl(server)}/parts/2`, upload_headers: { "x-part": "2" } },
              { part_number: 3, upload_url: `${serverUrl(server)}/parts/3`, upload_headers: { "x-part": "3" } }
            ]
          }
        });
        return;
      }

      if (request.method === "PUT" && request.url?.startsWith("/parts/")) {
        const partNumber = Number(request.url.split("/").pop());
        uploads.push({
          body: await readRequestBody(request),
          contentLength: request.headers["content-length"],
          partNumber,
          xPart: request.headers["x-part"]
        });
        response.writeHead(200, { ETag: `"etag-${partNumber}"` });
        response.end();
        return;
      }

      if (request.method === "POST" && request.url === "/api/game_builds/7/complete") {
        completePayload = JSON.parse(await readRequestBody(request));
        writeJson(response, 200, {
          id: 7,
          status: "ready",
          ready_at: "2026-04-22T12:00:00Z"
        });
        return;
      }

      response.writeHead(404);
      response.end();
    } catch (error) {
      response.writeHead(500);
      response.end(error.stack);
    }
  });
  await listen(server);
  t.after(() => server.close());

  const result = await uploadBuild(
    { apiUrl: serverUrl(server), gameId: "42", token: "tf_test" },
    {
      archiveKind: "zip",
      archivePath,
      filename: "game.zip",
      gitSha: "abc123",
      launchArgs: [],
      launchPath: "Game.exe",
      platform: "windows",
      sourceRef: {},
      version: "0.4.12",
      workingDirectory: "."
    },
    { log: () => {} }
  );

  assert.equal(result.buildId, 7);
  assert.deepEqual(
    uploads.map((upload) => [upload.partNumber, upload.body, upload.contentLength, upload.xPart]),
    [
      [1, "abcd", "4", "1"],
      [2, "efgh", "4", "2"],
      [3, "ij", "2", "3"]
    ]
  );
  assert.deepEqual(completePayload.multipart_upload, {
    upload_id: "upload-123",
    parts: [
      { part_number: 1, etag: "\"etag-1\"" },
      { part_number: 2, etag: "\"etag-2\"" },
      { part_number: 3, etag: "\"etag-3\"" }
    ]
  });
  assert.equal(completePayload.signed_id, "signed-blob");
});

test("parseJsonInput validates action JSON inputs", () => {
  assert.deepEqual(parseJsonInput("[\"--safe\"]", "launch-args"), ["--safe"]);
  assert.deepEqual(parseJsonInput("{\"run_id\":\"123\"}", "source-ref"), { run_id: "123" });
  assert.throws(() => parseJsonInput("{}", "launch-args"), /JSON array/);
  assert.throws(() => parseJsonInput("[]", "source-ref"), /JSON object/);
});

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
}

function serverUrl(server) {
  const address = server.address();
  return `http://${address.address}:${address.port}`;
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("error", reject);
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function writeJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}
