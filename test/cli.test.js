import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { crc32 } from "node:zlib";

import {
  butlerDownloadUrl,
  parseJsonInput,
  readInputs,
  resolveActionBuild,
  resolveActionButlerPath
} from "../src/action-core.js";
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
    "--organization-id",
    "gamedepartment",
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
  assert.equal(parsed.options.organizationId, "gamedepartment");
  assert.equal(parsed.options.gameId, "42");
  assert.equal(parsed.options.platform, "windows");
  assert.deepEqual(parsed.options.launchArg, ["-screen-fullscreen", "0"]);
  assert.deepEqual(parsed.options.sourceRef, ["run_id=123"]);
});

test("parseArgs parses the build directory and butler flags", () => {
  const parsed = parseArgs([
    "upload-build",
    "--build-directory",
    "build/windows",
    "--butler-path",
    "/usr/local/bin/butler"
  ]);

  assert.equal(parsed.options.buildDirectory, "build/windows");
  assert.equal(parsed.options.butlerPath, "/usr/local/bin/butler");
});

test("parseArgs explains that --archive-kind was removed", () => {
  assert.throws(() => parseArgs(["upload-build", "--archive-kind", "zip"]), /--archive-kind was removed/);
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
      TESTING_FLOOR_ORGANIZATION_ID: "gamedepartment",
      GITHUB_SHA: "abc123"
    },
    cwd
  );

  assert.equal(plan.apiUrl, "https://tf.test");
  assert.equal(plan.organizationId, "gamedepartment");
  assert.equal(plan.gameId, "42");
  assert.equal(plan.token, "tf_test");
  assert.equal(plan.builds.length, 1);
  assert.equal(plan.builds[0].buildDirectory, path.join(cwd, "game.zip"));
  assert.equal(plan.builds[0].gitSha, "abc123");
  assert.deepEqual(plan.builds[0].launchArgs, ["--safe"]);
  assert.deepEqual(plan.builds[0].sourceRef, { run_id: "123" });
});

test("resolveUploadPlan threads branch from --branch through to each build", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "testingfloor-cli-"));
  await writeFile(path.join(cwd, "game.zip"), "zip bytes");

  const plan = await resolveUploadPlan(
    {
      archive: "game.zip",
      branch: "unity-main",
      gameId: "42",
      launchPath: "Game.exe",
      platform: "windows",
      version: "0.4.12"
    },
    {
      TESTING_FLOOR_API_TOKEN: "tf_test",
      TESTING_FLOOR_ORGANIZATION_ID: "gamedepartment"
    },
    cwd
  );

  assert.equal(plan.builds[0].branch, "unity-main");
});

test("resolveUploadPlan falls back to TESTING_FLOOR_BRANCH env when --branch is absent", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "testingfloor-cli-"));
  await writeFile(path.join(cwd, "game.zip"), "zip bytes");

  const plan = await resolveUploadPlan(
    {
      archive: "game.zip",
      gameId: "42",
      launchPath: "Game.exe",
      platform: "windows",
      version: "0.4.12"
    },
    {
      TESTING_FLOOR_API_TOKEN: "tf_test",
      TESTING_FLOOR_BRANCH: "ue-main",
      TESTING_FLOOR_ORGANIZATION_ID: "gamedepartment"
    },
    cwd
  );

  assert.equal(plan.builds[0].branch, "ue-main");
});

test("resolveUploadPlan leaves branch undefined when no source provides one", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "testingfloor-cli-"));
  await writeFile(path.join(cwd, "game.zip"), "zip bytes");

  const plan = await resolveUploadPlan(
    {
      archive: "game.zip",
      gameId: "42",
      launchPath: "Game.exe",
      platform: "windows",
      version: "0.4.12"
    },
    {
      TESTING_FLOOR_API_TOKEN: "tf_test",
      TESTING_FLOOR_ORGANIZATION_ID: "gamedepartment"
    },
    cwd
  );

  assert.equal(plan.builds[0].branch, undefined);
});

