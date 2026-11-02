import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main, parseArgs, resolveRecordingPlan } from "../src/cli.js";
import { saveLogin } from "../src/credentials.js";
import { uploadRecordings } from "../src/recordings.js";

const TOKEN = "tf_example_recording_key";
const quick = { log: () => {}, chunkSize: 8, retryDelaysMs: [0, 0], timeoutMs: 1000 };

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "testingfloor-recordings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "gameplay.mp4");
  const bytes = Buffer.from("example video bytes for resumable uploads");
  await writeFile(file, bytes);
  return { directory, file, bytes };
}

async function serverFor(t, { create, storage } = {}) {
  const state = { creates: [], puts: [], uploads: new Map(), interrupted: false };
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const base = `http://127.0.0.1:${server.address().port}`;
      if (request.method === "POST") {
        const body = JSON.parse(bytes.toString());
        const key = request.headers["idempotency-key"];
        state.creates.push({ body, key, headers: request.headers, url: request.url });
        if (create && await create({ state, request, response, body, key })) return;
        let upload = state.uploads.get(key);
        if (!upload) {
          upload = { id: state.uploads.size + 1, bytes: Buffer.alloc(0), complete: false };
          state.uploads.set(key, upload);
        }
        response.writeHead(201, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          recording_id: upload.id,
          video_id: upload.id + 100,
          upload_url: `${base}/storage/${upload.id}?signature=upload-secret`,
          status_url: `${base}/api/playtests/123/uploads/${upload.id}`,
          ...(upload.complete ? { video_upload_complete: true } : {})
        }));
        return;
      }
      const upload = [...state.uploads.values()].find((item) => request.url.startsWith(`/storage/${item.id}?`));
      state.puts.push({ bytes, range: request.headers["content-range"], headers: request.headers });
      if (storage && await storage({ state, upload, request, response, bytes })) return;
      if (upload.complete) { response.writeHead(200); response.end(); return; }
      if (!request.headers["content-range"].startsWith("bytes */")) {
        const [, first, last, total] = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(request.headers["content-range"]);
        assert.equal(Number(first), upload.bytes.length);
        assert.equal(Number(last) - Number(first) + 1, bytes.length);
        upload.bytes = Buffer.concat([upload.bytes, bytes]);
        upload.complete = upload.bytes.length === Number(total);
      }
      response.writeHead(upload.complete ? 200 : 308, upload.bytes.length ? { Range: `bytes=0-${upload.bytes.length - 1}` } : {});
      response.end();
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: error.message, retryable: false }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { state, apiUrl: `http://127.0.0.1:${server.address().port}` };
}

function planFor(file, apiUrl, extra = {}) {
  return resolveRecordingPlan({ file, apiUrl, playtestId: "123", testerName: "Example player", token: TOKEN, ...extra });
}

test("recording flags, saved login and config paths work together", async (t) => {
  const { directory, file } = await fixture(t);
  const config = path.join(directory, "upload.json");
  await writeFile(config, JSON.stringify({ file: path.basename(file), playtestId: 123, testerName: "Example player", apiUrl: "https://api.example.com" }));
  const env = { TESTING_FLOOR_CONFIG_DIR: path.join(directory, "login") };
  await saveLogin(env, { token: TOKEN, apiUrl: "https://api.example.com" });
  const parsed = parseArgs(["upload-recording", "--config", config, "--recorded-at", "2026-01-01T12:00:00Z", "--version", "1.2.3", "--written-feedback", "Controls felt clear"]);
  const plan = await resolveRecordingPlan(parsed.options, env, "/");
  assert.deepEqual(plan.files, [file]);
  assert.equal(plan.token, TOKEN);
  assert.equal(plan.recordedAt, "2026-01-01T12:00:00Z");
  assert.equal(plan.version, "1.2.3");
  assert.equal(plan.writtenFeedback, "Controls felt clear");
  await assert.rejects(resolveRecordingPlan({ ...parsed.options, apiUrl: "https://other.example.com" }, env), /Missing API token/);
});

