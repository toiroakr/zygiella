import { mkdir, mkdtemp, realpath, rename, rm as removeOnce, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { watch, type FSWatcher } from "../src/index.ts";

let dir: string;
let watcher: FSWatcher | undefined;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "zygiella-rename-")));
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

async function start(options: Parameters<typeof watch>[1] = {}) {
  watcher = watch(dir, { ignoreInitial: true, ...options });
  const seen: unknown[][] = [];
  watcher.on("all", (...args) => seen.push(args));
  await watcher.ready;
  return seen;
}

const named = (seen: unknown[][], event: string) => seen.filter(([name]) => name === event);

describe("a file that is moved", () => {
  test("is reported as add that names the old path, and as unlink without it", async () => {
    await writeFile(join(dir, "a.txt"), "hello");
    const seen = await start();
    await rename(join(dir, "a.txt"), join(dir, "b.txt"));
    await until(() => named(seen, "add").length > 0 && named(seen, "unlink").length > 0);
    expect(named(seen, "add")).toEqual([
      ["add", join(dir, "b.txt"), { renamedFrom: join(dir, "a.txt") }],
    ]);
    expect(named(seen, "unlink")).toEqual([["unlink", join(dir, "a.txt")]]);
  });

  test("names the old path in the add listener as its second argument", async () => {
    await writeFile(join(dir, "a.txt"), "hello");
    watcher = watch(dir, { ignoreInitial: true });
    const added: unknown[][] = [];
    watcher.on("add", (...args) => added.push(args));
    await watcher.ready;
    await rename(join(dir, "a.txt"), join(dir, "b.txt"));
    await until(() => added.length > 0);
    expect(added).toEqual([[join(dir, "b.txt"), { renamedFrom: join(dir, "a.txt") }]]);
  });

  test("names the old path when it goes to another directory", async () => {
    await mkdir(join(dir, "one"));
    await mkdir(join(dir, "two"));
    await writeFile(join(dir, "one", "a.txt"), "hello");
    const seen = await start();
    await rename(join(dir, "one", "a.txt"), join(dir, "two", "a.txt"));
    await until(() => named(seen, "add").length > 0 && named(seen, "unlink").length > 0);
    expect(named(seen, "add")).toEqual([
      ["add", join(dir, "two", "a.txt"), { renamedFrom: join(dir, "one", "a.txt") }],
    ]);
  });

  test("names the old path when nothing holds the unlink back, so unlink comes first", async () => {
    await writeFile(join(dir, "a.txt"), "hello");
    const seen = await start({ atomic: false });
    await rename(join(dir, "a.txt"), join(dir, "b.txt"));
    await until(() => named(seen, "add").length > 0 && named(seen, "unlink").length > 0);
    expect(named(seen, "add")).toEqual([
      ["add", join(dir, "b.txt"), { renamedFrom: join(dir, "a.txt") }],
    ]);
  });

  test("names the old path with awaitWriteFinish", async () => {
    await writeFile(join(dir, "a.txt"), "hello");
    const seen = await start({ awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 } });
    await rename(join(dir, "a.txt"), join(dir, "b.txt"));
    await until(() => named(seen, "add").length > 0 && named(seen, "unlink").length > 0);
    expect(named(seen, "add")).toEqual([
      ["add", join(dir, "b.txt"), { renamedFrom: join(dir, "a.txt") }],
    ]);
  });
});

describe("a file that was there when the watcher started from a snapshot", () => {
  test("names the old path when it is moved after ready", async () => {
    await writeFile(join(dir, "a.txt"), "hello");
    const first = watch(dir, { ignoreInitial: true });
    await first.ready;
    const since = first.snapshot();
    await first.close();
    const seen = await start({ since });
    await rename(join(dir, "a.txt"), join(dir, "b.txt"));
    await until(() => named(seen, "add").length > 0 && named(seen, "unlink").length > 0);
    expect(named(seen, "add")).toEqual([
      ["add", join(dir, "b.txt"), { renamedFrom: join(dir, "a.txt") }],
    ]);
  });
});

describe("a file that is moved again before its add is reported", () => {
  const slow = { awaitWriteFinish: { stabilityThreshold: 600, pollInterval: 20 } };

  test("names the first path, not the intermediate one", async () => {
    await writeFile(join(dir, "a.txt"), "hello");
    const seen = await start(slow);
    await rename(join(dir, "a.txt"), join(dir, "b.txt"));
    await new Promise((r) => setTimeout(r, 150));
    await rename(join(dir, "b.txt"), join(dir, "c.txt"));
    await until(() => named(seen, "add").length > 0, 5000);
    expect(named(seen, "add")).toEqual([
      ["add", join(dir, "c.txt"), { renamedFrom: join(dir, "a.txt") }],
    ]);
  });

  test("names no path when another file replaces the destination meanwhile", async () => {
    await writeFile(join(dir, "a.txt"), "hello");
    const seen = await start(slow);
    await rename(join(dir, "a.txt"), join(dir, "b.txt"));
    await new Promise((r) => setTimeout(r, 150));
    await writeFile(join(dir, ".next-file"), "something else");
    await rename(join(dir, ".next-file"), join(dir, "b.txt"));
    await until(() => named(seen, "add").length > 0, 5000);
    expect(named(seen, "add")).toEqual([["add", join(dir, "b.txt")]]);
  });
});

describe("a file that only looks moved", () => {
  test("does not name an old path for a different file created after a delete", async () => {
    await writeFile(join(dir, "a.txt"), "1");
    const seen = await start();
    await removeOnce(join(dir, "a.txt"));
    await writeFile(join(dir, "b.txt"), "22222");
    await until(() => named(seen, "add").length > 0 && named(seen, "unlink").length > 0);
    expect(named(seen, "add")).toEqual([["add", join(dir, "b.txt")]]);
  });

  test("does not name an old path for a file that is created", async () => {
    const seen = await start();
    await writeFile(join(dir, "a.txt"), "1");
    await until(() => seen.length > 0);
    expect(seen).toEqual([["add", join(dir, "a.txt")]]);
  });
});

// Windows refuses to rename a directory that has a watched directory inside
describe.skipIf(process.platform === "win32")("a directory that is moved", () => {
  test("names the old path of each file below it, and not of the directory", async () => {
    await mkdir(join(dir, "old"));
    await writeFile(join(dir, "old", "a.txt"), "hello");
    const seen = await start();
    await rename(join(dir, "old"), join(dir, "new"));
    await until(() => named(seen, "add").length > 0 && named(seen, "unlinkDir").length > 0);
    expect(named(seen, "add")).toEqual([
      ["add", join(dir, "new", "a.txt"), { renamedFrom: join(dir, "old", "a.txt") }],
    ]);
    expect(named(seen, "addDir")).toEqual([["addDir", join(dir, "new")]]);
    expect(named(seen, "unlinkDir")).toEqual([["unlinkDir", join(dir, "old")]]);
  });
});