test("resolveUploadPlan accepts build directories", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "testingfloor-cli-"));
  const buildDir = path.join(cwd, "windows-build");
  await mkdir(buildDir);
  await writeFile(path.join(buildDir, "Game.exe"), "binary");

  const plan = await resolveUploadPlan(
    {
      buildDirectory: "windows-build",
      gameId: "42",
      launchPath: "Game.exe",
      platform: "windows",
      version: "0.4.12"
    },
    {
      TESTING_FLOOR_API_TOKEN: "tf_test",
      TESTING_FLOOR_BUTLER_PATH: "/usr/local/bin/butler",
      TESTING_FLOOR_ORGANIZATION_ID: "gamedepartment"
    },
    cwd
  );

  assert.equal(plan.builds[0].buildDirectory, buildDir);
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
      organizationId: "gamedepartment",
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

  assert.equal(plan.builds[0].buildDirectory, path.join(cwd, "game-windows.zip"));
  assert.equal(plan.organizationId, "gamedepartment");
});

test("resolveUploadPlan accepts a game key (slug) as game-id", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "testingfloor-cli-"));
  await writeFile(path.join(cwd, "game.zip"), "zip bytes");

  const plan = await resolveUploadPlan(
    {
      archive: "game.zip",
      gameId: "crux",
      launchPath: "Game.exe",
      platform: "windows",
      version: "0.4.12"
    },
    {
      TESTING_FLOOR_API_TOKEN: "tf_test",
      TESTING_FLOOR_ORGANIZATION_ID: "gamedepartment"
    },
    cwd
  );

  assert.equal(plan.gameId, "crux");
});

test("resolveUploadPlan rejects game ids with disallowed characters", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "testingfloor-cli-"));
  await writeFile(path.join(cwd, "game.zip"), "zip bytes");

  await assert.rejects(
    () =>
      resolveUploadPlan(
        {
          archive: "game.zip",
          gameId: "../etc/passwd",
          launchPath: "Game.exe",
          platform: "windows",
          version: "0.4.12"
        },
        {
          TESTING_FLOOR_API_TOKEN: "tf_test",
          TESTING_FLOOR_ORGANIZATION_ID: "gamedepartment"
        },
        cwd
      ),
    /game key/
  );
});

test("resolveUploadPlan requires an organization id", async () => {
  await assert.rejects(
    () =>
      resolveUploadPlan(
        {
          archive: "game.zip",
          gameId: "42",
          launchPath: "Game.exe",
          platform: "windows",
          version: "0.4.12"
        },
        { TESTING_FLOOR_API_TOKEN: "tf_test" },
        process.cwd()
      ),
    /Missing organization id/
  );
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
    "INPUT_ORGANIZATION-ID": "gamedepartment",
    "INPUT_GAME-ID": "42",
    "INPUT_ARCHIVE-KIND": "wharf",
    "INPUT_BUTLER-PATH": "/opt/butler",
    "INPUT_BUTLER-VERSION": "15.26.1",
    INPUT_PLATFORM: "windows",
    "INPUT_BUILD-DIRECTORY": "build/Mono/Release/StandaloneWindows64",
    "INPUT_LAUNCH-PATH": "Game.exe",
    INPUT_VERSION: "0.4.12",
    "INPUT_SOURCE-REF": "{\"run_id\":\"123\"}",
    "INPUT_LAUNCH-ARGS": "[\"--safe\"]"
  });

  assert.equal(inputs.apiToken, "tf_builds");
  assert.equal(inputs.butlerPath, "/opt/butler");
  assert.equal(inputs.butlerVersion, "15.26.1");
  assert.equal(inputs.gameId, "42");
  assert.equal(inputs.organizationId, "gamedepartment");
  assert.equal(inputs.buildDirectory, "build/Mono/Release/StandaloneWindows64");
  assert.equal(inputs.launchPath, "Game.exe");
  assert.deepEqual(inputs.launchArgs, ["--safe"]);
  assert.deepEqual(inputs.sourceRef, { run_id: "123" });
});

