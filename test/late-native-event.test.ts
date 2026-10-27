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
  holdNext: false,
  held: false,
  gate: Promise.resolve(),
  open: () => {},
  deliver() {
    for (const listener of native.listeners) listener();
  },
  // the next read of the watched file has its result kept back, as when the completion of one `stat` is delivered late
  hold() {
    native.holdNext = true;
    native.held = false;
    native.gate = new Promise<void>((resolve) => {
      native.open = resolve;
    });
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
      if (path === native.watched) {
        native.sizesRead.push(info.size);
        if (native.holdNext) {
          native.holdNext = false;
          native.held = true;
          await native.gate;
        }
      }
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
  native.holdNext = false;
  native.held = false;
  native.open = () => {};
});

afterEach(async () => {
  native.open();
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

async function sizeLastReportedAfterLateEvent(
  w: FSWatcher,
  file: string,
): Promise<number | undefined> {
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

    expect(await sizeLastReportedAfterLateEvent(w, file)).toBe(2);
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

    expect(await sizeLastReportedAfterLateEvent(w, file)).toBe(2);
    expect(seen).toEqual([["change", file]]);
  });
});

describe("a read of the file that completes after the change was reported", () => {
  test("does not report the write again when it had seen the truncated file", async () => {
    const file = join(dir, "a.txt");
    await writeFile(file, "1");
    const seen = await watching(file, file);

    await truncate(file, 0);
    native.deliver();
    await until(() => native.sizesRead.includes(0));
    native.hold();
    native.deliver();
    await until(() => native.held);
    await writeFile(file, "22");
    await until(() => seen.length > 0);
    native.open();
    await settle();

    expect(seen).toEqual([["change", file]]);
  });
});