test("validates the destination, identity, timestamp and source before any upload", async (t) => {
  const { file, directory } = await fixture(t);
  const defaults = { file, token: TOKEN, playtestId: "123", testerName: "Example player" };
  for (const [overrides, message] of [
    [{ file: undefined }, /Missing --file/],
    [{ playtestId: undefined }, /Choose --playtest-id/],
    [{ gameId: "my-game", organizationId: "example-studio" }, /not both/],
    [{ gameId: "my-game", playtestId: undefined }, /requires --organization-id/],
    [{ testerName: " " }, /identify who played/],
    [{ testerId: "123" }, /Choose --tester-id/],
    [{ playtestId: "../other" }, /numeric/],
    [{ recordedAt: "yesterday" }, /ISO 8601/],
    [{ recordedAt: "2026-01-01T12:00:00" }, /timezone/],
    [{ idempotencyKey: "x".repeat(129) }, /128 bytes/]
  ]) await assert.rejects(resolveRecordingPlan({ ...defaults, ...overrides }), message);
  const empty = path.join(directory, "empty.mp4");
  await writeFile(empty, "");
  await assert.rejects(planFor(empty, "https://api.example.com"), /empty/);
  const text = path.join(directory, "notes.txt");
  await writeFile(text, "notes");
  await assert.rejects(planFor(text, "https://api.example.com"), /Unsupported/);
});

test("a folder includes nested videos in order, skipping sidecars and symbolic links", async (t) => {
  const { directory, file } = await fixture(t);
  const nested = path.join(directory, "nested");
  await mkdir(nested);
  const second = path.join(nested, "second.MKV");
  await writeFile(second, "other video");
  await writeFile(path.join(directory, "notes.txt"), "notes");
  await writeFile(path.join(directory, ".hidden.mp4"), "hidden");
  await symlink(directory, path.join(nested, "loop"), "dir");
  const link = path.join(directory, "linked.mp4");
  await symlink(file, link);
  const plan = await planFor(directory, "https://api.example.com");
  assert.deepEqual(plan.files, [file, second]);
  await assert.rejects(planFor(link, "https://api.example.com"), /symbolic link/);
});