test("readInputs explains that the archive input was removed", () => {
  assert.throws(
    () => readInputs({ "INPUT_API-TOKEN": "tf", "INPUT_ARCHIVE": "game.zip" }),
    /archive input was removed/
  );
});

test("resolveActionButlerPath keeps butler setup inside the action", async () => {
  assert.equal(
    await resolveActionButlerPath({
      butlerPath: "/opt/butler",
      env: { GITHUB_ACTIONS: "true" },
      setup: async () => {
        throw new Error("setup should not run");
      }
    }),
    "/opt/butler"
  );
  assert.equal(
    await resolveActionButlerPath({
      env: { GITHUB_ACTIONS: "true", TESTING_FLOOR_BUTLER_PATH: "/env/butler" },
      setup: async () => {
        throw new Error("setup should not run");
      }
    }),
    "/env/butler"
  );
  assert.equal(
    await resolveActionButlerPath({
      env: {},
      setup: async () => {
        throw new Error("setup should not run outside GitHub Actions");
      }
    }),
    "butler"
  );

  let setupCalled = false;
  const managedPath = await resolveActionButlerPath({
    butlerVersion: "15.26.1",
    env: { GITHUB_ACTIONS: "true" },
    setup: async ({ version }) => {
      setupCalled = true;
      assert.equal(version, "15.26.1");
      return "/managed/butler";
    }
  });

  assert.equal(setupCalled, true);
  assert.equal(managedPath, "/managed/butler");
});

test("butlerDownloadUrl maps runner platforms to itch broth downloads", () => {
  assert.equal(
    butlerDownloadUrl({ platform: "linux", arch: "x64", version: "LATEST" }),
    "https://broth.itch.zone/butler/linux-amd64/LATEST/archive/default"
  );
  assert.equal(
    butlerDownloadUrl({ platform: "darwin", arch: "arm64", version: "15.26.1" }),
    "https://broth.itch.zone/butler/darwin-arm64/15.26.1/archive/default"
  );
  assert.equal(
    butlerDownloadUrl({ platform: "win32", arch: "arm64", version: "LATEST" }),
    "https://broth.itch.zone/butler/windows-amd64/LATEST/archive/default"
  );
});

