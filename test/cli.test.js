import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseJsonInput, readInputs, resolveActionBuild, zipBuildDirectory } from "../src/action-core.js";
import {
  normalizeConfiguredBuilds,
  parseArgs,
  parseBoundsString,
  parseSourceRefEntries,
  resolveMapPlan,
  resolveUploadPlan,
  uploadBuild,
  uploadMap
} from "../src/cli.js";
import { readMapInputs } from "../src/action-map.js";

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

test("parseArgs parses wharf build flags", () => {
  const parsed = parseArgs([
    "upload-build",
    "--game-id",
    "42",
    "--platform",
    "windows",
    "--archive",
    "build/windows",
    "--archive-kind",
    "wharf",
    "--butler-path",
    "/usr/local/bin/butler",
    "--version",
    "0.4.12",
    "--launch-path",
    "Game.exe"
  ]);

  assert.equal(parsed.options.archiveKind, "wharf");
  assert.equal(parsed.options.butlerPath, "/usr/local/bin/butler");
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

test("resolveUploadPlan accepts wharf builds from directories", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "testingfloor-cli-"));
  const buildDir = path.join(cwd, "windows-build");
  await mkdir(buildDir);
  await writeFile(path.join(buildDir, "Game.exe"), "binary");

  const plan = await resolveUploadPlan(
    {
      archive: "windows-build",
      archiveKind: "wharf",
      gameId: "42",
      launchPath: "Game.exe",
      platform: "windows",
      version: "0.4.12"
    },
    {
      TESTING_FLOOR_API_TOKEN: "tf_test",
      TESTING_FLOOR_BUTLER_PATH: "/usr/local/bin/butler"
    },
    cwd
  );

  assert.equal(plan.builds[0].archiveKind, "wharf");
  assert.equal(plan.builds[0].archivePath, buildDir);
  assert.equal(plan.builds[0].filename, "windows-build.zip");
  assert.equal(plan.butlerPath, "/usr/local/bin/butler");
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
    "INPUT_ARCHIVE-KIND": "wharf",
    "INPUT_BUTLER-PATH": "/opt/butler",
    INPUT_PLATFORM: "windows",
    "INPUT_BUILD-DIRECTORY": "build/Mono/Release/StandaloneWindows64",
    "INPUT_LAUNCH-PATH": "Game.exe",
    INPUT_VERSION: "0.4.12",
    "INPUT_SOURCE-REF": "{\"run_id\":\"123\"}",
    "INPUT_LAUNCH-ARGS": "[\"--safe\"]"
  });

  assert.equal(inputs.apiToken, "tf_builds");
  assert.equal(inputs.archiveKind, "wharf");
  assert.equal(inputs.butlerPath, "/opt/butler");
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

