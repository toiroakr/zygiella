import { mkdtemp, realpath, rm as removeOnce, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// the native `change` events of the OS are kept back and the test delivers them itself, so that when the watcher is told
// about a write is the test's choice and not the timing of FSEvents / inotify
const native = vi.hoisted(() => ({
  listeners: [] as Array<() => void>,
  sizesRead: [] as number[],
  watched: "",
  deliver() {
    for (const listener of native.listeners) listener();
  },
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    watch: ((...args: Parameters<typeof actual.watch>) => {
      const watcher = actual.watch(...args);
      const on = watcher.on.bind(watcher) as (event: string, listener: () => void) => unknown;
      watcher.on = ((event: string, listener: () => void) => {
        if (event === "change") native.listeners.push(listener);
        return event === "change" ? watcher : on(event, listener);
      }) as typeof watcher.on;
      return watcher;
    }) as typeof actual.watch,
  };
});

// the sizes the watcher read for the watched file, so the test can wait for the read that saw the truncated file
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const recording = (read: typeof actual.stat): typeof actual.stat =>
    (async (path: string, ...rest: unknown[]) => {
      const info = await (read as (...args: unknown[]) => Promise<{ size: number }>)(path, ...rest);
      if (path === native.watched) native.sizesRead.push(info.size);
      return info;
    }) as typeof actual.stat;
  return { ...actual, stat: recording(actual.stat), lstat: recording(actual.lstat) };
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
  native.listeners = [];
  native.sizesRead = [];
  native.watched = "";
});

afterEach(async () => {
  await Promise.all(watchers.map((w) => w.close()));
  await rm(dir, { recursive: true, force: true });
});

async function until(predicate: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function watching(target: string, file: string) {
  native.watched = file;
  const w = watch(target, { ignoreInitial: true });
  watchers.push(w);
  const seen: Array<[string, string]> = [];
  w.on("all", (event, path) => seen.push([event, path]));
  await new Promise<void>((r) => w.once("ready", () => r()));
  return { w, seen };
}

// a report that is waiting keeps the entry as it was last reported, so the size the snapshot holds says whether one is
async function sizeAfterLateEvent(w: FSWatcher, file: string): Promise<number | undefined> {
  const reads = native.sizesRead.length;
  native.deliver();
  await until(() => native.sizesRead.length > reads);
  return w.snapshot().entries.find((entry) => entry.path === file)?.size;
}

describe("a write whose native event arrives after the quiet period", () => {
  test("is reported as add only when a new file was empty at the first read and complete at the second", async () => {
    const file = join(dir, "a.txt");
    const { w, seen } = await watching(dir, file);

    await writeFile(file, "");
    native.deliver();
    await until(() => native.sizesRead.includes(0));
    await writeFile(file, "22");
    await until(() => seen.length > 0);

    expect(await sizeAfterLateEvent(w, file)).toBe(2);
    expect(seen).toEqual([["add", file]]);
  });

  test("is reported as one change when the file was truncated at the first read and complete at the second", async () => {
    const file = join(dir, "a.txt");
    await writeFile(file, "1");
    const { w, seen } = await watching(file, file);

    await truncate(file, 0);
    native.deliver();
    await until(() => native.sizesRead.includes(0));
    await writeFile(file, "22");
    await until(() => seen.length > 0);

    expect(await sizeAfterLateEvent(w, file)).toBe(2);
    expect(seen).toEqual([["change", file]]);
  });
});
