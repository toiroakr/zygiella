import { mkdir, mkdtemp, realpath, rm as removeOnce, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// only readdir is wrapped, to count how often a directory is read; everything else is the real file system
const reads = vi.hoisted(() => new Map<string, number>());
// names whose native events are swallowed, as when the OS drops or coalesces one
const dropped = vi.hoisted(() => new Set<string>());
// every path fs.watch was called for, to see which directory serves a path that does not exist yet
const opened = vi.hoisted(() => [] as string[]);
// holds the answer of one readdir back until `release` is called, after the directory was already listed
const gate = vi.hoisted(() => ({
  path: undefined as string | undefined,
  hold: undefined as Promise<void> | undefined,
  reached: false,
  // the next lstat of this path answers at once with what it saw, and is held back before it returns
  lstatPath: undefined as string | undefined,
  lstatHold: undefined as Promise<void> | undefined,
  lstatReached: false,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    watch: ((...args: Parameters<typeof actual.watch>) => {
      opened.push(String(args[0]));
      const watcher = actual.watch(...args);
      const on = watcher.on.bind(watcher);
      watcher.on = ((event: string, listener: (...rest: unknown[]) => void) =>
        on(
          event,
          event === "change"
            ? (type: unknown, name: unknown) => {
                if (!dropped.has(basename(String(name)))) listener(type, name);
              }
            : listener,
        )) as typeof watcher.on;
      return watcher;
    }) as typeof actual.watch,
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: ((path: string, ...rest: unknown[]) => {
      const seen = (actual.lstat as unknown as (...args: unknown[]) => Promise<unknown>)(
        path,
        ...rest,
      );
      if (gate.lstatHold && String(path) === gate.lstatPath) {
        const hold = gate.lstatHold;
        gate.lstatPath = undefined;
        gate.lstatHold = undefined;
        return seen.then(async (info) => {
          gate.lstatReached = true;
          await hold;
          return info;
        });
      }
      return seen;
    }) as typeof actual.lstat,
    readdir: ((path: string, ...rest: unknown[]) => {
      reads.set(String(path), (reads.get(String(path)) ?? 0) + 1);
      const listed = (actual.readdir as unknown as (...args: unknown[]) => Promise<unknown>)(
        path,
        ...rest,
      );
      if (gate.hold && String(path) === gate.path) {
        return listed.then(async (names) => {
          // the directory is listed now, so what is created from here on is not in this list
          gate.reached = true;
          await gate.hold;
          return names;
        });
      }
      return listed;
    }) as typeof actual.readdir,
  };
});

const { watch } = await import("../src/index.ts");
type FSWatcher = ReturnType<typeof watch>;

const rm = (path: string, options: Parameters<typeof removeOnce>[1] = {}) =>
  removeOnce(path, { maxRetries: 10, retryDelay: 50, ...options });

const LARGE = 1100;
let dir: string;
let big: string;
let watchers: FSWatcher[];

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "zygiella-")));
  big = join(dir, "big");
  await mkdir(big);
  // a few at a time: a host that allows 256 open files would fail with EMFILE if all of them were open at once
  for (let first = 0; first < LARGE; first += 50)
    await Promise.all(
      Array.from({ length: Math.min(50, LARGE - first) }, (_, i) =>
        writeFile(join(big, `f${first + i}`), "1"),
      ),
    );
  watchers = [];
  reads.clear();
  dropped.clear();
  opened.length = 0;
  gate.path = undefined;
  gate.hold = undefined;
  gate.reached = false;
  gate.lstatPath = undefined;
  gate.lstatHold = undefined;
  gate.lstatReached = false;
});

afterEach(async () => {
  await Promise.all(watchers.map((w) => w.close()));
  await rm(dir, { recursive: true, force: true });
});

async function start(path: string) {
  const w = watch(path, { ignoreInitial: true, atomic: false });
  watchers.push(w);
  const seen: Array<[string, string]> = [];
  w.on("all", (event, p) => seen.push([event, p]));
  await new Promise<void>((r) => w.once("ready", () => r()));
  return { w, seen };
}

