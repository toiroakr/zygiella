import { renameSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm as removeOnce, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { watch, type FSWatcher } from "../src/index.ts";

const rm = (path: string, options: Parameters<typeof removeOnce>[1] = {}) =>
  removeOnce(path, { maxRetries: 10, retryDelay: 50, ...options });

let dir: string;
let watchers: FSWatcher[];

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "zygiella-replace-")));
  watchers = [];
});

afterEach(async () => {
  await Promise.all(watchers.map((w) => w.close()));
  await rm(dir, { recursive: true, force: true });
});

async function start(paths: string | string[], opts: Parameters<typeof watch>[1] = {}) {
  const w = watch(paths, { ignoreInitial: true, atomic: false, ...opts });
  watchers.push(w);
  const seen: Array<[string, string]> = [];
  w.on("all", (event, path) => seen.push([event, path]));
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

const reported = (seen: Array<[string, string]>, event: string, path: string) =>
  seen.some(([e, p]) => e === event && p === path);

// one after the other without a pause, so that the watcher cannot read `src` between the two
function replaceSrc() {
  renameSync(join(dir, "src"), join(dir, "src.old"));
  renameSync(join(dir, "staging"), join(dir, "src"));
}

test("a directory replaced by another directory reports what was in it as removed and what is in it now as added", async () => {
  await mkdir(join(dir, "src"));
  await writeFile(join(dir, "src", "a.ts"), "a");
  await mkdir(join(dir, "staging"));
  await writeFile(join(dir, "staging", "b.ts"), "b");
  const { seen } = await start(dir);
  replaceSrc();
  await until(() => reported(seen, "add", join(dir, "src", "b.ts")));
  expect(reported(seen, "unlink", join(dir, "src", "a.ts"))).toBe(true);
  const indexOf = (event: string) =>
    seen.findIndex(([e, p]) => e === event && p === join(dir, "src"));
  expect(indexOf("unlinkDir")).toBeGreaterThanOrEqual(0);
  expect(indexOf("unlinkDir")).toBeLessThan(indexOf("addDir"));
});

// Windows refuses to rename a directory while a watch is open on a directory inside it (EPERM)
test.skipIf(process.platform === "win32")(
  "a directory replaced by another directory is read again in its subdirectories",
  async () => {
    await mkdir(join(dir, "src", "deep"), { recursive: true });
    await writeFile(join(dir, "src", "deep", "a.ts"), "a");
    await mkdir(join(dir, "staging", "deep"), { recursive: true });
    await writeFile(join(dir, "staging", "deep", "b.ts"), "b");
    const { seen } = await start(dir);
    replaceSrc();
    await until(() => reported(seen, "add", join(dir, "src", "deep", "b.ts")));
    expect(reported(seen, "unlink", join(dir, "src", "deep", "a.ts"))).toBe(true);
  },
);

test("a directory that is only written to is not reported as replaced", async () => {
  await mkdir(join(dir, "src"));
  await writeFile(join(dir, "src", "a.ts"), "a");
  const { seen } = await start(dir);
  await writeFile(join(dir, "src", "b.ts"), "b");
  await until(() => reported(seen, "add", join(dir, "src", "b.ts")));
  expect(seen.filter(([e]) => e === "unlinkDir" || e === "addDir")).toEqual([]);
});