test("uploadBuild creates and uploads wharf patch artifacts", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "testingfloor-cli-"));
  const buildDir = path.join(cwd, "game");
  await mkdir(buildDir);
  await writeFile(path.join(buildDir, "Game.exe"), "binary");
  const butlerPath = await writeFakeButler(cwd);

  const uploads = {};
  let createPayload = null;
  let completePayload = null;
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/api/games/42/builds/wharf/base?platform=windows") {
        writeJson(response, 200, {
          build_id: 6,
          signature_url: `${serverUrl(server)}/base.sig`
        });
        return;
      }

      if (request.method === "GET" && request.url === "/base.sig") {
        response.writeHead(200, { "Content-Type": "application/octet-stream" });
        response.end("base signature");
        return;
      }

      if (request.method === "POST" && request.url === "/api/games/42/builds") {
        createPayload = JSON.parse(await readRequestBody(request));
        writeJson(response, 201, {
          id: 8,
          archive_kind: "wharf",
          wharf_patch_from_build_id: 6,
          uploads: {
            patch: {
              signed_id: "patch-signed",
              upload_strategy: "direct",
              upload_url: `${serverUrl(server)}/uploads/patch`,
              upload_headers: { "x-upload": "patch" }
            },
            signature: {
              signed_id: "signature-signed",
              upload_strategy: "direct",
              upload_url: `${serverUrl(server)}/uploads/signature`,
              upload_headers: { "x-upload": "signature" }
            }
          }
        });
        return;
      }

      if (request.method === "PUT" && request.url?.startsWith("/uploads/")) {
        uploads[request.url] = {
          body: await readRequestBody(request),
          contentLength: request.headers["content-length"],
          uploadHeader: request.headers["x-upload"]
        };
        response.writeHead(200);
        response.end();
        return;
      }

      if (request.method === "POST" && request.url === "/api/game_builds/8/complete") {
        completePayload = JSON.parse(await readRequestBody(request));
        writeJson(response, 200, { id: 8, status: "processing" });
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
    { apiUrl: serverUrl(server), butlerPath, gameId: "42", token: "tf_test" },
    {
      archiveKind: "wharf",
      archivePath: buildDir,
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

  assert.equal(result.buildId, 8);
  assert.equal(result.status, "processing");
  assert.equal(createPayload.archive_kind, "wharf");
  assert.equal(createPayload.wharf_patch_from_build_id, 6);
  assert.equal(createPayload.patch_byte_size, "patch bytes".length);
  assert.equal(createPayload.signature_byte_size, "signature bytes".length);
  assert.equal(uploads["/uploads/patch"].body, "patch bytes");
  assert.equal(uploads["/uploads/patch"].uploadHeader, "patch");
  assert.equal(uploads["/uploads/signature"].body, "signature bytes");
  assert.deepEqual(completePayload, {
    patch_signed_id: "patch-signed",
    signature_signed_id: "signature-signed"
  });
});

test("parseJsonInput validates action JSON inputs", () => {
  assert.deepEqual(parseJsonInput("[\"--safe\"]", "launch-args"), ["--safe"]);
  assert.deepEqual(parseJsonInput("{\"run_id\":\"123\"}", "source-ref"), { run_id: "123" });
  assert.throws(() => parseJsonInput("{}", "launch-args"), /JSON array/);
  assert.throws(() => parseJsonInput("[]", "source-ref"), /JSON object/);
});

test("parseArgs parses upload-map flags", () => {
  const parsed = parseArgs([
    "upload-map",
    "--game-id",
    "42",
    "--level-id",
    "factory",
    "--image",
    "factory.png",
    "--bounds",
    "0,0,200,200",
    "--app-version=0.4.12",
    "--horizontal-axis",
    "x",
    "--vertical-axis",
    "z"
  ]);

  assert.equal(parsed.command, "upload-map");
  assert.equal(parsed.options.gameId, "42");
  assert.equal(parsed.options.levelId, "factory");
  assert.equal(parsed.options.image, "factory.png");
  assert.equal(parsed.options.bounds, "0,0,200,200");
  assert.equal(parsed.options.appVersion, "0.4.12");
  assert.equal(parsed.options.horizontalAxis, "x");
  assert.equal(parsed.options.verticalAxis, "z");
});

test("parseBoundsString accepts comma strings, objects, and rejects bad input", () => {
  assert.deepEqual(parseBoundsString("0,0,200,200"), {
    centerX: 0,
    centerZ: 0,
    sizeX: 200,
    sizeZ: 200
  });
  assert.deepEqual(parseBoundsString("  -5.5 , 10 , 64 , 32 "), {
    centerX: -5.5,
    centerZ: 10,
    sizeX: 64,
    sizeZ: 32
  });
  assert.deepEqual(parseBoundsString({ centerX: 1, centerZ: 2, sizeX: 3, sizeZ: 4 }), {
    centerX: 1,
    centerZ: 2,
    sizeX: 3,
    sizeZ: 4
  });
  assert.deepEqual(parseBoundsString({ center_x: 1, center_z: 2, size_x: 3, size_z: 4 }), {
    centerX: 1,
    centerZ: 2,
    sizeX: 3,
    sizeZ: 4
  });
  assert.throws(() => parseBoundsString("0,0,200"), /four comma-separated/);
  assert.throws(() => parseBoundsString("0,0,foo,200"), /finite number/);
  assert.throws(() => parseBoundsString("0,0,0,200"), /sizeX must be greater/);
  assert.throws(() => parseBoundsString("0,0,200,0"), /sizeZ must be greater/);
});