test("uploads exact bytes and metadata to a game, with API credentials only on API requests", async (t) => {
  const { file, bytes } = await fixture(t);
  const { apiUrl, state } = await serverFor(t);
  const plan = await planFor(file, apiUrl, { playtestId: undefined, organizationId: "example-studio", gameId: "my-game", testerName: undefined, testerId: "5", version: "1.2.3", recordedAt: "2026-01-01T12:00:00Z", writtenFeedback: "The menu was clear" });
  const [result] = await uploadRecordings(plan, quick);
  assert.equal(state.creates[0].url, "/api/organizations/example-studio/games/my-game/uploads");
  assert.equal(state.creates[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(state.creates[0].headers["testingfloor-api-version"], "1");
  assert.deepEqual(state.creates[0].body, { tester_id: "5", version: "1.2.3", recorded_at: "2026-01-01T12:00:00Z", written_feedback: "The menu was clear", provenance: { source: "cli", filename: "gameplay.mp4" } });
  assert.deepEqual([...state.uploads.values()][0].bytes, bytes);
  assert.ok(state.puts.length > 2);
  assert.ok(state.puts.every((put) => !put.headers.authorization && !put.headers["testingfloor-api-version"]));
  assert.equal(result.status, "uploaded");
  assert.equal(result.recording_id, 1);
  assert.ok(result.status_url.endsWith("/uploads/1"));
  assert.ok(!JSON.stringify(result).includes("upload-secret"));
});

test("rerunning after interruption resumes from the server's committed offset without a second recording", async (t) => {
  const { file, bytes } = await fixture(t);
  let fail = true;
  const { apiUrl, state } = await serverFor(t, { storage: async ({ upload, request, response }) => {
    if (fail && upload.bytes.length === 8 && !request.headers["content-range"].startsWith("bytes */")) {
      response.writeHead(503); response.end(); return true;
    }
  } });
  const plan = await planFor(file, apiUrl);
  await assert.rejects(uploadRecordings(plan, { ...quick, retryDelaysMs: [] }), /Rerun the same command/);
  assert.equal([...state.uploads.values()][0].bytes.length, 8);
  fail = false;
  const before = state.puts.length;
  await uploadRecordings(plan, quick);
  assert.equal(state.puts[before + 1].range, `bytes 8-15/${bytes.length}`);
  assert.equal(state.uploads.size, 1);
  assert.equal(state.creates[0].key, state.creates[1].key);
  assert.deepEqual([...state.uploads.values()][0].bytes, bytes);
  const completedPuts = state.puts.length;
  await uploadRecordings(plan, quick);
  assert.equal(state.puts.length, completedPuts, "a completed import is reused without another storage upload");
});

test("lost creation and final-chunk responses are recovered without duplicating the import", async (t) => {
  const { file, bytes } = await fixture(t);
  let lostCreate = false;
  let lostFinal = false;
  const { apiUrl, state } = await serverFor(t, {
    create: async ({ state, request, key }) => {
      if (!lostCreate) {
        lostCreate = true;
        state.uploads.set(key, { id: 1, bytes: Buffer.alloc(0), complete: false });
        request.socket.destroy(); return true;
      }
    },
    storage: async ({ upload, request, bytes: chunk }) => {
      if (!lostFinal && request.headers["content-range"].endsWith(`-${bytes.length - 1}/${bytes.length}`)) {
        upload.bytes = Buffer.concat([upload.bytes, chunk]);
        upload.complete = true;
        lostFinal = true;
        request.socket.destroy(); return true;
      }
    }
  });
  await uploadRecordings(await planFor(file, apiUrl), quick);
  assert.equal(lostCreate, true);
  assert.equal(lostFinal, true);
  assert.equal(state.uploads.size, 1);
  assert.deepEqual([...state.uploads.values()][0].bytes, bytes);
});

test("partial chunks use the confirmed range rather than the requested end", async (t) => {
  const { file, bytes } = await fixture(t);
  let partial = false;
  const { apiUrl, state } = await serverFor(t, { storage: async ({ upload, request, response, bytes: chunk }) => {
    if (!partial && !request.headers["content-range"].startsWith("bytes */")) {
      partial = true;
      upload.bytes = chunk.subarray(0, 4);
      response.writeHead(308, { Range: "bytes=0-3" }); response.end(); return true;
    }
  } });
  await uploadRecordings(await planFor(file, apiUrl), quick);
  assert.equal(state.puts[2].range, `bytes 4-11/${bytes.length}`);
  assert.deepEqual([...state.uploads.values()][0].bytes, bytes);
});

test("expired URLs are recovered by replaying creation with the same key", async (t) => {
  const { file } = await fixture(t);
  let expired = false;
  const { apiUrl, state } = await serverFor(t, { storage: async ({ response }) => {
    if (!expired) { expired = true; response.writeHead(410); response.end(); return true; }
  } });
  await uploadRecordings(await planFor(file, apiUrl), quick);
  assert.equal(state.creates.length, 2);
  assert.equal(state.creates[0].key, state.creates[1].key);
  assert.equal(state.uploads.size, 1);
});

test("batch keys are per file and can intentionally create a fresh import", async (t) => {
  const { file, directory } = await fixture(t);
  const second = path.join(directory, "nested");
  await mkdir(second);
  await writeFile(path.join(second, path.basename(file)), await readFile(file));
  const { apiUrl, state } = await serverFor(t);
  await uploadRecordings(await planFor(directory, apiUrl, { idempotencyKey: "batch-one" }), quick);
  assert.equal(state.uploads.size, 2);
  assert.notEqual(state.creates[0].key, state.creates[1].key);
  await uploadRecordings(await planFor(directory, apiUrl, { idempotencyKey: "batch-two" }), quick);
  assert.equal(state.uploads.size, 4);
});

test("quota refusals are not retried and missing scopes explain how to sign in again", async (t) => {
  const { file } = await fixture(t);
  for (const [status, error, pattern] of [[429, "Recording hours exhausted", /Recording hours exhausted/], [403, "Insufficient scope: uploads:create required", /login.*again/]]) {
    const { apiUrl, state } = await serverFor(t, { create: async ({ response }) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error, retryable: false })); return true;
    } });
    await assert.rejects(uploadRecordings(await planFor(file, apiUrl), quick), pattern);
    assert.equal(state.creates.length, 1);
    assert.equal(state.puts.length, 0);
  }
});