// failures maps "METHOD /path" to what its next requests get instead of an
// answer: "reset" drops the connection, a number answers with that status and
// an HTML page, the way a proxy does.
function chunkDeliveryServer({ manifestStatuses, alreadyStored = 1, patchUpload = null, failures = {} }) {
  const state = { announced: [], uploads: {}, parts: [], manifest: null, createPayload: null, completePayload: null, wharfBaseUrl: null, polls: 0, requests: {}, order: [] };
  const server = http.createServer(async (request, response) => {
    try {
      const route = `${request.method} ${request.url.split("?")[0]}`;
      state.requests[route] = (state.requests[route] ?? 0) + 1;
      if (route.startsWith("POST /api/game_builds/") || route.startsWith("GET /api/game_builds/")) {
        state.order.push(route);
      }
      const failure = failures[route]?.shift();
      if (failure === "reset") {
        request.socket.destroy();
        return;
      }
      if (failure) {
        await readRequestBody(request);
        response.writeHead(failure, { "Content-Type": "text/html" });
        response.end("<html><body>Bad gateway</body></html>");
        return;
      }
      if (request.method === "GET" && request.url.startsWith("/api/organizations/gamedepartment/games/42/builds/wharf/base")) {
        state.wharfBaseUrl = request.url;
        writeJson(response, 200, { build_id: null, signature_url: null });
        return;
      }
      if (request.method === "POST" && request.url === "/api/organizations/gamedepartment/games/42/builds") {
        state.createPayload = JSON.parse(await readRequestBody(request));
        const upload = (name) => ({ signed_id: `${name}-signed`, upload_strategy: "direct", upload_url: `${serverUrl(server)}/uploads/${name}`, upload_headers: {} });
        writeJson(response, 201, { id: 8, archive_kind: "wharf", uploads: { patch: patchUpload?.(serverUrl(server)) ?? upload("patch"), signature: upload("signature") } });
        return;
      }
      if (request.method === "PUT" && request.url.startsWith("/uploads/")) {
        await readRequestBody(request);
        response.writeHead(200);
        response.end();
        return;
      }
      if (request.method === "PUT" && request.url.startsWith("/parts/")) {
        const partNumber = Number(request.url.split("/").pop());
        state.parts.push([partNumber, await readRequestBody(request), request.headers["content-length"]]);
        response.writeHead(200, { ETag: `"etag-${partNumber}"` });
        response.end();
        return;
      }
      if (request.method === "POST" && request.url === "/api/game_builds/8/complete") {
        state.completePayload = JSON.parse(await readRequestBody(request));
        writeJson(response, 200, { id: 8, status: "ready" });
        return;
      }
      if (request.method === "POST" && request.url === "/api/game_builds/8/chunks") {
        const { chunks } = JSON.parse(await readRequestBody(request));
        state.announced.push(...chunks);
        const missing = chunks.slice(alreadyStored).map((chunk) => ({ sha256: chunk.sha256, upload_url: `${serverUrl(server)}/chunk-uploads/${chunk.sha256}` }));
        writeJson(response, 200, { missing });
        return;
      }
      if (request.method === "PUT" && request.url.startsWith("/chunk-uploads/")) {
        state.uploads[request.url.split("/").pop()] = Buffer.from(await readRequestBody(request, { binary: true }));
        response.writeHead(200);
        response.end();
        return;
      }
      if (request.method === "POST" && request.url === "/api/game_builds/8/manifest") {
        state.manifest = JSON.parse(await readRequestBody(request)).manifest;
        writeJson(response, 202, { status: "pending" });
        return;
      }
      if (request.method === "GET" && request.url === "/api/game_builds/8/manifest") {
        const status = manifestStatuses[Math.min(state.polls, manifestStatuses.length - 1)];
        state.polls += 1;
        writeJson(response, 200, status);
        return;
      }
      response.writeHead(404);
      response.end();
    } catch (error) {
      response.writeHead(500);
      response.end(error.stack);
    }
  });
  return { server, state };
}

async function chunkDeliveryUpload(server, cwd, buildDir, options = {}) {
  return uploadBuild(
    { apiUrl: serverUrl(server), butlerPath: await writeFakeButler(cwd), organizationId: "gamedepartment", gameId: "42", token: "tf_test" },
    {
      buildDirectory: buildDir,
      filename: "game.zip",
      launchArgs: [],
      launchPath: "Game.exe",
      platform: "windows",
      sourceRef: {},
      version: "0.5.0",
      workingDirectory: "."
    },
    { log: () => {}, pollIntervalMs: 1, retryDelaysMs: [1, 1, 1], ...options }
  );
}

test("uploadBuild sends the wharf patch, then only new chunks and the manifest, and completes the build once they're verified", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "testingfloor-cli-"));
  const buildDir = path.join(cwd, "game");
  await mkdir(path.join(buildDir, "Data"), { recursive: true });
  await writeFile(path.join(buildDir, "Game.exe"), randomBytes(3 << 20));
  await writeFile(path.join(buildDir, "Data", "settings.ini"), "[game]\nfullscreen=1\n");
  const { server, state } = chunkDeliveryServer({
    manifestStatuses: [{ status: "pending" }, { status: "verified", zip_size_bytes: 3_145_900 }]
  });
  await listen(server);
  t.after(() => server.close());

  const result = await chunkDeliveryUpload(server, cwd, buildDir);

  assert.equal(result.buildId, 8);
  assert.equal(result.zipSizeBytes, 3_145_900);
  assert.equal(state.createPayload.zip_delivery, "chunk_manifest");
  assert.match(state.wharfBaseUrl, /zip_delivery=chunk_manifest/);
  assert.ok(state.announced.length >= 2, "the big file and the packed small file");
  assert.deepEqual(Object.keys(state.uploads).sort(), state.announced.slice(1).map((chunk) => chunk.sha256).sort(), "only missing chunks are uploaded");
  for (const [sha256, body] of Object.entries(state.uploads)) {
    assert.equal(createHash("sha256").update(body).digest("hex"), sha256);
  }
  const settings = state.manifest.entries.find((entry) => entry.path === "Data/settings.ini");
  assert.equal(settings.crc32, crc32(Buffer.from("[game]\nfullscreen=1\n")));
  assert.equal(state.manifest.entries.find((entry) => entry.path === "Data").type, "directory");
  assert.equal(state.polls, 2);
  assert.deepEqual(state.completePayload, { patch_signed_id: "patch-signed", signature_signed_id: "signature-signed" });
  assert.equal(state.order.at(-1), "POST /api/game_builds/8/complete", "the build is offered only once its chunks are verified");
  assert.equal(state.order.at(-2), "GET /api/game_builds/8/manifest");
});