test("resolveMapPlan builds single map upload from flags", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "testingfloor-cli-"));
  await writeFile(path.join(cwd, "factory.png"), "png bytes");

  const plan = await resolveMapPlan(
    {
      bounds: "0,0,200,200",
      gameId: "42",
      image: "factory.png",
      levelId: "factory"
    },
    {
      TESTING_FLOOR_API_TOKEN: "tf_test",
      TESTING_FLOOR_VERSION: "0.4.12"
    },
    cwd
  );

  assert.equal(plan.apiUrl, "https://testingfloor.com");
  assert.equal(plan.gameId, "42");
  assert.equal(plan.token, "tf_test");
  assert.equal(plan.maps.length, 1);
  const [map] = plan.maps;
  assert.equal(map.levelId, "factory");
  assert.equal(map.imagePath, path.join(cwd, "factory.png"));
  assert.equal(map.imageFilename, "factory.png");
  assert.equal(map.imageMimeType, "image/png");
  assert.deepEqual(map.bounds, { centerX: 0, centerZ: 0, sizeX: 200, sizeZ: 200 });
  assert.equal(map.horizontalAxis, "x");
  assert.equal(map.verticalAxis, "z");
  assert.equal(map.appVersion, "0.4.12");
});

test("resolveMapPlan supports config maps relative to config file", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "testingfloor-cli-"));
  const configDir = path.join(cwd, "ci");
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(cwd, "factory.png"), "png bytes");
  await writeFile(
    path.join(configDir, "testingfloor-maps.json"),
    JSON.stringify({
      gameId: 42,
      appVersion: "0.4.12",
      maps: [
        {
          levelId: "factory",
          image: "../factory.png",
          bounds: { centerX: 0, centerZ: 0, sizeX: 200, sizeZ: 200 }
        }
      ]
    })
  );

  const plan = await resolveMapPlan(
    { config: path.join(configDir, "testingfloor-maps.json") },
    { TESTING_FLOOR_API_TOKEN: "tf_test" },
    cwd
  );

  assert.equal(plan.maps.length, 1);
  assert.equal(plan.maps[0].imagePath, path.join(cwd, "factory.png"));
  assert.equal(plan.maps[0].appVersion, "0.4.12");
});

test("resolveMapPlan rejects mismatched axes and missing fields", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "testingfloor-cli-"));
  await writeFile(path.join(cwd, "factory.png"), "png bytes");

  await assert.rejects(
    () =>
      resolveMapPlan(
        {
          bounds: "0,0,200,200",
          gameId: "42",
          horizontalAxis: "x",
          image: "factory.png",
          levelId: "factory",
          verticalAxis: "x"
        },
        { TESTING_FLOOR_API_TOKEN: "tf_test" },
        cwd
      ),
    /axes must differ/
  );

  await assert.rejects(
    () =>
      resolveMapPlan(
        { gameId: "42", levelId: "factory", image: "factory.png" },
        { TESTING_FLOOR_API_TOKEN: "tf_test" },
        cwd
      ),
    /Missing bounds/
  );
});

