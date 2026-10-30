import { mkdir, mkdtemp, realpath, rm as removeOnce, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// only lstat and stat are wrapped, to count how many run at once; everything else is the real file system
const inFlight = vi.hoisted(() => ({ now: 0, max: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const counted =
    <T extends (...args: never[]) => Promise<unknown>>(call: T) =>
    (...args: Parameters<T>) => {
      inFlight.max = Math.max(inFlight.max, ++inFlight.now);
      return (call(...args) as Promise<unknown>).finally(() => inFlight.now--);
    };
  return {
    ...actual,
    lstat: counted(actual.lstat) as typeof actual.lstat,
    stat: counted(actual.stat) as typeof actual.stat,
  };
});

const { watch } = await import("../src/index.ts");

const rm = (path: string, options: Parameters<typeof removeOnce>[1] = {}) =>
  removeOnce(path, { maxRetries: 10, retryDelay: 50, ...options });

// the scan holds at most 256 entries at once, and a directory is always read by at least one more
const AT_MOST = 300;

let dir: string;
let watcher: ReturnType<typeof watch> | undefined;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "zygiella-")));
  watcher = undefined;
  inFlight.now = 0;
  inFlight.max = 0;
});

afterEach(async () => {
  await watcher?.close();
  await rm(dir, { recursive: true, force: true });
});

async function files(parent: string, count: number): Promise<void> {
  await mkdir(parent, { recursive: true });
  // a few at a time: a host that allows 256 open files would fail with EMFILE if all of them were open at once
  for (let first = 0; first < count; first += 50)
    await Promise.all(
      Array.from({ length: Math.min(50, count - first) }, (_, i) =>
        writeFile(join(parent, `f${first + i}`), "1"),
      ),
    );
}

async function scan(): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  watcher = watch(dir, { atomic: false });
  watcher.on("all", (event) => counts.set(event, (counts.get(event) ?? 0) + 1));
  await new Promise<void>((r) => watcher!.once("ready", () => r()));
  return counts;
}

describe("the first scan", () => {
  test("reads a directory of 1000 files without 1000 reads at once, and reports every file", async () => {
    await files(join(dir, "flat"), 1000);
    const counts = await scan();
    expect(counts.get("add")).toBe(1000);
    expect(inFlight.max).toBeLessThanOrEqual(AT_MOST);
  });

  test("reads 8 directories of 125 files without 1000 reads at once, and reports every entry", async () => {
    for (let i = 0; i < 8; i++) await files(join(dir, `d${i}`), 125);
    const counts = await scan();
    expect(counts.get("add")).toBe(1000);
    expect(counts.get("addDir")).toBe(1 + 8);
    expect(inFlight.max).toBeLessThanOrEqual(AT_MOST);
  });

  test("reaches ready in a tree with more directories than the scan holds at once", async () => {
    for (let i = 0; i < 260; i++) await files(join(dir, `d${i}`, "inner"), 1);
    const counts = await scan();
    expect(counts.get("addDir")).toBe(1 + 260 * 2);
    expect(counts.get("add")).toBe(260);
  });
});