test("uploadBuild uploads a large wharf patch in parts and completes with their ETags", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "testingfloor-cli-"));
  const buildDir = path.join(cwd, "game");
  await mkdir(buildDir);
  await writeFile(path.join(buildDir, "Game.exe"), "binary");
  const { server, state } = chunkDeliveryServer({
    manifestStatuses: [{ status: "verified", zip_size_bytes: 128 }],
    patchUpload: (baseUrl) => ({
      signed_id: "patch-signed",
      upload_strategy: "multipart",
      multipart_upload: {
        upload_id: "upload-123",
        part_size: 4,
        parts: [1, 2, 3].map((part_number) => ({ part_number, upload_url: `${baseUrl}/parts/${part_number}`, upload_headers: {} }))
      }
    })
  });
  await listen(server);
  t.after(() => server.close());

  await chunkDeliveryUpload(server, cwd, buildDir);

  assert.deepEqual(state.parts, [[1, "patc", "4"], [2, "h by", "4"], [3, "tes", "3"]]);
  assert.deepEqual(state.completePayload.patch_multipart_upload, {
    upload_id: "upload-123",
    parts: [1, 2, 3].map((part_number) => ({ part_number, etag: `"etag-${part_number}"` }))
  });
});

test("uploadBuild fails when Testing Floor rejects the chunks, but still completes the build for patch installs", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "testingfloor-cli-"));
  const buildDir = path.join(cwd, "game");
  await mkdir(buildDir);
  await writeFile(path.join(buildDir, "Game.exe"), "binary");
  const { server, state } = chunkDeliveryServer({
    manifestStatuses: [{ status: "failed", error: "Chunk abc doesn't match its SHA-256" }],
    alreadyStored: 0
  });
  await listen(server);
  t.after(() => server.close());

  await assert.rejects(chunkDeliveryUpload(server, cwd, buildDir), /rejected build 8's chunks: Chunk abc doesn't match its SHA-256/);
  assert.deepEqual(state.completePayload, { patch_signed_id: "patch-signed", signature_signed_id: "signature-signed" });
  assert.equal(state.order.at(-1), "POST /api/game_builds/8/complete");
});

