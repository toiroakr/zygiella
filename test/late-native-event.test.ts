import { mkdtemp, realpath, rm as removeOnce, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// only the delivery of the native `change` events is replaced: while `held`, they are kept and `release` hands them over
const native = vi.hoisted(() => ({
  held: false,
  delivered: 0,
  kept: [] as Array<() => void>,
  release() {
    native.held = false;
    for (const deliver of native.kept.splice(0)) deliver();
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
        if (event !== "change") return on(event, listener);
        return on(event, () => {
          native.delivered++;
          if (native.held) native.kept.push(listener);
          else listener();
        });
      }) as typeof watcher.on;
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
  native.held = false;
  native.delivered = 0;
  native.kept = [];
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

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

describe("a write whose native event arrives after the quiet period", () => {
  test("is reported as one change when the file was truncated at the first read and complete at the second", async () => {
    const file = join(dir, "a.txt");
    await writeFile(file, "1");
    const w = watch(file, { ignoreInitial: true });
    watchers.push(w);
    const seen: Array<[string, string]> = [];
    w.on("all", (event, path) => seen.push([event, path]));
    await new Promise<void>((r) => w.once("ready", () => r()));

    await truncate(file, 0);
    await until(() => native.delivered > 0);
    // let the read triggered by the truncate see the empty file before the write starts
    await settle(10);
    native.held = true;
    await writeFile(file, "22");
    await until(() => seen.length > 0);
    native.release();
    await settle();

    expect(seen).toEqual([["change", file]]);
  });
});
