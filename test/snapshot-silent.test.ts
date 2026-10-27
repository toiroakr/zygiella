import { mkdtemp, realpath, rename, rm as removeOnce, symlink, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { watch, type FSWatcher } from "../src/index.ts";

// no native event ever arrives, as on a Docker bind mount: only rescan() and the write polling see the file
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  watch: () => Object.assign(new EventEmitter(), { close: () => {} }),
}));

let dir: string;
let watcher: FSWatcher | undefined;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "zygiella-silent-")));
});

afterEach(async () => {
  await watcher?.close();
  watcher = undefined;
  await removeOnce(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function until(predicate: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("a write that settles after the last rescan() is the state the snapshot records", async () => {
  await writeFile(join(dir, "a.txt"), "1");
  watcher = watch(dir, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 },
  });
  const seen: string[] = [];
  watcher.on("change", (path) => seen.push(path));
  await watcher.ready;
  await writeFile(join(dir, "a.txt"), "22");
  await watcher.rescan();
  await writeFile(join(dir, "a.txt"), "333");
  await until(() => seen.length > 0);
  const entry = watcher.snapshot().entries.find((e) => e.path === join(dir, "a.txt"));
  expect(entry?.size).toBe(3);
});

test.skipIf(process.platform === "win32")(
  "a link retargeted again while its change settles is recorded with the last target",
  async () => {
    await writeFile(join(dir, "t1"), "");
    await symlink(join(dir, "t1"), join(dir, "link"));
    watcher = watch(dir, {
      ignoreInitial: true,
      followSymlinks: false,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 },
    });
    const seen: string[] = [];
    watcher.on("change", (path) => seen.push(path));
    await watcher.ready;
    // replaced in one step: a gap with no link would let the poll see ENOENT and stop, with no native event to restart it
    const retarget = async (target: string) => {
      await symlink(target, join(dir, ".next-link"));
      await rename(join(dir, ".next-link"), join(dir, "link"));
    };
    await retarget(join(dir, "t22"));
    await watcher.rescan();
    await retarget(join(dir, "t333"));
    await until(() => seen.length > 0);
    const entry = watcher.snapshot().entries.find((e) => e.path === join(dir, "link"));
    expect(entry?.link).toBe(join(dir, "t333"));
  },
);

test.skipIf(process.platform === "win32")(
  "a link replaced by a regular file while its change settles is recorded without a link target",
  async () => {
    await writeFile(join(dir, "t1"), "");
    await symlink(join(dir, "t1"), join(dir, "link"));
    watcher = watch(dir, {
      ignoreInitial: true,
      followSymlinks: false,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 },
    });
    const seen: string[] = [];
    watcher.on("change", (path) => seen.push(path));
    await watcher.ready;
    await symlink(join(dir, "t22"), join(dir, ".next-link"));
    await rename(join(dir, ".next-link"), join(dir, "link"));
    await watcher.rescan();
    await writeFile(join(dir, ".next-file"), "regular");
    await rename(join(dir, ".next-file"), join(dir, "link"));
    await until(() => seen.length > 0);
    const entry = watcher.snapshot().entries.find((e) => e.path === join(dir, "link"));
    expect(entry?.link).toBeUndefined();
  },
);