async function until(predicate: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Waits until no directory has been read for a while: FSEvents may still deliver what was created just before watching. */
async function quiet(): Promise<void> {
  let last = JSON.stringify([...reads]);
  for (let stable = 0; stable < 5;) {
    await new Promise((r) => setTimeout(r, 40));
    const now = JSON.stringify([...reads]);
    stable = now === last ? stable + 1 : 0;
    last = now;
  }
}

describe("a directory with many entries", () => {
  test("reports a changed file without reading the directory again", async () => {
    const { seen } = await start(dir);
    await quiet();
    const before = reads.get(big);
    await writeFile(join(big, "f0"), "22");
    await until(() => seen.length > 0);
    expect(seen).toEqual([["change", join(big, "f0")]]);
    expect(reads.get(big)).toBe(before);
  });

  test("reports a new file and a removed file without reading the directory again", async () => {
    const { seen } = await start(dir);
    await quiet();
    const before = reads.get(big);
    await writeFile(join(big, "new"), "1");
    await until(() => seen.some(([event]) => event === "add"));
    await rm(join(big, "f1"));
    await until(() => seen.some(([event]) => event === "unlink"));
    expect(seen).toEqual([
      ["add", join(big, "new")],
      ["unlink", join(big, "f1")],
    ]);
    expect(reads.get(big)).toBe(before);
  });

  test("reports a new subdirectory and what is in it", async () => {
    const { seen } = await start(dir);
    await mkdir(join(big, "sub"));
    await writeFile(join(big, "sub", "a.txt"), "1");
    await until(() => seen.some(([event]) => event === "add"));
    expect(seen).toContainEqual(["addDir", join(big, "sub")]);
    expect(seen).toContainEqual(["add", join(big, "sub", "a.txt")]);
  });

  test("reports a removed subdirectory with what was below it", async () => {
    await mkdir(join(big, "sub"));
    await writeFile(join(big, "sub", "a.txt"), "1");
    const { seen } = await start(dir);
    await rm(join(big, "sub"), { recursive: true });
    await until(() => seen.some(([event]) => event === "unlinkDir"));
    expect(seen).toContainEqual(["unlink", join(big, "sub", "a.txt")]);
    expect(seen).toContainEqual(["unlinkDir", join(big, "sub")]);
  });

  test("reports a changed file without reading it again when it is the watched root", async () => {
    const { seen } = await start(big);
    await quiet();
    const before = reads.get(big);
    await writeFile(join(big, "f0"), "22");
    await until(() => seen.length > 0);
    expect(seen).toEqual([["change", join(big, "f0")]]);
    expect(reads.get(big)).toBe(before);
  });
});

describe("once the events of a directory with many entries have stopped", () => {
  test("the directory is read again once, however many events there were", async () => {
    const { seen } = await start(dir);
    await quiet();
    const before = reads.get(big) ?? 0;
    for (const name of ["f0", "f1", "f2"]) await writeFile(join(big, name), "22");
    await until(() => seen.length >= 3);
    await until(() => reads.get(big) === before + 1, 4000);
    await new Promise((r) => setTimeout(r, 300));
    expect(reads.get(big)).toBe(before + 1);
  });

  test("an entry whose event was lost is reported", async () => {
    const { seen } = await start(dir);
    dropped.add("ghost");
    await writeFile(join(big, "ghost"), "1");
    await writeFile(join(big, "f0"), "22");
    await until(() => seen.some(([, path]) => path === join(big, "ghost")), 4000);
    expect(seen).toContainEqual(["add", join(big, "ghost")]);
  });

  test("an entry whose event was lost is reported when the directory is the watched root", async () => {
    const { seen } = await start(big);
    dropped.add("ghost");
    await writeFile(join(big, "ghost"), "1");
    await writeFile(join(big, "f0"), "22");
    await until(() => seen.some(([, path]) => path === join(big, "ghost")), 4000);
    expect(seen).toContainEqual(["add", join(big, "ghost")]);
  });

  test("a file that is itself a watched path is reported as removed", async () => {
    const { seen } = await start(dir);
    const file = join(big, "f5");
    const watcher = watchers[0]!;
    await watcher.add(file).ready;
    await rm(file);
    await until(() => seen.some(([event]) => event === "unlink"));
    expect(seen).toEqual([["unlink", file]]);
  });
});

describe("a full read and a named entry read of the same large directory", () => {
  test("an entry created while the directory was being read is reported, and not as removed", async () => {
    const { w, seen } = await start(dir);
    await quiet();
    let release!: () => void;
    gate.path = big;
    gate.hold = new Promise<void>((done) => (release = done));
    const scan = w.rescan();
    try {
      await until(() => gate.reached);
      await writeFile(join(big, "late"), "1");
    } finally {
      // close() in afterEach waits for the read that is held back
      release();
    }
    await scan;
    await until(() => seen.some(([event, path]) => event === "add" && path === join(big, "late")));
    expect(seen.filter(([event]) => event === "unlink")).toEqual([]);
  });

  test("a file removed while the directory was being read is reported as removed, and not added again", async () => {
    const { w, seen } = await start(dir);
    await quiet();
    const file = join(big, "f7");
    const readsBefore = reads.get(big) ?? 0;
    let release!: () => void;
    gate.lstatPath = file;
    gate.lstatHold = new Promise<void>((done) => (release = done));
    const scan = w.rescan();
    try {
      await until(() => gate.lstatReached);
      await rm(file);
      // the read of the removal has to wait for the full read, which saw the file before it was removed
    } finally {
      release();
    }
    await scan;
    await until(() => seen.some(([event, path]) => event === "unlink" && path === file));
    // an add that was announced waits 50 ms before it is reported, and the audit that follows the events (1 s) is read
    // after that: the full read and the audit are two reads, in whichever order the rescan() saw them
    await until(() => (reads.get(big) ?? 0) >= readsBefore + 2, 4000);
    expect(seen.filter(([, path]) => path === file)).toEqual([["unlink", file]]);
    expect(w.snapshot().entries.map((entry) => entry.path)).not.toContain(file);
  });
});

describe("a large directory that other watched paths depend on", () => {
  test("a file that is itself a watched path is reported as removed when its own event was lost", async () => {
    const { w, seen } = await start(dir);
    const file = join(big, "f5");
    await w.add(file).ready;
    dropped.add("f5");
    await rm(file);
    await writeFile(join(big, "f0"), "22");
    await until(() => seen.some(([event]) => event === "unlink"), 4000);
    expect(seen).toContainEqual(["unlink", file]);
  });

  test("a path below it that did not exist yet is watched from the directory that now exists", async () => {
    const w = watch([big, join(big, "new", "a.txt")], { ignoreInitial: true, atomic: false });
    watchers.push(w);
    await w.ready;
    await mkdir(join(big, "new"));
    // the watch on `big` served the missing path until now; the sync of its root is what moves it
    // sooner than the audit of the directory would
    await until(() => opened.includes(join(big, "new")), 500);
  });
});

describe("a directory with few entries", () => {
  test("is read again for every event, so a missed event is repaired by the next one", async () => {
    await mkdir(join(dir, "small"));
    const { seen } = await start(dir);
    await quiet();
    const small = join(dir, "small");
    const before = reads.get(small) ?? 0;
    await writeFile(join(small, "a.txt"), "1");
    await until(() => seen.length > 0);
    expect(reads.get(small)).toBeGreaterThan(before);
  });
});
