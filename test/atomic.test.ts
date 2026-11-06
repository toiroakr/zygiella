import type { Stats } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveOptions } from "../src/options.ts";
import { pendingEvents } from "../src/pending.ts";
import type { Entry } from "../src/types.ts";

// Native filesystem delivery and setTimeout can be delayed independently on a
// busy runner. Test the atomic deadline itself without assuming a real sleep
// and an asynchronous write finish inside it. Native save events are covered
// by watch.test.ts.
afterEach(() => vi.useRealTimers());

function start(atomic: true | number) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const reported: Array<[string, string]> = [];
  const settings = resolveOptions({ atomic });
  const pending = pendingEvents({
    atomic: settings.atomicMs,
    settle: undefined,
    followSymlinks: true,
    timeout: (fn, ms) => setTimeout(fn, ms),
    dispatch: (event, path) => reported.push([event, path]),
    stat: async () => ({ size: 2, isSymbolicLink: () => false }) as Stats,
    settled: () => undefined,
  });
  return { pending, reported, window: settings.atomicMs };
}

const path = "/d/a.txt";
const entry: Entry = { dir: false, size: 1, mtimeMs: 1, ino: 1 };

describe.each([true, 500] as const)("atomic %s", (atomic) => {
  test("a replacement before the deadline reports one change and cancels the unlink", async () => {
    const { pending, reported, window } = start(atomic);
    expect(window).toBe(atomic === true ? 100 : atomic);
    pending.hold(path, entry);
    await vi.advanceTimersByTimeAsync(window - 1);
    expect(reported).toEqual([]);
    pending.announce("add", path);
    await vi.advanceTimersByTimeAsync(1);
    expect(reported).toEqual([["change", path]]);
    await vi.advanceTimersByTimeAsync(window + 50);
    expect(reported).toEqual([["change", path]]);
    expect(pending.isHeld(path)).toBe(false);
  });

  test("a replacement after the deadline reports unlink then add", async () => {
    const { pending, reported, window } = start(atomic);
    pending.hold(path, entry);
    await vi.advanceTimersByTimeAsync(window - 1);
    expect(reported).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(reported).toEqual([["unlink", path]]);
    pending.announce("add", path);
    await vi.advanceTimersByTimeAsync(0);
    expect(reported).toEqual([
      ["unlink", path],
      ["add", path],
    ]);
  });
});
