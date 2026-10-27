import { mkdir, mkdtemp, realpath, rm as removeOnce, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, parse } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { watch, type FSWatcher } from "../src/index.ts";

const rm = (path: string, options: Parameters<typeof removeOnce>[1] = {}) =>
  removeOnce(path, { maxRetries: 10, retryDelay: 50, ...options });

let dir: string;
let watchers: FSWatcher[];

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "zygiella-watched-")));
  watchers = [];
});

afterEach(async () => {
  await Promise.all(watchers.map((w) => w.close()));
  await rm(dir, { recursive: true, force: true });
});

async function start(paths: string | string[], opts: Parameters<typeof watch>[1] = {}) {
  const w = watch(paths, { ignoreInitial: true, ...opts });
  watchers.push(w);
  await new Promise<void>((r) => w.once("ready", () => r()));
  return w;
}

async function until(predicate: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const parent = () => dirname(dir);
const name = () => basename(dir);

test("a watched directory is listed with its entry names sorted, and its parent lists the directory", async () => {
  await writeFile(join(dir, "b.txt"), "");
  await writeFile(join(dir, "a.txt"), "");
  await mkdir(join(dir, "sub"));
  const w = await start(dir, { depth: 0 });
  expect(w.getWatched()).toEqual({ [parent()]: [name()], [dir]: ["a.txt", "b.txt", "sub"] });
});

test("every directory descended into is a key of its own", async () => {
  await mkdir(join(dir, "sub", "deep"), { recursive: true });
  await writeFile(join(dir, "sub", "deep", "d.txt"), "");
  const w = await start(dir);
  expect(w.getWatched()).toEqual({
    [parent()]: [name()],
    [dir]: ["sub"],
    [join(dir, "sub")]: ["deep"],
    [join(dir, "sub", "deep")]: ["d.txt"],
  });
});

test("a file given to watch() is listed under its directory, which has no key for the file", async () => {
  await writeFile(join(dir, "lone.txt"), "");
  await writeFile(join(dir, "other.txt"), "");
  const w = await start(join(dir, "lone.txt"));
  expect(w.getWatched()).toEqual({ [dir]: ["lone.txt"] });
});

test("a path that does not exist yet leaves its directory listed with no names", async () => {
  const w = await start(join(dir, "nope"));
  expect(w.getWatched()).toEqual({ [dir]: [] });
});

test("an ignored file and an ignored directory are neither names nor keys", async () => {
  await writeFile(join(dir, "a.txt"), "");
  await writeFile(join(dir, "skip.log"), "");
  await mkdir(join(dir, "gen"));
  await writeFile(join(dir, "gen", "g.txt"), "");
  const w = await start(dir, { ignored: [/\.log$/, join(dir, "gen")] });
  expect(w.getWatched()).toEqual({ [parent()]: [name()], [dir]: ["a.txt"] });
});

test("a directory below depth is a name of its parent but not a key", async () => {
  await mkdir(join(dir, "one", "two", "three"), { recursive: true });
  const w = await start(dir, { depth: 1 });
  expect(w.getWatched()).toEqual({
    [parent()]: [name()],
    [dir]: ["one"],
    [join(dir, "one")]: ["two"],
  });
});

test("unwatch() takes the path out of the keys and out of its parent's names", async () => {
  const kept = join(dir, "kept");
  const dropped = join(dir, "dropped");
  await mkdir(kept);
  await mkdir(dropped);
  const w = await start([kept, dropped]);
  w.unwatch(dropped);
  expect(w.getWatched()).toEqual({ [dir]: ["kept"], [kept]: [] });
});

test("add() puts the new path into the keys and its parent's names", async () => {
  const first = join(dir, "first");
  const second = join(dir, "second");
  await mkdir(first);
  await mkdir(second);
  await writeFile(join(second, "s.txt"), "");
  const w = await start(first);
  w.add(second);
  await w.ready;
  expect(w.getWatched()).toEqual({
    [dir]: ["first", "second"],
    [first]: [],
    [second]: ["s.txt"],
  });
});

test("a file created and a file removed after ready change the names", async () => {
  await writeFile(join(dir, "old.txt"), "");
  const w = await start(dir);
  await writeFile(join(dir, "new.txt"), "");
  await rm(join(dir, "old.txt"));
  await until(() => w.getWatched()[dir]?.join() === "new.txt");
});

test("a watched directory that is removed leaves the keys and its parent's names", async () => {
  const root = join(dir, "root");
  await mkdir(join(root, "sub"), { recursive: true });
  const w = await start(root);
  await rm(join(root, "sub"), { recursive: true });
  await until(() => !(join(root, "sub") in w.getWatched()));
  expect(w.getWatched()).toEqual({ [dir]: ["root"], [root]: [] });
});

test("a directory created after ready becomes a key", async () => {
  const w = await start(dir);
  await mkdir(join(dir, "late"));
  await until(() => join(dir, "late") in w.getWatched());
  expect(w.getWatched()[dir]).toEqual(["late"]);
});

test("nothing is listed after close()", async () => {
  await writeFile(join(dir, "a.txt"), "");
  const w = await start(dir);
  await w.close();
  expect(w.getWatched()).toEqual({});
});

test("a nested path that is still watched keeps its name in its directory after unwatch() of the ancestor", async () => {
  const outer = join(dir, "outer");
  await mkdir(outer);
  await writeFile(join(outer, "inner.txt"), "");
  const w = await start([outer, join(outer, "inner.txt")]);
  w.unwatch(outer);
  expect(w.getWatched()).toEqual({ [outer]: ["inner.txt"] });
});

test.skipIf(process.platform === "win32")(
  "the filesystem root is not listed as a name of itself",
  async () => {
    const root = parse(dir).root;
    const w = await start(root, { depth: 0, ignorePermissionErrors: true });
    expect(w.getWatched()[root]).not.toContain("");
  },
);
