import { mkdir, mkdtemp, realpath, rm as removeOnce, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// only lstat and stat are wrapped, to count how many run at once and how many ran; everything else is the real file system
const inFlight = vi.hoisted(() => ({
  now: 0,
  max: 0,
  total: 0,
  // called with the number of calls so far, so a test can act in the middle of a scan
  onCall: undefined as ((total: number) => void) | undefined,
  // the same count for the paths below one directory, to see how many workers it was given
  below: { prefix: "", now: 0, max: 0 },
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const counted =
    <T extends (...args: never[]) => Promise<unknown>>(call: T) =>
    (...args: Parameters<T>) => {
      inFlight.max = Math.max(inFlight.max, ++inFlight.now);
      inFlight.onCall?.(++inFlight.total);
      const below =
        inFlight.below.prefix !== "" && String(args[0]).startsWith(inFlight.below.prefix);
      if (below) inFlight.below.max = Math.max(inFlight.below.max, ++inFlight.below.now);
      return (call(...args) as Promise<unknown>).finally(() => {
        inFlight.now--;
        if (below) inFlight.below.now--;
      });
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
  inFlight.total = 0;
  inFlight.onCall = undefined;
  inFlight.below = { prefix: "", now: 0, max: 0 };
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

  test("gives a large directory more workers once the others have finished, though it started when none were free", async () => {
    // "0big" sorts first, so a worker takes it while the other 255 are held by the small directories
    await files(join(dir, "0big"), 3000);
    for (let i = 0; i < 400; i++) await files(join(dir, `s${i}`), 1);
    inFlight.below.prefix = join(dir, "0big") + sep;
    await scan();
    expect(inFlight.below.max).toBeGreaterThan(8);
  });

  test("checks the entries that are gone from a directory without 1000 reads at once, and reports each as removed", async () => {
    await files(join(dir, "flat"), 1000);
    const before = watch(dir, { atomic: false });
    await new Promise<void>((r) => before.once("ready", () => r()));
    const snapshot = before.snapshot();
    await before.close();
    // the directory stays, so it is the same directory with its files gone, and not another one under the same name
    for (let first = 0; first < 1000; first += 50)
      await Promise.all(
        Array.from({ length: 50 }, (_, i) => rm(join(dir, "flat", `f${first + i}`))),
      );
    inFlight.max = 0;
    watcher = watch(dir, { atomic: false, since: snapshot });
    const counts = new Map<string, number>();
    watcher.on("all", (event) => counts.set(event, (counts.get(event) ?? 0) + 1));
    await new Promise<void>((r) => watcher!.once("ready", () => r()));
    expect(counts.get("unlink")).toBe(1000);
    expect(inFlight.max).toBeLessThanOrEqual(AT_MOST);
  });

  test("stops reading the names of a directory once the watcher is closed", async () => {
    await files(join(dir, "flat"), 1000);
    const closed = new Promise<void>((done) => {
      inFlight.onCall = (total) => {
        if (total === 256) void watcher!.close().then(done);
      };
    });
    watcher = watch(dir, { atomic: false });
    await closed;
    expect(inFlight.total).toBeLessThanOrEqual(AT_MOST);
  });
});