test("rejects invalid ranges, premature success and incomplete final acknowledgements", async (t) => {
  const { file } = await fixture(t);
  for (const [status, headers, pattern] of [
    [308, { Range: "bad" }, /malformed byte range/],
    [308, { Range: "bytes=0-99999" }, /invalid byte range/],
    [200, {}, /before the whole video/],
    [308, {}, /not confirmed any new bytes/]
  ]) {
    const { apiUrl } = await serverFor(t, { storage: async ({ request, response }) => {
      if (request.headers["content-range"].startsWith("bytes */")) return;
      response.writeHead(status, headers); response.end(); return true;
    } });
    await assert.rejects(uploadRecordings(await planFor(file, apiUrl), quick), pattern);
  }
});

test("an incomplete final 308 is confirmed with a status query before success", async (t) => {
  const { file, bytes } = await fixture(t);
  const { apiUrl, state } = await serverFor(t, { storage: async ({ upload, request, response, bytes: chunk }) => {
    if (request.headers["content-range"].endsWith(`-${bytes.length - 1}/${bytes.length}`)) {
      upload.bytes = Buffer.concat([upload.bytes, chunk]); upload.complete = true;
      response.writeHead(308, { Range: `bytes=0-${bytes.length - 1}` }); response.end(); return true;
    }
  } });
  await uploadRecordings(await planFor(file, apiUrl), quick);
  assert.equal(state.puts.at(-1).range, `bytes */${bytes.length}`);
});

test("stalled transfers time out, cancellation stops retries, and signed URLs stay out of errors", async (t) => {
  const { file } = await fixture(t);
  const { apiUrl } = await serverFor(t, { storage: async () => true });
  const plan = await planFor(file, apiUrl);
  await assert.rejects(uploadRecordings(plan, { ...quick, timeoutMs: 30, retryDelaysMs: [] }), (error) => /timed out/.test(error.message) && !error.message.includes("upload-secret"));
  const controller = new AbortController();
  const promise = uploadRecordings(plan, { ...quick, signal: controller.signal });
  setTimeout(() => controller.abort(new Error("Cancelled by user")), 30);
  await assert.rejects(promise, /Cancelled by user/);
});

test("a changing source file is rejected before another chunk is sent", async (t) => {
  const { file } = await fixture(t);
  let changed = false;
  const { apiUrl, state } = await serverFor(t, { storage: async () => {
    if (!changed) { changed = true; await writeFile(file, "replaced"); }
  } });
  await assert.rejects(uploadRecordings(await planFor(file, apiUrl), quick), /source video changed/);
  assert.equal(state.puts.length, 1);
});

test("the command prints recording JSON and keeps --json output free of progress and secrets", async (t) => {
  const { file } = await fixture(t);
  const { apiUrl } = await serverFor(t);
  const printed = [];
  await main(["upload-recording", "--api-url", apiUrl, "--file", file, "--playtest-id", "123", "--tester-email", "player@example.com", "--json"], { TESTING_FLOOR_API_TOKEN: TOKEN }, process.cwd(), { print: (line) => printed.push(line), log: () => assert.fail("--json must suppress progress") });
  assert.equal(printed.length, 1);
  const result = JSON.parse(printed[0]);
  assert.equal(result.recordings[0].recording_id, 1);
  assert.equal(result.recordings[0].status, "uploaded");
  assert.ok(!printed[0].includes(TOKEN));
  assert.ok(!printed[0].includes("upload-secret"));
});
