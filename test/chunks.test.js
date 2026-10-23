import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { crc32 } from "node:zlib";

import { chunkBuildDirectory, readObject } from "../src/chunks.js";

// Small sizes so tests run on kilobytes instead of megabytes.
const SMALL = { minSize: 4 << 10, maskBits: 12, maxSize: 32 << 10, packThreshold: 1 << 10, packTarget: 8 << 10 };

async function tempBuild(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "testingfloor-chunks-"));
  for (const [relative, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents);
  }
  return root;
}

async function reassemble(entry, objects) {
  const parts = [];
  for (const ref of entry.chunks) {
    const bytes = await readObject(objects.get(ref.object));
    parts.push(bytes.subarray(ref.offset, ref.offset + ref.size));
  }
  return Buffer.concat(parts);
}

test("chunks are deterministic and every file reassembles exactly", async () => {
  const big = randomBytes(200 << 10);
  const root = await tempBuild({
    "Game.exe": big,
    "Data/a.txt": "first small file",
    "Data/b.txt": "second small file",
    "Data/empty.txt": ""
  });

  const first = await chunkBuildDirectory(root, SMALL);
  const second = await chunkBuildDirectory(root, SMALL);
  assert.deepEqual(first.entries, second.entries);

  const files = first.entries.filter((entry) => entry.type === "file");
  assert.deepEqual(files.map((entry) => entry.path), ["Data/a.txt", "Data/b.txt", "Data/empty.txt", "Game.exe"]);
  for (const entry of files) {
    const expected = await readFile(path.join(root, entry.path));
    assert.deepEqual(await reassemble(entry, first.objects), expected, entry.path);
    assert.equal(entry.crc32, crc32(expected), entry.path);
    assert.equal(entry.size, expected.length, entry.path);
  }

  const smallFiles = files.filter((entry) => entry.path.endsWith("a.txt") || entry.path.endsWith("b.txt"));
  assert.equal(new Set(smallFiles.map((entry) => entry.chunks[0].object)).size, 1, "small files share one packed object");
  assert.deepEqual(files.find((entry) => entry.path === "Data/empty.txt").chunks, []);
  assert.ok(files.find((entry) => entry.path === "Game.exe").chunks.length > 3, "large files split into several chunks");
});

test("an insertion only changes the chunks around it", async () => {
  const original = randomBytes(512 << 10);
  const edited = Buffer.concat([original.subarray(0, 100 << 10), randomBytes(100), original.subarray(100 << 10)]);
  const before = await chunkBuildDirectory(await tempBuild({ "data.pak": original }), SMALL);
  const after = await chunkBuildDirectory(await tempBuild({ "data.pak": edited }), SMALL);

  const afterChunks = after.entries[0].chunks.map((ref) => ref.object);
  const shared = afterChunks.filter((object) => before.objects.has(object));
  assert.ok(shared.length / afterChunks.length > 0.8, `only ${shared.length} of ${afterChunks.length} chunks reused`);
});

test("no chunk is larger than the maximum, even with no natural boundaries", async () => {
  const { entries, objects } = await chunkBuildDirectory(await tempBuild({ "zeros.bin": Buffer.alloc(100 << 10) }), SMALL);

  for (const ref of entries[0].chunks) assert.ok(objects.get(ref.object).size <= SMALL.maxSize);
  assert.equal(entries[0].chunks.reduce((sum, ref) => sum + ref.size, 0), 100 << 10);
});

test("records folders, Unix permissions, and symlinks", async () => {
  const root = await tempBuild({ "Crux.app/Contents/MacOS/Crux": "#!/bin/sh\n", "Crux.app/Contents/Frameworks/A/lib": "x" });
  await chmod(path.join(root, "Crux.app/Contents/MacOS/Crux"), 0o755);
  await symlink("A", path.join(root, "Crux.app/Contents/Frameworks/Current"));

  const { entries } = await chunkBuildDirectory(root, SMALL);
  const byPath = Object.fromEntries(entries.map((entry) => [entry.path, entry]));

  assert.equal(byPath["Crux.app"].type, "directory");
  assert.equal(byPath["Crux.app"].mode & 0o170000, 0o040000);
  assert.equal(byPath["Crux.app/Contents/MacOS/Crux"].mode, 0o100755);
  assert.deepEqual(byPath["Crux.app/Contents/Frameworks/Current"], {
    type: "symlink",
    path: "Crux.app/Contents/Frameworks/Current",
    mode: 0o120777,
    target: "A"
  });
  assert.ok(entries.findIndex((entry) => entry.path === "Crux.app") < entries.findIndex((entry) => entry.path.startsWith("Crux.app/")));
});
