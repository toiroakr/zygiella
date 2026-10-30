import type { Stats } from "node:fs";
import { describe, expect, test } from "vitest";
import { pendingEvents, type Pending } from "../src/pending.ts";
import type { Entry } from "../src/types.ts";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function harness(size: () => number | undefined) {
  const timers: Array<{ ms: number; fn: () => void }> = [];
  const reported: Array<[string, string]> = [];
  const pending = pendingEvents({
    atomic: 0,
    settle: undefined,
    followSymlinks: true,
    timeout: (fn, ms) => {
      timers.push({ ms, fn });
      return {} as NodeJS.Timeout;
    },
    dispatch: (event, path) => reported.push([event, path]),
    stat: async () => {
      const bytes = size();
      if (bytes === undefined) throw Object.assign(new Error("gone"), { code: "ENOENT" });
      return { size: bytes, isSymbolicLink: () => false } as Stats;
    },
    settled: () => undefined,
  });
  return { pending, timers, reported };
}

describe("reporting add and change without waiting for a quiet period", () => {
  test("an add of a file that has content is reported before any timer fires", async () => {
    const { pending, reported } = harness(() => 3);
    pending.announce("add", "/d/a.txt");
    await flush();
    expect(reported).toEqual([["add", "/d/a.txt"]]);
  });

  test("an add of an empty file is held for 10 ms and then reported", async () => {
    const { pending, timers, reported } = harness(() => 0);
    pending.announce("add", "/d/a.txt");
    await flush();
    expect(reported).toEqual([]);
    expect(timers.map((t) => t.ms)).toEqual([10]);
    timers[0]!.fn();
    await flush();
    expect(reported).toEqual([["add", "/d/a.txt"]]);
  });

  test("a change of a file that has content is reported before any timer fires", async () => {
    const { pending, reported } = harness(() => 3);
    pending.announce("change", "/d/a.txt");
    await flush();
    expect(reported).toEqual([["change", "/d/a.txt"]]);
  });

  test("an announce while the first read is in flight reports once", async () => {
    const { pending, reported } = harness(() => 3);
    pending.announce("add", "/d/a.txt");
    pending.announce("change", "/d/a.txt");
    await flush();
    expect(reported).toEqual([["add", "/d/a.txt"]]);
  });

  test("a change within 50 ms of a report waits for a quiet period", async () => {
    const { pending, timers, reported } = harness(() => 3);
    pending.announce("change", "/d/a.txt");
    await flush();
    pending.announce("change", "/d/a.txt");
    await flush();
    expect(reported).toEqual([["change", "/d/a.txt"]]);
    timers.at(-1)!.fn();
    await flush();
    expect(reported).toEqual([
      ["change", "/d/a.txt"],
      ["change", "/d/a.txt"],
    ]);
  });

  test("an empty file that gets its data while held is reported at once", async () => {
    let size = 0;
    const { pending, reported } = harness(() => size);
    pending.announce("add", "/d/a.txt");
    await flush();
    size = 3;
    pending.announce("change", "/d/a.txt");
    await flush();
    expect(reported).toEqual([["add", "/d/a.txt"]]);
  });

  test("the first report of an add waits for what `after` returns", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const reported: string[] = [];
    const pending = pendingEvents({
      atomic: 0,
      settle: undefined,
      followSymlinks: true,
      timeout: () => ({}) as NodeJS.Timeout,
      dispatch: (event) => reported.push(event),
      stat: async () => ({ size: 3, isSymbolicLink: () => false }) as Stats,
      settled: () => undefined,
      after: () => gate,
    });
    pending.announce("add", "/d/a.txt");
    await flush();
    expect(reported).toEqual([]);
    release();
    await flush();
    expect(reported).toEqual(["add"]);
  });

  test("an add of a file that is already gone waits for the quiet period, so that its removal takes it back", async () => {
    const { pending, timers, reported } = harness(() => undefined);
    pending.announce("add", "/d/a.txt");
    await flush();
    expect(timers.map((t) => t.ms)).toEqual([50]);
    pending.cancel("/d/a.txt");
    timers[0]!.fn();
    await flush();
    expect(reported).toEqual([]);
  });

  test("the first report of an add waits no longer than the quiet period for what `after` returns", async () => {
    const timers: Array<{ ms: number; fn: () => void }> = [];
    const reported: string[] = [];
    const pending = pendingEvents({
      atomic: 0,
      settle: undefined,
      followSymlinks: true,
      timeout: (fn, ms) => {
        timers.push({ ms, fn });
        return {} as NodeJS.Timeout;
      },
      dispatch: (event) => reported.push(event),
      stat: async () => ({ size: 3, isSymbolicLink: () => false }) as Stats,
      settled: () => undefined,
      after: () => new Promise(() => {}),
    });
    pending.announce("add", "/d/a.txt");
    await flush();
    expect(reported).toEqual([]);
    expect(timers.map((t) => t.ms)).toEqual([50]);
    timers[0]!.fn();
    await flush();
    expect(reported).toEqual(["add"]);
  });

  test("a file created again after its removal is reported at once, not after the quiet period", async () => {
    const { pending, timers, reported } = harness(() => 3);
    pending.announce("add", "/d/a.txt");
    await flush();
    pending.cancel("/d/a.txt");
    pending.announce("add", "/d/a.txt");
    await flush();
    expect(reported).toEqual([
      ["add", "/d/a.txt"],
      ["add", "/d/a.txt"],
    ]);
    expect(timers.map((t) => t.ms)).toEqual([50, 50]);
  });

  test("an announce during the first read drops the path the add was paired with", async () => {
    const renamedFrom: Array<string | undefined> = [];
    const pending = pendingEvents({
      atomic: 0,
      settle: undefined,
      followSymlinks: true,
      timeout: () => ({}) as NodeJS.Timeout,
      dispatch: (_event, _path, from) => renamedFrom.push(from),
      stat: async () => ({ size: 3, isSymbolicLink: () => false }) as Stats,
      settled: () => undefined,
    });
    pending.announce("add", "/d/b.txt", undefined, "/d/a.txt");
    pending.announce("change", "/d/b.txt");
    await flush();
    expect(renamedFrom).toEqual([undefined]);
  });

  test("a write announced while the first read is in flight is read again before the report", async () => {
    const reported: string[] = [];
    const settledSizes: number[] = [];
    let calls = 0;
    let release!: () => void;
    const pending = pendingEvents({
      atomic: 0,
      settle: undefined,
      followSymlinks: true,
      timeout: () => ({}) as NodeJS.Timeout,
      dispatch: (event) => reported.push(event),
      stat: () => {
        calls++;
        if (calls > 1) return Promise.resolve({ size: 5, isSymbolicLink: () => false } as Stats);
        return new Promise<Stats>((resolve) => {
          release = () => resolve({ size: 1, isSymbolicLink: () => false } as Stats);
        });
      },
      settled: (_path, info) => {
        settledSizes.push(info.size);
        return undefined;
      },
    });
    pending.announce("add", "/d/a.txt");
    await flush();
    pending.announce("change", "/d/a.txt");
    release();
    await flush();
    expect(settledSizes).toEqual([5]);
    expect(reported).toEqual(["add"]);
  });

  test("a change does not wait for what `after` returns", async () => {
    const reported: string[] = [];
    const pending = pendingEvents({
      atomic: 0,
      settle: undefined,
      followSymlinks: true,
      timeout: () => ({}) as NodeJS.Timeout,
      dispatch: (event) => reported.push(event),
      stat: async () => ({ size: 3, isSymbolicLink: () => false }) as Stats,
      settled: () => undefined,
      after: () => new Promise(() => {}),
    });
    pending.announce("change", "/d/a.txt");
    await flush();
    expect(reported).toEqual(["change"]);
  });

  test("writes that go on during every read cannot postpone the first report: the reads are bounded and the writes follow as a change", async () => {
    const timers: Array<() => void> = [];
    const reported: string[] = [];
    let calls = 0;
    const pending: Pending = pendingEvents({
      atomic: 0,
      settle: undefined,
      followSymlinks: true,
      timeout: (fn) => {
        timers.push(fn);
        return {} as NodeJS.Timeout;
      },
      dispatch: (event) => reported.push(event),
      stat: () => {
        calls++;
        if (calls <= 20) pending.announce("change", "/d/a.txt");
        return Promise.resolve({ size: 3, isSymbolicLink: () => false } as Stats);
      },
      settled: () => undefined,
    });
    pending.announce("add", "/d/a.txt");
    await flush();
    expect(reported).toEqual(["add"]);
    expect(calls).toBeLessThanOrEqual(4);
    for (const fn of timers) fn();
    await flush();
    expect(reported).toEqual(["add", "change"]);
  });

  function sustained(onDispatch: (event: string, pending: Pending) => void, recorded?: Entry) {
    const timers: Array<() => void> = [];
    const reported: string[] = [];
    let calls = 0;
    const pending: Pending = pendingEvents({
      atomic: 0,
      settle: undefined,
      followSymlinks: true,
      timeout: (fn) => {
        timers.push(fn);
        return {} as NodeJS.Timeout;
      },
      dispatch: (event) => {
        reported.push(event);
        onDispatch(event, pending);
      },
      stat: () => {
        calls++;
        // during each of the reads that the first report is allowed, and not afterwards
        if (calls <= 3) pending.announce("change", "/d/a.txt");
        return Promise.resolve({ size: 3, isSymbolicLink: () => false } as Stats);
      },
      settled: () => recorded,
    });
    return { pending, timers, reported };
  }

  test("a listener that stops watching the path when its add is reported gets no change afterwards", async () => {
    const { pending, timers, reported } = sustained((event, p) => {
      if (event === "add") p.cancel("/d/a.txt");
    });
    pending.announce("add", "/d/a.txt");
    await flush();
    for (const fn of timers) fn();
    await flush();
    expect(reported).toEqual(["add"]);
  });

  test("the change that follows sustained writes starts from the entry that was recorded for the add", async () => {
    const recorded: Entry = { dir: false, mtimeMs: 1, size: 3, ino: 1 };
    const { pending } = sustained(() => {}, recorded);
    pending.announce("add", "/d/a.txt");
    await flush();
    expect(pending.baseline("/d/a.txt", { dir: false, mtimeMs: 2, size: 9, ino: 1 })).toBe(
      recorded,
    );
  });
});
