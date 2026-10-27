import { mkdir, mkdtemp, realpath, rm as removeOnce, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

interface WatchCall {
  path: string;
  recursive: boolean;
}

// fs.watch is the real one; it is only recorded, and `unsupported` makes a recursive call throw as Linux does
const native = vi.hoisted(() => ({
  calls: [] as WatchCall[],
  unsupported: false,
  made: new Map<string, { emit: (event: string, error: Error) => boolean }>(),
  closed: [] as string[],
  failTree: false,
  fail: new Set<string>(),
  failTreeFor: new Set<string>(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    watch: ((path: string, options: { recursive?: boolean } = {}, ...rest: unknown[]) => {
      const recursive = options.recursive === true;
      native.calls.push({ path: String(path), recursive });
      if (recursive && native.unsupported)
        throw Object.assign(new Error("recursive watching is not supported"), {
          code: "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM",
        });
      if (!recursive && native.fail.has(String(path)))
        throw Object.assign(new Error("ENOSPC: cannot watch"), { code: "ENOSPC" });
      if (recursive && native.failTreeFor.has(String(path)))
        throw Object.assign(new Error("EMFILE: too many open files, watch"), { code: "EMFILE" });
      if (recursive && native.failTree)
        throw Object.assign(new Error("EMFILE: too many open files, watch"), { code: "EMFILE" });
      const watcher = (
        actual.watch as unknown as (...args: unknown[]) => {
          emit: (event: string, error: Error) => boolean;
        }
      )(path, options, ...rest);
      const key = `${recursive ? "tree:" : "dir:"}${String(path)}`;
      native.made.set(key, watcher);
      const close = (watcher as unknown as { close: () => void }).close.bind(watcher);
      (watcher as unknown as { close: () => void }).close = () => {
        native.closed.push(key);
        close();
      };
      return watcher;
    }) as typeof actual.watch,
  };
});

const { watch } = await import("../src/index.ts");
type FSWatcher = ReturnType<typeof watch>;
type WatchOptions = NonNullable<Parameters<typeof watch>[1]>;

const rm = (path: string, options: Parameters<typeof removeOnce>[1] = {}) =>
  removeOnce(path, { maxRetries: 10, retryDelay: 50, ...options });

const recursiveHere = process.platform === "darwin";
let dir: string;
let outside: string;
let watchers: FSWatcher[];

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "zygiella-")));
  outside = await realpath(await mkdtemp(join(tmpdir(), "zygiella-outside-")));
  watchers = [];
  native.calls.length = 0;
  native.made.clear();
  native.closed.length = 0;
  native.unsupported = false;
  native.failTree = false;
  native.fail.clear();
  native.failTreeFor.clear();
});

