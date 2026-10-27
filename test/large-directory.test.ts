import { mkdir, mkdtemp, realpath, rm as removeOnce, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// only readdir is wrapped, to count how often a directory is read; everything else is the real file system
const reads = vi.hoisted(() => new Map<string, number>());

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: ((path: string, ...rest: unknown[]) => {
      reads.set(String(path), (reads.get(String(path)) ?? 0) + 1);
      return (actual.readdir as unknown as (...args: unknown[]) => unknown)(path, ...rest);
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
  await Promise.all(Array.from({ length: LARGE }, (_, i) => writeFile(join(big, `f${i}`), "1")));
  watchers = [];
  reads.clear();
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
