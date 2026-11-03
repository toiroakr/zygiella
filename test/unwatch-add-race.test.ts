import { mkdir, mkdtemp, realpath, rm as removeOnce, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// the listing of a directory is held after it was read, the first time and then the second time it is asked for, so that
// the test decides which read is where when `unwatch()` and `add()` run
const reads = vi.hoisted(() => ({
  holds: [] as Array<{
    path: string;
    reached: boolean;
    release: () => void;
    promise: Promise<void>;
  }>,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: (async (path: string, ...rest: unknown[]) => {
      const names = await (actual.readdir as unknown as (...args: unknown[]) => Promise<unknown>)(
        path,
        ...rest,
      );
      const hold = reads.holds.find(
        (candidate) => !candidate.reached && candidate.path === String(path),
      );
      if (hold) {
        hold.reached = true;
        await hold.promise;
      }
      return names;
    }) as typeof actual.readdir,
  };
});

const { watch } = await import("../src/index.ts");
type FSWatcher = ReturnType<typeof watch>;

const rm = (path: string) =>
  removeOnce(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

let dir: string;
let watchers: FSWatcher[];

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "zygiella-")));
  watchers = [];
  reads.holds.length = 0;
});

afterEach(async () => {
  for (const hold of reads.holds) hold.release();
  await Promise.all(watchers.map((w) => w.close()));
  await rm(dir);
});

async function until(predicate: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function hold(path: string) {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  const held = { path, reached: false, release, promise };
  reads.holds.push(held);
  return held;
}

async function sentinel(w: FSWatcher, seen: Array<[string, string]>, folder: string) {
  // whatever a stale read had announced is reported before this, so the assertion can wait for a condition
  const file = join(folder, "sentinel.txt");
  await writeFile(file, "1");
  await until(() => seen.some(([, path]) => path === file));
}

describe("unwatch then add of a directory while a read of one of its subdirectories is going on", () => {
  test("the old read does not report what the baseline of add() has not recorded yet", async () => {
    const sub = join(dir, "sub");
    await mkdir(sub);
    for (let i = 0; i < 5; i++) await writeFile(join(sub, `f${i}.txt`), "1");
    const w = watch(dir, { ignoreInitial: true });
    watchers.push(w);
    const seen: Array<[string, string]> = [];
    w.on("all", (event, path) => seen.push([event, path]));
    await w.ready;

    const old = hold(sub);
    const baseline = hold(sub);
    const rescanned = w.rescan();
    await until(() => old.reached);
    w.unwatch(dir);
    w.add(dir);
    // the baseline of add() has listed `sub` and has not recorded its files, while the old read is let go
    await until(() => baseline.reached);
    old.release();
    // the read that rescan() starts for `sub` after the release waits for the baseline, which is held until here, so the
    // rescan is not awaited before it
    await Promise.race([rescanned, new Promise((resolve) => setTimeout(resolve, 200))]);
    baseline.release();
    await rescanned;
    await w.ready;
    await sentinel(w, seen, dir);

    expect(seen).toEqual([["add", join(dir, "sentinel.txt")]]);
  }, 30_000);
});

describe("unwatch of two overlapping roots, then add of the inner one, while a read of it is going on", () => {
  test("the old read of the inner root does not report what the baseline has not recorded yet", async () => {
    const sub = join(dir, "sub");
    await mkdir(sub);
    for (let i = 0; i < 5; i++) await writeFile(join(sub, `f${i}.txt`), "1");
    const w = watch([dir, sub], { ignoreInitial: true });
    watchers.push(w);
    const seen: Array<[string, string]> = [];
    w.on("all", (event, path) => seen.push([event, path]));
    await w.ready;

    const old = hold(sub);
    const baseline = hold(sub);
    const rescanned = w.rescan();
    await until(() => old.reached);
    // the first removal leaves the inner root covered by the outer one, the second one does not
    w.unwatch([sub, dir]);
    w.add(sub);
    // the baseline of add() runs after the old read of the same root, which is let go first
    old.release();
    await until(() => baseline.reached);
    baseline.release();
    await rescanned;
    await w.ready;
    await sentinel(w, seen, sub);

    expect(seen).toEqual([["add", join(sub, "sentinel.txt")]]);
  }, 30_000);
});
