import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, realpath, rm as removeOnce, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { watch, type FSWatcher } from "../src/index.ts";

// the children below run the real fs.watch; only this process has it silenced
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  watch: () => Object.assign(new EventEmitter(), { close: () => {} }),
}));

let dir: string;
let watcher: FSWatcher | undefined;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "zygiella-interval-")));
});

afterEach(async () => {
  await watcher?.close();
  watcher = undefined;
  await removeOnce(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

test("rescanInterval reports a created file without rescan() being called", async () => {
  watcher = watch(dir, { ignoreInitial: true, rescanInterval: 50 });
  const seen: string[] = [];
  watcher.on("add", (path) => seen.push(path));
  await watcher.ready;
  await writeFile(join(dir, "a.txt"), "1");
  await vi.waitUntil(() => seen.length > 0, 3000);
  expect(seen).toEqual([join(dir, "a.txt")]);
});

test("rescanInterval reports a change to a file that was already there", async () => {
  await writeFile(join(dir, "a.txt"), "1");
  watcher = watch(dir, { ignoreInitial: true, rescanInterval: 50 });
  const seen: string[] = [];
  watcher.on("change", (path) => seen.push(path));
  await watcher.ready;
  await writeFile(join(dir, "a.txt"), "22");
  await vi.waitUntil(() => seen.length > 0, 3000);
  expect(seen).toEqual([join(dir, "a.txt")]);
});

test("a change is reported once although the timer keeps reading", async () => {
  watcher = watch(dir, { ignoreInitial: true, rescanInterval: 20 });
  const seen: string[] = [];
  watcher.on("all", (event, path) => seen.push(`${event} ${path}`));
  await watcher.ready;
  await writeFile(join(dir, "a.txt"), "1");
  await vi.waitUntil(() => seen.length > 0, 3000);
  // several more reads happen before the next check
  for (let i = 0; i < 5; i++) await watcher.rescan();
  expect(seen).toEqual([`add ${join(dir, "a.txt")}`]);
});

test.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31])(
  "rescanInterval of %s is rejected",
  (value) => {
    expect(() => watch(dir, { rescanInterval: value })).toThrow(RangeError);
  },
);

describe("process lifetime", () => {
  const entry = pathToFileURL(join(import.meta.dirname, "../src/index.ts")).href;

  const children: ChildProcess[] = [];
  afterEach(() => {
    for (const proc of children) proc.kill();
    children.length = 0;
  });

  function child(options: string, after = "") {
    const body = `
      import { watch } from ${JSON.stringify(entry)};
      const w = watch(${JSON.stringify(dir)}, ${options});
      await w.ready;
      ${after}
    `;
    const proc = spawn(process.execPath, ["--input-type=module", "-e", body], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    children.push(proc);
    return new Promise<number | null>((done) => {
      const timer = setTimeout(() => proc.kill(), 5000);
      proc.once("close", (code) => {
        clearTimeout(timer);
        done(code);
      });
    });
  }

  test("a watcher closed with the timer running lets the process exit", async () => {
    expect(await child("{ rescanInterval: 60_000 }", "await w.close();")).toBe(0);
  });

  test("persistent: false lets the process exit with the timer left running", async () => {
    expect(await child("{ rescanInterval: 60_000, persistent: false }")).toBe(0);
  });
});
