// Splits a build folder into the content-addressed chunks and manifest that
// Testing Floor's build-delivery Worker streams as a zip download. The format
// is documented in testingfloor's build-delivery/README.md.
//
// Chunk boundaries follow the content (a rolling "gear" hash), so inserting
// bytes early in a large file only changes the chunks around the edit and the
// rest are already stored from earlier builds. Small files are packed into
// shared objects so a build with thousands of them doesn't mean thousands of
// uploads and reads.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, opendir, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { crc32 } from "node:zlib";

export const CHUNKING = Object.freeze({
  minSize: 1 << 20,
  maskBits: 21,
  maxSize: 8 << 20,
  packThreshold: 256 << 10,
  packTarget: 4 << 20
});

// Fixed forever: changing it moves every chunk boundary, so the next upload
// would share nothing with the chunks already stored.
const GEAR = (() => {
  const table = new Uint32Array(256);
  let x = 0x9e3779b9;
  for (let index = 0; index < 256; index += 1) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    table[index] = x;
  }
  return table;
})();

const TYPE_BITS = { file: 0o100000, directory: 0o040000, symlink: 0o120000 };

// Returns { entries, objects }. entries is the manifest's entry list, in zip
// order. objects maps each object's SHA-256 to its size and where its bytes
// come from: a byte range of one file, or several small files packed in order.
export async function chunkBuildDirectory(root, options = {}) {
  const settings = { ...CHUNKING, ...options };
  const objects = new Map();
  const entries = [];
  let pack = null;

  const addObject = (sha256, size, source) => {
    if (!objects.has(sha256)) objects.set(sha256, { size, source });
  };

  const flushPack = () => {
    if (!pack) return;
    const sha256 = pack.hash.digest("hex");
    addObject(sha256, pack.size, { kind: "pack", files: pack.files });
    for (const ref of pack.refs) ref.object = sha256;
    pack = null;
  };

  for (const item of await walk(root)) {
    if (item.type === "directory") {
      entries.push({ type: "directory", path: item.path, mode: TYPE_BITS.directory | (item.stat.mode & 0o777) });
    } else if (item.type === "symlink") {
      const target = (await readlink(item.absolutePath)).split(path.sep).join("/");
      entries.push({ type: "symlink", path: item.path, mode: TYPE_BITS.symlink | 0o777, target });
    } else if (item.stat.size > 0 && item.stat.size < settings.packThreshold) {
      const bytes = await readFile(item.absolutePath);
      if (pack && pack.size + bytes.length > settings.packTarget) flushPack();
      pack ??= { hash: createHash("sha256"), size: 0, files: [], refs: [] };
      const ref = { object: null, offset: pack.size, size: bytes.length };
      pack.hash.update(bytes);
      pack.files.push(item.absolutePath);
      pack.refs.push(ref);
      pack.size += bytes.length;
      entries.push(fileEntry(item, crc32(bytes), [ref]));
    } else {
      const { fileCrc, chunks } = await chunkFile(item.absolutePath, settings);
      for (const chunk of chunks) {
        addObject(chunk.sha256, chunk.size, {
          kind: "range",
          path: item.absolutePath,
          start: chunk.start,
          end: chunk.start + chunk.size - 1
        });
      }
      entries.push(fileEntry(item, fileCrc, chunks.map((chunk) => ({ object: chunk.sha256, offset: 0, size: chunk.size }))));
    }
  }
  flushPack();

  return { entries, objects };
}

// The bytes of one object, for uploading it. Packed objects are rebuilt from
// their files rather than kept in memory.
export async function readObject(object) {
  if (object.source.kind === "pack") {
    return Buffer.concat(await Promise.all(object.source.files.map((file) => readFile(file))));
  }
  const parts = [];
  for await (const part of createReadStream(object.source.path, { start: object.source.start, end: object.source.end })) {
    parts.push(part);
  }
  return Buffer.concat(parts);
}

function fileEntry(item, fileCrc, chunks) {
  return {
    type: "file",
    path: item.path,
    mode: TYPE_BITS.file | (item.stat.mode & 0o777),
    size: item.stat.size,
    crc32: fileCrc,
    chunks
  };
}

async function chunkFile(filePath, { minSize, maskBits, maxSize }) {
  const mask = (2 ** maskBits) - 1;
  const chunks = [];
  let fileCrc = 0;
  let chunkStart = 0;
  let chunkLength = 0;
  let gear = 0;
  let hash = createHash("sha256");

  for await (const buffer of createReadStream(filePath, { highWaterMark: 1 << 20 })) {
    fileCrc = crc32(buffer, fileCrc);
    let segmentStart = 0;
    let index = 0;

    while (index < buffer.length) {
      // No chunk ends before minSize, so skip hashing those bytes entirely.
      if (chunkLength < minSize) {
        const skip = Math.min(minSize - chunkLength, buffer.length - index);
        chunkLength += skip;
        index += skip;
        continue;
      }

      gear = ((gear << 1) + GEAR[buffer[index]]) >>> 0;
      chunkLength += 1;
      index += 1;

      if ((gear & mask) === 0 || chunkLength >= maxSize) {
        hash.update(buffer.subarray(segmentStart, index));
        chunks.push({ sha256: hash.digest("hex"), start: chunkStart, size: chunkLength });
        chunkStart += chunkLength;
        chunkLength = 0;
        gear = 0;
        hash = createHash("sha256");
        segmentStart = index;
      }
    }

    if (segmentStart < buffer.length) hash.update(buffer.subarray(segmentStart));
  }

  if (chunkLength > 0) chunks.push({ sha256: hash.digest("hex"), start: chunkStart, size: chunkLength });
  return { fileCrc, chunks };
}

// Depth-first, sorted, so the same folder always yields the same entries.
async function walk(root) {
  const items = [];

  async function visit(directory, relativeDirectory) {
    const names = [];
    for await (const entry of await opendir(directory)) names.push(entry.name);
    names.sort();

    for (const name of names) {
      const absolutePath = path.join(directory, name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const stat = await lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        items.push({ type: "symlink", path: relativePath, absolutePath, stat });
      } else if (stat.isDirectory()) {
        items.push({ type: "directory", path: relativePath, absolutePath, stat });
        await visit(absolutePath, relativePath);
      } else if (stat.isFile()) {
        items.push({ type: "file", path: relativePath, absolutePath, stat });
      }
    }
  }

  await visit(root, "");
  return items;
}