test("uploadBuild refuses a zip file where a build folder is expected", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "testingfloor-cli-"));
  const zip = path.join(cwd, "game.zip");
  await writeFile(zip, "zip bytes");

  await assert.rejects(
    uploadBuild({ apiUrl: "http://127.0.0.1:1", organizationId: "org", gameId: "42", token: "tf" }, { buildDirectory: zip, platform: "windows" }, { log: () => {} }),
    /must be a folder/
  );
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
    "--organization-id",
    "gamedepartment",
    "--game-id",
    "42",
    "--level-id",
    "factory",
    "--image",
    "factory.png",
    "--bounds",
    "0,0,200,200",
    "--app-version=0.4.12",
    "--map-version",
    "3",
    "--variant",
    "ground-floor",
    "--default-variant",
    "true",
    "--horizontal-axis",
    "x",
    "--vertical-axis",
    "z"
  ]);

  assert.equal(parsed.command, "upload-map");
  assert.equal(parsed.options.organizationId, "gamedepartment");
  assert.equal(parsed.options.gameId, "42");
  assert.equal(parsed.options.levelId, "factory");
  assert.equal(parsed.options.image, "factory.png");
  assert.equal(parsed.options.bounds, "0,0,200,200");
  assert.equal(parsed.options.appVersion, "0.4.12");
  assert.equal(parsed.options.mapVersion, "3");
  assert.equal(parsed.options.variant, "ground-floor");
  assert.equal(parsed.options.defaultVariant, "true");
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
      defaultVariant: "true",
      gameId: "42",
      image: "factory.png",
      levelId: "factory",
      mapVersion: "3",
      variant: "ground-floor"
    },
    {
      TESTING_FLOOR_API_TOKEN: "tf_test",
      TESTING_FLOOR_ORGANIZATION_ID: "gamedepartment",
      TESTING_FLOOR_VERSION: "0.4.12"
    },
    cwd
  );

  assert.equal(plan.apiUrl, "https://api.testingfloor.com");
  assert.equal(plan.organizationId, "gamedepartment");
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
  assert.equal(map.version, 3);
  assert.equal(map.variantKey, "ground-floor");
  assert.equal(map.defaultVariant, true);
});

