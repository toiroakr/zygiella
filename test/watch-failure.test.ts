import { mkdir, mkdtemp, realpath, rm as removeOnce, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

interface FSWatcherLike {
  emit: (event: string, error: Error) => boolean;
}

// only the native layer is replaced: `fail` makes fs.watch throw for the directories it holds, the rest is real
const native = vi.hoisted(() => ({
  fail: new Set<string>(),
  code: "ENOSPC",
  made: new Map<string, { emit: (event: string, error: Error) => boolean }>(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    watch: ((path: string, ...rest: unknown[]) => {
      if (native.fail.has(String(path)))
        throw Object.assign(new Error(`${native.code}: cannot watch '${path}'`), {
          code: native.code,
        });
      const watcher = (actual.watch as unknown as (...args: unknown[]) => FSWatcherLike)(
        path,
        ...rest,
      );
      native.made.set(String(path), watcher);
      return watcher;
    }) as typeof actual.watch,
  };
});

const { watch } = await import("../src/index.ts");
type FSWatcher = ReturnType<typeof watch>;

const rm = (path: string, options: Parameters<typeof removeOnce>[1] = {}) =>
  removeOnce(path, { maxRetries: 10, retryDelay: 50, ...options });

let dir: string;
let watchers: FSWatcher[];

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "zygiella-")));
  watchers = [];
  native.fail.clear();
  native.made.clear();
  native.code = "ENOSPC";
});

afterEach(async () => {
  await Promise.all(watchers.map((w) => w.close()));
  await rm(dir, { recursive: true, force: true });
});

async function start(paths: string | string[]) {
  const w = watch(paths, { ignoreInitial: true });
  watchers.push(w);
  const seen: Array<[string, string]> = [];
  const errors: Array<NodeJS.ErrnoException> = [];
  w.on("all", (event, path) => seen.push([event, path]));
  w.on("error", (error) => errors.push(error));
  await new Promise<void>((r) => w.once("ready", () => r()));
  return { w, seen, errors };
}

