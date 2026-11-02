import { createHash } from "node:crypto";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";

const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".mov", ".webm", ".avi", ".m4v", ".mpg", ".mpeg", ".ts", ".mts", ".m2ts", ".ogv", ".3gp"]);
const CHUNK_SIZE = 8 * 1024 * 1024;
const RETRY_DELAYS = [1000, 2000, 4000, 8000];

class RetryableError extends Error {}
class ExpiredUploadError extends Error {}

export async function prepareRecordingPlan(plan) {
  if (!plan.file) throw new Error("Missing --file. Choose a video file or a folder of videos.");
  if (plan.gameId) {
    if (!plan.organizationId) throw new Error("--game-id requires --organization-id.");
    if (plan.playtestId) throw new Error("Choose --game-id or --playtest-id, not both.");
  } else if (!plan.playtestId) {
    throw new Error("Choose --playtest-id, or --organization-id and --game-id for Ongoing recordings.");
  }
  if (plan.playtestId && !/^\d+$/.test(String(plan.playtestId))) throw new Error("--playtest-id must be a numeric ID.");
  if (plan.testerId && !/^\d+$/.test(String(plan.testerId))) throw new Error("--tester-id must be a numeric ID.");
  if (!plan.testerId && !plan.testerName?.trim() && !plan.testerEmail?.trim()) {
    throw new Error("Provide --tester-id, --tester-name, or --tester-email to identify who played.");
  }
  if (plan.testerId && (plan.testerName || plan.testerEmail)) {
    throw new Error("Choose --tester-id or --tester-name/--tester-email, not both.");
  }
  if (plan.recordedAt && (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(plan.recordedAt) || !Number.isFinite(Date.parse(plan.recordedAt)))) {
    throw new Error("--recorded-at must be an ISO 8601 timestamp with a timezone.");
  }
  if (plan.idempotencyKey !== undefined && (typeof plan.idempotencyKey !== "string" || !plan.idempotencyKey.length || Buffer.byteLength(plan.idempotencyKey) > 128)) {
    throw new Error("--idempotency-key must contain between 1 and 128 bytes.");
  }

  const files = await videoFiles(plan.file);
  if (!files.length) throw new Error("No video files found. Export Steam recordings as video files before uploading.");
  for (const file of files) {
    const info = await lstat(file);
    if (!info.size) throw new Error(`Video file is empty: ${file}`);
  }
  const suffix = plan.gameId
    ? `/organizations/${encodeURIComponent(plan.organizationId)}/games/${encodeURIComponent(plan.gameId)}/uploads`
    : `/playtests/${encodeURIComponent(plan.playtestId)}/uploads`;
  return { ...plan, files, createUrl: `${plan.apiUrl}/api${suffix}` };
}

