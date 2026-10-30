import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm as removeOnce, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// the native watch of the root that appears is silent, as it is while FSEvents has not started delivering; the watch
// of the directory above it, and everything else, is real
const native = vi.hoisted(() => ({ target: "", listed: 0 }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    watch: ((path: string, ...rest: unknown[]) => {
      if (native.target && String(path).startsWith(native.target))
        return Object.assign(new EventEmitter(), { close() {}, ref() {}, unref() {} });
      return (actual.watch as unknown as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof actual.watch,
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: (async (path: string, ...rest: unknown[]) => {
      const names = await (actual.readdir as unknown as (...args: unknown[]) => Promise<unknown>)(
        path,
        ...rest,
      );
      if (native.target && String(path) === native.target) native.listed++;
      return names;
    }) as typeof actual.readdir,
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
  native.target = "";
  native.listed = 0;
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

describe("a root that did not exist when the watcher started", () => {
  test("reports a file written after the first read of the root, while its native watch delivers nothing", async () => {
    const target = join(dir, "later");
    native.target = target;
    const w = watch(target, { ignoreInitial: true });
    watchers.push(w);
    const seen: Array<[string, string]> = [];
    w.on("all", (event, path) => seen.push([event, path]));
    await new Promise<void>((r) => w.once("ready", () => r()));
    await mkdir(target);
    await until(() => seen.some(([event]) => event === "addDir"));
    await until(() => native.listed > 0);
    await writeFile(join(target, "a.txt"), "1");
    await until(() => seen.some(([event]) => event === "add"));
    expect(seen.at(-1)).toEqual(["add", join(target, "a.txt")]);
  });
});