async function until(predicate: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("a watch that could not be established", () => {
  test("emits the error and lists the directory as unwatched while the others stay watched", async () => {
    await mkdir(join(dir, "sub"));
    native.fail.add(join(dir, "sub"));
    const { w, seen, errors } = await start(dir);
    expect(errors.map((e) => e.code)).toEqual(["ENOSPC"]);
    expect(w.unwatched).toEqual([join(dir, "sub")]);
    await writeFile(join(dir, "a.txt"), "1");
    await until(() => seen.length > 0);
    expect(seen).toEqual([["add", join(dir, "a.txt")]]);
  });

  test("lists nothing when every watch was established", async () => {
    await mkdir(join(dir, "sub"));
    const { w } = await start(dir);
    expect(w.unwatched).toEqual([]);
  });

  test("a change below the unwatched directory is reported by rescan()", async () => {
    await mkdir(join(dir, "sub"));
    native.fail.add(join(dir, "sub"));
    const { w, seen } = await start(dir);
    await writeFile(join(dir, "sub", "a.txt"), "1");
    await w.rescan();
    await until(() => seen.length > 0);
    expect(seen).toEqual([["add", join(dir, "sub", "a.txt")]]);
  });

  test("rescan() watches the directory again once fs.watch works, and it is no longer listed", async () => {
    await mkdir(join(dir, "sub"));
    native.fail.add(join(dir, "sub"));
    const { w, seen } = await start(dir);
    native.fail.clear();
    await w.rescan();
    // rescan() does not wait for FSEvents to start delivering as ready does
    await w.add(dir).ready;
    expect(w.unwatched).toEqual([]);
    await writeFile(join(dir, "sub", "a.txt"), "1");
    await until(() => seen.length > 0);
    expect(seen).toEqual([["add", join(dir, "sub", "a.txt")]]);
  });

  test("rescan() emits the error again while fs.watch still fails", async () => {
    await mkdir(join(dir, "sub"));
    native.fail.add(join(dir, "sub"));
    const { w, errors } = await start(dir);
    await w.rescan();
    expect(errors).toHaveLength(2);
    expect(w.unwatched).toEqual([join(dir, "sub")]);
  });

  test("EMFILE is handled like ENOSPC", async () => {
    await mkdir(join(dir, "sub"));
    native.code = "EMFILE";
    native.fail.add(join(dir, "sub"));
    const { w, errors } = await start(dir);
    expect(errors.map((e) => e.code)).toEqual(["EMFILE"]);
    expect(w.unwatched).toEqual([join(dir, "sub")]);
  });

  test("a directory that is removed is no longer listed", async () => {
    await mkdir(join(dir, "sub"));
    native.fail.add(join(dir, "sub"));
    const { w } = await start(dir);
    await rm(join(dir, "sub"), { recursive: true });
    await w.rescan();
    expect(w.unwatched).toEqual([]);
  });

  test("unwatch() drops the directories below the path from the list", async () => {
    await mkdir(join(dir, "sub"));
    native.fail.add(join(dir, "sub"));
    const { w } = await start(dir);
    w.unwatch(dir);
    expect(w.unwatched).toEqual([]);
  });

  test("a native watcher error lists the directory when watching it again fails too", async () => {
    await mkdir(join(dir, "sub"));
    const { w, errors } = await start(dir);
    native.fail.add(join(dir, "sub"));
    native.made
      .get(join(dir, "sub"))!
      .emit("error", Object.assign(new Error("lost"), { code: "EIO" }));
    await until(() => w.unwatched.length > 0);
    expect(w.unwatched).toEqual([join(dir, "sub")]);
    expect(errors.map((e) => e.code)).toContain("EIO");
  });

  test("a native watcher error does not list the directory when watching it again works", async () => {
    await mkdir(join(dir, "sub"));
    const { w, seen, errors } = await start(dir);
    native.made
      .get(join(dir, "sub"))!
      .emit("error", Object.assign(new Error("lost"), { code: "EIO" }));
    await until(() => errors.length > 0);
    expect(w.unwatched).toEqual([]);
    // the new watcher is not delivering yet, as after ready
    await w.add(dir).ready;
    await writeFile(join(dir, "sub", "a.txt"), "1");
    await until(() => seen.length > 0);
    expect(seen).toEqual([["add", join(dir, "sub", "a.txt")]]);
  });

  test("the parent of a watched file is no longer listed once the file's directory is removed", async () => {
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "sub", "a.txt"), "1");
    native.fail.add(join(dir, "sub"));
    const { w } = await start(join(dir, "sub", "a.txt"));
    expect(w.unwatched).toEqual([join(dir, "sub")]);
    await rm(join(dir, "sub"), { recursive: true });
    await w.rescan();
    expect(w.unwatched).toEqual([]);
  });

  test("the parent of a watched file is no longer listed once the file becomes a directory", async () => {
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "sub", "a.txt"), "1");
    native.fail.add(join(dir, "sub"));
    const { w } = await start(join(dir, "sub", "a.txt"));
    native.fail.clear();
    await rm(join(dir, "sub", "a.txt"));
    await mkdir(join(dir, "sub", "a.txt"));
    await w.rescan();
    expect(w.unwatched).toEqual([]);
  });

  test("a root that is unwatched from its own error listener is not left in the list", async () => {
    native.fail.add(dir);
    const w = watch(dir, { ignoreInitial: true });
    watchers.push(w);
    w.on("error", () => w.unwatch(dir));
    await new Promise<void>((r) => w.once("ready", () => r()));
    expect(w.unwatched).toEqual([]);
  });

  test("unwatch() keeps a directory listed while a file root that remains still depends on it", async () => {
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "sub", "a.txt"), "1");
    native.fail.add(join(dir, "sub"));
    const { w } = await start(dir);
    await w.add(join(dir, "sub", "a.txt")).ready;
    w.unwatch(dir);
    expect(w.unwatched).toEqual([join(dir, "sub")]);
  });
});