async function videoFiles(input) {
  const info = await lstat(input);
  if (info.isSymbolicLink()) throw new Error(`Choose a regular file or folder, not a symbolic link: ${input}`);
  if (info.isFile()) {
    if (!VIDEO_EXTENSIONS.has(path.extname(input).toLowerCase())) throw new Error(`Unsupported video extension: ${input}`);
    return [input];
  }
  if (!info.isDirectory()) throw new Error(`Choose a regular video file or folder: ${input}`);
  const files = [];
  for (const entry of (await readdir(input, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    const child = path.join(input, entry.name);
    if (entry.isDirectory()) files.push(...await videoFiles(child));
    else if (entry.isFile() && VIDEO_EXTENSIONS.has(path.extname(child).toLowerCase())) files.push(child);
  }
  return files;
}

export async function uploadRecordings(plan, {
  log = console.error,
  chunkSize = CHUNK_SIZE,
  retryDelaysMs = RETRY_DELAYS,
  timeoutMs = 120_000,
  signal
} = {}) {
  const results = [];
  for (const [index, file] of plan.files.entries()) {
    signal?.throwIfAborted();
    log(`[${index + 1}/${plan.files.length}] ${path.basename(file)}`);
    try {
      results.push(await uploadRecording(plan, file, { log, chunkSize, retryDelaysMs, timeoutMs, signal }));
    } catch (error) {
      throw new Error(`${path.basename(file)}: ${error.message}. Rerun the same command with the same API key to resume; completed recordings will be reused.`, { cause: error });
    }
  }
  return results;
}

async function uploadRecording(plan, file, options) {
  const handle = await open(file, "r");
  try {
    const original = await handle.stat();
    if (!original.isFile() || !original.size) throw new Error("Choose a nonempty regular video file");
    const assertUnchanged = async () => {
      const current = await handle.stat();
      if (current.size !== original.size || current.mtimeMs !== original.mtimeMs || current.ctimeMs !== original.ctimeMs) {
        throw new Error("The source video changed during upload; finish recording or copying it before trying again");
      }
    };
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) {
      options.signal?.throwIfAborted();
      hash.update(chunk);
    }
    await assertUnchanged();
    const body = Object.fromEntries(Object.entries({
      tester_id: plan.testerId,
      tester_name: plan.testerName,
      tester_email: plan.testerEmail,
      version: plan.version,
      recorded_at: plan.recordedAt,
      written_feedback: plan.writtenFeedback,
      provenance: { source: "cli", filename: path.basename(file) }
    }).filter(([, value]) => value !== undefined && value !== null && value !== ""));
    // Stable across restarts, including a lost creation response. Different
    // files in a batch get distinct keys even with a caller-supplied batch key.
    const key = createHash("sha256").update(JSON.stringify([plan.createUrl, plan.idempotencyKey ?? "", file, body, hash.digest("hex")])).digest("hex");
    const create = () => retry(() => createUpload(plan, body, key, options), options);
    let upload = await create();
    let refreshed = false;
    for (;;) {
      if (upload.video_upload_complete === true) break;
      const url = validatedUploadUrl(upload.upload_url);
      try {
        await transferVideo(url, handle, original.size, assertUnchanged, options);
        break;
      } catch (error) {
        if (!(error instanceof ExpiredUploadError) || refreshed) throw error;
        upload = await create();
        refreshed = true;
      }
    }
    const result = {
      file,
      recording_id: upload.recording_id,
      video_id: upload.video_id,
      status: "uploaded",
      status_url: upload.status_url
    };
    options.log(`Uploaded ${path.basename(file)} (recording ${result.recording_id}); processing continues in Testing Floor.`);
    return result;
  } finally {
    await handle.close();
  }
}

async function createUpload(plan, body, key, options) {
  const response = await send(plan.createUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${plan.token}`, "TestingFloor-Api-Version": "1", "Idempotency-Key": key, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }, options);
  let payload;
  try {
    payload = await response.json();
  } catch {
    const message = `Testing Floor returned an unreadable response (HTTP ${response.status})`;
    throw response.ok || retryableStatus(response.status) ? new RetryableError(message) : new Error(message);
  }
  if (!response.ok) {
    const message = payload.error || `Testing Floor returned HTTP ${response.status}`;
    if (response.status === 403 && /uploads:create/.test(message)) {
      throw new Error('Recording uploads require uploads:create. Run "testingfloor login" again or use an API key with that permission');
    }
    throw (payload.retryable ?? retryableStatus(response.status)) ? new RetryableError(message) : new Error(message);
  }
  if (!payload.recording_id || !payload.video_id) throw new Error("Testing Floor did not return a recording and video ID");
  return payload;
}

async function transferVideo(url, handle, size, assertUnchanged, options) {
  let offset = null;
  let failures = 0;
  let lastPercent = -1;
  for (;;) {
    options.signal?.throwIfAborted();
    await assertUnchanged();
    try {
      if (offset === null || offset === size) {
        const progress = await storageRequest(url, { "Content-Range": `bytes */${size}`, "Content-Length": "0" }, undefined, options);
        if (progress.complete) return;
        offset = progress.offset;
        if (offset === size) throw new RetryableError("The video is fully received but the upload is not complete yet");
        validateOffset(offset, size);
      }
      const length = Math.min(options.chunkSize, size - offset);
      const chunk = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const { bytesRead } = await handle.read(chunk, read, length - read, offset + read);
        if (!bytesRead) throw new Error("The source video ended before its expected size");
        read += bytesRead;
      }
      await assertUnchanged();
      const end = offset + length;
      const progress = await storageRequest(url, {
        "Content-Range": `bytes ${offset}-${end - 1}/${size}`,
        "Content-Length": String(length),
        "Content-Type": "application/octet-stream"
      }, chunk, options);
      if (progress.complete) {
        if (end !== size) throw new Error("Upload server reported completion before the whole video was sent");
        return;
      }
      validateOffset(progress.offset, end);
      if (progress.offset <= offset) throw new RetryableError("Upload server has not confirmed any new bytes");
      offset = progress.offset;
      failures = 0;
      const percent = Math.floor(offset * 100 / size);
      if (percent >= lastPercent + 10) {
        options.log(`Video: ${percent}% uploaded`);
        lastPercent = percent;
      }
    } catch (error) {
      if (!(error instanceof RetryableError) || failures >= options.retryDelaysMs.length) throw error;
      await delay(options.retryDelaysMs[failures++], options.signal);
      // The previous request may have committed bytes before its reply was
      // lost. Ask the server rather than advancing or trusting a local cursor.
      offset = null;
    }
  }
}

function validateOffset(offset, maximum) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > maximum) throw new Error("Upload server returned an invalid byte range");
}

async function storageRequest(url, headers, body, options) {
  const response = await send(url, { method: "PUT", headers, body }, options);
  const range = response.headers.get("range");
  await response.body?.cancel();
  if (response.status === 200 || response.status === 201) return { complete: true };
  if (response.status === 308) {
    if (!range) return { offset: 0 };
    const match = /^bytes=0-(\d+)$/.exec(range);
    if (!match) throw new Error("Upload server returned a malformed byte range");
    return { offset: Number(match[1]) + 1 };
  }
  if ([403, 404, 410].includes(response.status)) throw new ExpiredUploadError("Upload URL expired or is unavailable");
  const message = `Video upload returned HTTP ${response.status}`;
  throw retryableStatus(response.status) ? new RetryableError(message) : new Error(message);
}

function validatedUploadUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Testing Floor did not return a valid upload URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Testing Floor returned an unsupported upload URL");
  return url;
}

async function send(url, init, options) {
  options.signal?.throwIfAborted();
  try {
    return await fetch(url, { ...init, redirect: "manual", signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]) : AbortSignal.timeout(options.timeoutMs) });
  } catch {
    options.signal?.throwIfAborted();
    // Signed upload URLs contain credentials. Never include them in errors.
    throw new RetryableError("Upload request timed out or lost its connection");
  }
}

async function retry(operation, options) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); } catch (error) {
      if (!(error instanceof RetryableError) || attempt >= options.retryDelaysMs.length) throw error;
      await delay(options.retryDelaysMs[attempt], options.signal);
    }
  }
}

function retryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const aborted = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", aborted); resolve(); }, ms);
    signal?.addEventListener("abort", aborted, { once: true });
  });
}