test("resolveMapPlan supports config maps relative to config file", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "testingfloor-cli-"));
  const configDir = path.join(cwd, "ci");
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(cwd, "factory.png"), "png bytes");
  await writeFile(
    path.join(configDir, "testingfloor-maps.json"),
    JSON.stringify({
      organizationId: "gamedepartment",
      gameId: 42,
      appVersion: "0.4.12",
      mapVersion: 3,
      maps: [
        {
          levelId: "factory",
          image: "../factory.png",
          bounds: { centerX: 0, centerZ: 0, sizeX: 200, sizeZ: 200 },
          variantKey: "ground-floor",
          defaultVariant: true
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
  assert.equal(plan.organizationId, "gamedepartment");
  assert.equal(plan.maps[0].imagePath, path.join(cwd, "factory.png"));
  assert.equal(plan.maps[0].appVersion, "0.4.12");
  assert.equal(plan.maps[0].version, 3);
  assert.equal(plan.maps[0].variantKey, "ground-floor");
  assert.equal(plan.maps[0].defaultVariant, true);
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
          organizationId: "gamedepartment",
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
        { gameId: "42", levelId: "factory", image: "factory.png", organizationId: "gamedepartment" },
        { TESTING_FLOOR_API_TOKEN: "tf_test" },
        cwd
      ),
    /Missing bounds/
  );
});

test("resolveMapPlan requires an organization id", async () => {
  await assert.rejects(
    () =>
      resolveMapPlan(
        {
          bounds: "0,0,200,200",
          gameId: "42",
          image: "factory.png",
          levelId: "factory"
        },
        { TESTING_FLOOR_API_TOKEN: "tf_test" },
        process.cwd()
      ),
    /Missing organization id/
  );
});

test("uploadMap uses direct upload and returns the created map", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "testingfloor-cli-"));
  const imagePath = path.join(cwd, "factory.png");
  await writeFile(imagePath, "png-bytes");

  const requests = [];
  let directUploadPayload = null;
  let mapPayload = null;
  let uploadedImageBody = null;
  let uploadContentLength = null;
  let uploadContentMd5 = null;
  let uploadContentType = null;
  const server = http.createServer(async (request, response) => {
    try {
      requests.push(`${request.method} ${request.url}`);
      if (request.method === "POST" && request.url === "/api/organizations/gamedepartment/games/42/maps/direct_uploads") {
        assert.equal(request.headers["authorization"], "Bearer tf_test");
        assert.match(request.headers["content-type"] ?? "", /^application\/json/);
        directUploadPayload = JSON.parse(await readRequestBody(request));
        writeJson(response, 200, {
          image: {
            signed_id: "signed-map-image",
            upload_url: `${serverUrl(server)}/direct-map-image`,
            upload_headers: {
              "Content-Type": "image/png",
              "Content-MD5": "6MDii0K9L0jqNMzcZZP4ig=="
            }
          }
        });
        return;
      }

      if (request.method === "PUT" && request.url === "/direct-map-image") {
        uploadedImageBody = await readRequestBody(request);
        uploadContentLength = request.headers["content-length"];
        uploadContentMd5 = request.headers["content-md5"];
        uploadContentType = request.headers["content-type"];
        response.writeHead(200);
        response.end();
        return;
      }

      if (request.method === "POST" && request.url === "/api/organizations/gamedepartment/games/42/maps") {
        assert.equal(request.headers["authorization"], "Bearer tf_test");
        assert.match(request.headers["content-type"] ?? "", /^application\/json/);
        mapPayload = JSON.parse(await readRequestBody(request));
        writeJson(response, 201, {
          id: 11,
          level_id: "factory",
          version: 1,
          pinned: true,
          app_version: "0.4.12",
          variant_key: "ground-floor",
          variant_label: "Ground floor",
          default_variant: true,
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
    } catch (error) {
      response.writeHead(500);
      response.end(error.stack);
    }
  });
  await listen(server);
  t.after(() => server.close());

  const result = await uploadMap(
    { apiUrl: serverUrl(server), organizationId: "gamedepartment", gameId: "42", token: "tf_test" },
    {
      levelId: "factory",
      imagePath,
      imageFilename: "factory.png",
      imageMimeType: "image/png",
      bounds: { centerX: 0, centerZ: 0, sizeX: 200, sizeZ: 200 },
      horizontalAxis: "x",
      verticalAxis: "z",
      appVersion: "0.4.12",
      variantKey: "ground-floor",
      version: 1,
      defaultVariant: true
    },
    { log: () => {} }
  );

  assert.equal(result.id, 11);
  assert.equal(result.levelId, "factory");
  assert.equal(result.version, 1);
  assert.equal(result.pinned, true);
  assert.equal(result.appVersion, "0.4.12");
  assert.equal(result.variantKey, "ground-floor");
  assert.equal(result.variantLabel, "Ground floor");
  assert.equal(result.defaultVariant, true);
  assert.equal(result.created, true);
  assert.deepEqual(requests, [
    "POST /api/organizations/gamedepartment/games/42/maps/direct_uploads",
    "PUT /direct-map-image",
    "POST /api/organizations/gamedepartment/games/42/maps"
  ]);
  assert.deepEqual(directUploadPayload, {
    filename: "factory.png",
    byte_size: 9,
    checksum: "6MDii0K9L0jqNMzcZZP4ig==",
    content_type: "image/png"
  });
  assert.equal(uploadedImageBody, "png-bytes");
  assert.equal(uploadContentLength, "9");
  assert.equal(uploadContentMd5, "6MDii0K9L0jqNMzcZZP4ig==");
  assert.equal(uploadContentType, "image/png");
  assert.deepEqual(mapPayload, {
    level_id: "factory",
    bounds: {
      center_x: 0,
      center_z: 0,
      size_x: 200,
      size_z: 200
    },
    map_horizontal_axis: "x",
    map_vertical_axis: "z",
    app_version: "0.4.12",
    variant_key: "ground-floor",
    version: 1,
    default_variant: true,
    image_signed_id: "signed-map-image"
  });
});

test("readMapInputs assembles bounds from four scalar inputs", () => {
  const inputs = readMapInputs({
    "INPUT_API-TOKEN": "tf_test",
    "INPUT_ORGANIZATION-ID": "gamedepartment",
    "INPUT_GAME-ID": "42",
    "INPUT_LEVEL-ID": "factory",
    INPUT_IMAGE: "factory.png",
    "INPUT_MAP-VERSION": "3",
    "INPUT_VARIANT-KEY": "ground-floor",
    "INPUT_DEFAULT-VARIANT": "true",
    "INPUT_BOUNDS-CENTER-X": "0",
    "INPUT_BOUNDS-CENTER-Z": "0",
    "INPUT_BOUNDS-SIZE-X": "200",
    "INPUT_BOUNDS-SIZE-Z": "200"
  });

  assert.equal(inputs.token, "tf_test");
  assert.equal(inputs.organizationId, "gamedepartment");
  assert.equal(inputs.gameId, "42");
  assert.equal(inputs.levelId, "factory");
  assert.equal(inputs.image, "factory.png");
  assert.equal(inputs.mapVersion, "3");
  assert.equal(inputs.variantKey, "ground-floor");
  assert.equal(inputs.defaultVariant, "true");
  assert.deepEqual(inputs.bounds, { centerX: "0", centerZ: "0", sizeX: "200", sizeZ: "200" });
});

test("readMapInputs prefers single bounds string when provided", () => {
  const inputs = readMapInputs({
    "INPUT_API-TOKEN": "tf_test",
    "INPUT_ORGANIZATION-ID": "gamedepartment",
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

function readRequestBody(request, { binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("error", reject);
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      resolve(binary ? body : body.toString("utf8"));
    });
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

async function smallBuild() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "testingfloor-cli-"));
  const buildDir = path.join(cwd, "game");
  await mkdir(buildDir, { recursive: true });
  await writeFile(path.join(buildDir, "Game.exe"), randomBytes(2048));
  await writeFile(path.join(buildDir, "readme.txt"), "hello");
  return { cwd, buildDir };
}

test("uploadBuild keeps waiting for verification through dropped connections and proxy errors", async (t) => {
  const { cwd, buildDir } = await smallBuild();
  const { server, state } = chunkDeliveryServer({
    manifestStatuses: [{ status: "pending" }, { status: "verified", zip_size_bytes: 4096 }],
    failures: { "GET /api/game_builds/8/manifest": ["reset", 502, 502, 502, 502, 503] }
  });
  await listen(server);
  t.after(() => server.close());
  const logged = [];

  const result = await chunkDeliveryUpload(server, cwd, buildDir, { log: (line) => logged.push(line) });

  assert.equal(result.zipSizeBytes, 4096);
  assert.equal(state.requests["GET /api/game_builds/8/manifest"], 8);
  assert.ok(logged.some((line) => line.startsWith("Couldn't check verification just now")), "a check that runs out of retries is logged, not fatal");
});

test("uploadBuild retries announcing chunks and sending the manifest after a server error", async (t) => {
  const { cwd, buildDir } = await smallBuild();
  const { server, state } = chunkDeliveryServer({
    manifestStatuses: [{ status: "verified", zip_size_bytes: 4096 }],
    failures: { "POST /api/game_builds/8/chunks": [503], "POST /api/game_builds/8/manifest": ["reset"] }
  });
  await listen(server);
  t.after(() => server.close());

  const result = await chunkDeliveryUpload(server, cwd, buildDir);

  assert.equal(result.zipSizeBytes, 4096);
  assert.equal(state.requests["POST /api/game_builds/8/chunks"], 2);
  assert.equal(state.requests["POST /api/game_builds/8/manifest"], 2);
  assert.ok(state.manifest, "the manifest arrives on the retry");
});

test("uploadBuild doesn't retry creating a build or a request Testing Floor refused", async (t) => {
  const { cwd, buildDir } = await smallBuild();
  const created = chunkDeliveryServer({
    manifestStatuses: [{ status: "verified" }],
    failures: { "POST /api/organizations/gamedepartment/games/42/builds": [503] }
  });
  await listen(created.server);
  t.after(() => created.server.close());

  await assert.rejects(chunkDeliveryUpload(created.server, cwd, buildDir), /503 Service Unavailable/);
  assert.equal(created.state.requests["POST /api/organizations/gamedepartment/games/42/builds"], 1, "a retry could create a second build");

  const refused = chunkDeliveryServer({ manifestStatuses: [{ status: "verified" }], failures: { "POST /api/game_builds/8/chunks": [422] } });
  await listen(refused.server);
  t.after(() => refused.server.close());

  await assert.rejects(chunkDeliveryUpload(refused.server, cwd, buildDir), /422 Unprocessable Entity/);
  assert.equal(refused.state.requests["POST /api/game_builds/8/chunks"], 1);
});