test("uploadMap posts multipart form data and returns the created map", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "testingfloor-cli-"));
  const imagePath = path.join(cwd, "factory.png");
  await writeFile(imagePath, "png-bytes");

  let receivedBody = null;
  let receivedAuth = null;
  let receivedContentType = null;
  const server = http.createServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/api/games/42/maps") {
      receivedAuth = request.headers["authorization"];
      receivedContentType = request.headers["content-type"];
      receivedBody = await readRequestBody(request);
      writeJson(response, 201, {
        id: 11,
        level_id: "factory",
        version: 1,
        pinned: true,
        app_version: "0.4.12",
        bounds: { center_x: 0, center_z: 0, size_x: 200, size_z: 200 },
        map_horizontal_axis: "x",
        map_vertical_axis: "z",
        configured: true,
        created: true
      });
      return;
    }

    response.writeHead(404);
    response.end();
  });
  await listen(server);
  t.after(() => server.close());

  const result = await uploadMap(
    { apiUrl: serverUrl(server), gameId: "42", token: "tf_test" },
    {
      levelId: "factory",
      imagePath,
      imageFilename: "factory.png",
      imageMimeType: "image/png",
      bounds: { centerX: 0, centerZ: 0, sizeX: 200, sizeZ: 200 },
      horizontalAxis: "x",
      verticalAxis: "z",
      appVersion: "0.4.12"
    },
    { log: () => {} }
  );

  assert.equal(result.id, 11);
  assert.equal(result.levelId, "factory");
  assert.equal(result.version, 1);
  assert.equal(result.pinned, true);
  assert.equal(result.appVersion, "0.4.12");
  assert.equal(result.created, true);
  assert.equal(receivedAuth, "Bearer tf_test");
  assert.match(receivedContentType ?? "", /^multipart\/form-data; boundary=/);
  assert.match(receivedBody ?? "", /name="level_id"\r\n\r\nfactory\r\n/);
  assert.match(receivedBody ?? "", /name="bounds\[center_x\]"\r\n\r\n0\r\n/);
  assert.match(receivedBody ?? "", /name="bounds\[size_x\]"\r\n\r\n200\r\n/);
  assert.match(receivedBody ?? "", /name="map_horizontal_axis"\r\n\r\nx\r\n/);
  assert.match(receivedBody ?? "", /name="map_vertical_axis"\r\n\r\nz\r\n/);
  assert.match(receivedBody ?? "", /name="app_version"\r\n\r\n0\.4\.12\r\n/);
  assert.match(receivedBody ?? "", /name="image"; filename="factory\.png"\r\nContent-Type: image\/png\r\n\r\npng-bytes\r\n/);
});

test("readMapInputs assembles bounds from four scalar inputs", () => {
  const inputs = readMapInputs({
    "INPUT_API-TOKEN": "tf_test",
    "INPUT_GAME-ID": "42",
    "INPUT_LEVEL-ID": "factory",
    INPUT_IMAGE: "factory.png",
    "INPUT_BOUNDS-CENTER-X": "0",
    "INPUT_BOUNDS-CENTER-Z": "0",
    "INPUT_BOUNDS-SIZE-X": "200",
    "INPUT_BOUNDS-SIZE-Z": "200"
  });

  assert.equal(inputs.token, "tf_test");
  assert.equal(inputs.gameId, "42");
  assert.equal(inputs.levelId, "factory");
  assert.equal(inputs.image, "factory.png");
  assert.deepEqual(inputs.bounds, { centerX: "0", centerZ: "0", sizeX: "200", sizeZ: "200" });
});

test("readMapInputs prefers single bounds string when provided", () => {
  const inputs = readMapInputs({
    "INPUT_API-TOKEN": "tf_test",
    "INPUT_GAME-ID": "42",
    "INPUT_LEVEL-ID": "factory",
    INPUT_IMAGE: "factory.png",
    INPUT_BOUNDS: "0,0,200,200"
  });

  assert.equal(inputs.bounds, "0,0,200,200");
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

async function writeFakeButler(cwd) {
  const script = path.join(cwd, "butler");
  await writeFile(
    script,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] !== "diff") {
  throw new Error("expected diff command");
}
fs.writeFileSync(args[3], "patch bytes");
fs.writeFileSync(args[3] + ".sig", "signature bytes");
`
  );
  await chmod(script, 0o755);
  return script;
}