afterEach(async () => {
  await Promise.all(watchers.map((w) => w.close()));
  await rm(dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

async function start(path: string | string[], options: WatchOptions = {}) {
  const w = watch(path, { ignoreInitial: true, atomic: false, ...options });
  watchers.push(w);
  const seen: Array<[string, string]> = [];
  const errors: NodeJS.ErrnoException[] = [];
  w.on("all", (event, p) => seen.push([event, p]));
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

/**
 * Writes `file` again until `reported()`: the OS may not deliver yet for a watch that was just attached. The pause is
 * longer than the 50 ms of quiet an add or change waits for, or the writes would keep postponing the report.
 */
async function writeUntil(file: string, reported: () => boolean): Promise<void> {
  for (let i = 0; !reported() && i < 50; i++) {
    await writeFile(file, String(i));
    await new Promise((r) => setTimeout(r, 120));
  }
  expect(reported()).toBe(true);
}

const tree = async (count: number) => {
  for (let i = 0; i < count; i++) await mkdir(join(dir, `d${i}`, "inner"), { recursive: true });
};

describe.skipIf(!recursiveHere)("on macOS", () => {
  test("a tree of many directories is watched with one native watch", async () => {
    await tree(30);
    await start(dir);
    expect(native.calls).toEqual([{ path: dir, recursive: true }]);
  });

  test("a change deep in the tree is reported", async () => {
    await tree(3);
    const { seen } = await start(dir);
    await writeFile(join(dir, "d1", "inner", "a.txt"), "1");
    await until(() => seen.length > 0);
    expect(seen).toEqual([["add", join(dir, "d1", "inner", "a.txt")]]);
  });

  test("a file written right after its directories were created is reported", async () => {
    const { seen } = await start(dir);
    await mkdir(join(dir, "a", "b", "c"), { recursive: true });
    await writeFile(join(dir, "a", "b", "c", "late.txt"), "1");
    await until(() => seen.some(([, path]) => path.endsWith("late.txt")));
    expect(seen).toContainEqual(["add", join(dir, "a", "b", "c", "late.txt")]);
  });

  test("a finite depth is watched one directory at a time", async () => {
    await tree(5);
    await start(dir, { depth: 1 });
    expect(native.calls.every((call) => !call.recursive)).toBe(true);
    expect(native.calls.length).toBeGreaterThan(5);
  });

  test("a directory behind a followed link is watched on its own and its changes are reported under the link", async () => {
    await symlink(outside, join(dir, "link"));
    const { seen } = await start(dir);
    expect(native.calls).toEqual([
      { path: dir, recursive: true },
      { path: join(dir, "link"), recursive: false },
    ]);
    await writeUntil(join(outside, "a.txt"), () => seen.length > 0);
    expect(seen[0]).toEqual(["add", join(dir, "link", "a.txt")]);
  });

  test("a directory created below a followed link is watched on its own", async () => {
    await symlink(outside, join(dir, "link"));
    const { seen } = await start(dir);
    // a file first: the watch on the link delivers once this is reported, so the directory below is not missed
    await writeUntil(join(outside, "armed.txt"), () => seen.length > 0);
    await mkdir(join(outside, "sub"));
    await until(() => native.calls.some((call) => call.path === join(dir, "link", "sub")));
    const file = join(dir, "link", "sub", "a.txt");
    await writeUntil(join(outside, "sub", "a.txt"), () => seen.some(([, path]) => path === file));
    expect(seen).toContainEqual(["add", file]);
  });

  test("without followSymlinks the whole tree is one native watch", async () => {
    await symlink(outside, join(dir, "link"));
    await start(dir, { followSymlinks: false });
    expect(native.calls).toEqual([{ path: dir, recursive: true }]);
  });

  test("a limit hit by the recursive watch lists the root and rescan() watches it again", async () => {
    await tree(2);
    const { w, errors } = await start(dir);
    native.made
      .get(`tree:${dir}`)!
      .emit("error", Object.assign(new Error("limit"), { code: "EMFILE" }));
    await until(() => errors.length > 0);
    expect(w.unwatched).toEqual([dir]);
    expect(native.calls.filter((call) => call.recursive)).toHaveLength(1);
    await w.rescan();
    expect(w.unwatched).toEqual([]);
    expect(native.calls.filter((call) => call.recursive)).toHaveLength(2);
  });

  test("a change below a subdirectory that was missed while the recursive watch failed is reported", async () => {
    await tree(2);
    const { seen, errors } = await start(dir);
    // watching the tree again fails too, so the directories below the root are only found by reading them
    native.failTree = true;
    native.made
      .get(`tree:${dir}`)!
      .emit("error", Object.assign(new Error("lost"), { code: "EIO" }));
    await writeFile(join(dir, "d1", "inner", "missed.txt"), "1");
    await until(() => errors.length > 0);
    await until(() => seen.some(([, path]) => path.endsWith("missed.txt")), 4000);
    expect(seen).toContainEqual(["add", join(dir, "d1", "inner", "missed.txt")]);
  });

  test("directories that failed one by one are no longer listed once a recursive watch covers them", async () => {
    await tree(2);
    native.failTree = true;
    native.fail.add(join(dir, "d1"));
    const { w } = await start(dir);
    expect(w.unwatched).toEqual([join(dir, "d1")]);
    native.failTree = false;
    native.fail.clear();
    await w.rescan();
    expect(w.unwatched).toEqual([]);
  });

  test("a watched file below a covered directory keeps reporting after the tree that covered it is unwatched", async () => {
    await mkdir(join(dir, "sub"));
    const file = join(dir, "sub", "a.txt");
    await writeFile(file, "0");
    const { w, seen } = await start(dir);
    await w.add(file).ready;
    await w.rescan();
    w.unwatch(dir);
    await writeUntil(file, () => seen.some(([, path]) => path === file));
  });

  test("a scan that a tree watch asked for does not let the other trees try again after a limit", async () => {
    const other = join(dir, "other");
    await mkdir(other);
    await mkdir(join(dir, "main"));
    const main = join(dir, "main");
    const { seen, errors } = await start([main, other]);
    native.made
      .get(`tree:${other}`)!
      .emit("error", Object.assign(new Error("limit"), { code: "EMFILE" }));
    await until(() => errors.length > 0);
    // a tree watch that reports something without a place makes zygiella read everything again
    (native.made.get(`tree:${main}`)! as unknown as { emit: (...args: unknown[]) => boolean }).emit(
      "change",
      "rename",
      null,
    );
    await writeUntil(join(main, "a.txt"), () =>
      seen.some(([, path]) => path === join(main, "a.txt")),
    );
    expect(native.calls.filter((call) => call.recursive && call.path === other)).toHaveLength(1);
  });

  test("the recursive watch of a root is closed when the root is unwatched, even if a watched file below it remains", async () => {
    // directly in the root: the directory of the file is the root itself, which keeps its own watch for the file
    const file = join(dir, "a.txt");
    await writeFile(file, "0");
    const { w } = await start(dir);
    await w.add(file).ready;
    w.unwatch(dir);
    expect(native.closed).toContain(`tree:${dir}`);
  });

  test("a tree that hit a limit is not watched directory by directory by a scan that something else asked for", async () => {
    const other = join(dir, "other");
    const main = join(dir, "main");
    await mkdir(join(other, "x", "y"), { recursive: true });
    await mkdir(main);
    const { seen, errors } = await start([main, other]);
    native.made
      .get(`tree:${other}`)!
      .emit("error", Object.assign(new Error("limit"), { code: "EMFILE" }));
    await until(() => errors.length > 0);
    const before = native.calls.length;
    (native.made.get(`tree:${main}`)! as unknown as { emit: (...args: unknown[]) => boolean }).emit(
      "change",
      "rename",
      null,
    );
    await writeUntil(join(main, "a.txt"), () =>
      seen.some(([, path]) => path === join(main, "a.txt")),
    );
    expect(
      native.calls.slice(before).filter((call) => !call.recursive && call.path.startsWith(other)),
    ).toEqual([]);
  });

  test("errors of a root that was unwatched do not count against it when it is added again", async () => {
    // a watched file directly in the root keeps the directory in use, so unwatching the root cannot rely on releasing it
    const file = join(dir, "a.txt");
    await writeFile(file, "0");
    const { w, errors } = await start(dir);
    await w.add(file).ready;
    const trees = () => native.calls.filter((call) => call.recursive).length;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const before = trees();
      native.made
        .get(`tree:${dir}`)!
        .emit("error", Object.assign(new Error("lost"), { code: "EIO" }));
      await until(() => trees() === before + 1);
    }
    w.unwatch(dir);
    await w.add(dir).ready;
    const before = trees();
    const count = errors.length;
    native.made
      .get(`tree:${dir}`)!
      .emit("error", Object.assign(new Error("lost"), { code: "EIO" }));
    await until(() => errors.length > count);
    await until(() => trees() === before + 1);
  });

  test("a followed link that is a root of its own and whose tree watch failed keeps its own watch", async () => {
    await symlink(outside, join(dir, "link"));
    native.failTreeFor.add(join(dir, "link"));
    const { seen } = await start([dir, join(dir, "link")]);
    await writeUntil(join(outside, "a.txt"), () =>
      seen.some(([, path]) => path === join(dir, "link", "a.txt")),
    );
  });

  test("unwatch() closes the recursive watch", async () => {
    const { w } = await start(dir);
    w.unwatch(dir);
    expect(native.closed).toEqual([`tree:${dir}`]);
  });
});

describe("where recursive watching is not available", () => {
  test("every directory is watched on its own and changes are reported", async () => {
    native.unsupported = true;
    await tree(3);
    const { seen } = await start(dir);
    expect(native.calls.filter((call) => !call.recursive).map((call) => call.path)).toContain(
      join(dir, "d2", "inner"),
    );
    await writeFile(join(dir, "d2", "inner", "a.txt"), "1");
    await until(() => seen.length > 0);
    expect(seen).toEqual([["add", join(dir, "d2", "inner", "a.txt")]]);
  });

  test("a failed recursive watch does not report an error by itself", async () => {
    native.failTree = true;
    await tree(2);
    const { errors, seen } = await start(dir);
    expect(errors).toEqual([]);
    const file = join(dir, "d1", "inner", "a.txt");
    await writeUntil(file, () => seen.some(([, path]) => path === file));
    expect(errors).toEqual([]);
  });
});
