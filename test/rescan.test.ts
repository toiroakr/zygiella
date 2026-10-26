import { mkdir, mkdtemp, realpath, rm as removeOnce, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { watch, type FSWatcher } from "../src/index.ts";

const open = new Set<string>();

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  watch: (path: string) => {
    open.add(path);
    return Object.assign(new EventEmitter(), { close: () => open.delete(path) });
  },
}));

let dir: string;
let watcher: FSWatcher | undefined;

beforeEach(async () => {
  open.clear();
  dir = await realpath(await mkdtemp(join(tmpdir(), "zygiella-rescan-")));
});

afterEach(async () => {
  await watcher?.close();
  await removeOnce(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

test("rescan reports a created file although the native watcher never notifies", async () => {
  watcher = watch(dir, { ignoreInitial: true });
  const seen: string[] = [];
  watcher.on("add", (path) => seen.push(path));
  await watcher.ready;
  await writeFile(join(dir, "a.txt"), "1");
  await new Promise((r) => setTimeout(r, 300));
  expect(seen).toEqual([]);
  await watcher.rescan();
  await vi.waitUntil(() => seen.length > 0, 3000);
  expect(seen).toEqual([join(dir, "a.txt")]);
});

test("rescan reports a change below a nested directory although the native watcher never notifies", async () => {
  await mkdir(join(dir, "sub", "deep"), { recursive: true });
  watcher = watch(dir, { ignoreInitial: true });
  const seen: string[] = [];
  watcher.on("add", (path) => seen.push(path));
  await watcher.ready;
  await writeFile(join(dir, "sub", "deep", "a.txt"), "1");
  await watcher.rescan();
  await vi.waitUntil(() => seen.length > 0, 3000);
  expect(seen).toEqual([join(dir, "sub", "deep", "a.txt")]);
});

test("rescan reports a watched path that did not exist when it was given", async () => {
  const root = join(dir, "later");
  watcher = watch(root, { ignoreInitial: true });
  const seen: string[] = [];
  watcher.on("all", (event, path) => seen.push(`${event} ${path}`));
  await watcher.ready;
  await mkdir(root);
  await writeFile(join(root, "a.txt"), "1");
  await watcher.rescan();
  await vi.waitUntil(() => seen.length >= 2, 3000);
  expect(seen).toEqual([`addDir ${root}`, `add ${join(root, "a.txt")}`]);
});

test("a missing root that appears as a skipped file lets go of the watch on the ancestor that was standing in for it", async () => {
  const file = join(dir, "sub", "a.txt");
  watcher = watch(file, {
    ignoreInitial: true,
    ignored: (_path, stats) => stats?.isFile() === true,
  });
  await watcher.ready;
  expect([...open]).toEqual([dir]);
  await mkdir(join(dir, "sub"));
  await writeFile(file, "1");
  await watcher.rescan();
  expect([...open]).toEqual([join(dir, "sub")]);
});
