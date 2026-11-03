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
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    await rescanned;
    await settle(200);
    baseline.release();
    await w.ready;
    await settle(200);

    expect(seen).toEqual([]);
  });
});
