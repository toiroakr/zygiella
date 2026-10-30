import type { Stats } from "node:fs";
import { describe, expect, test } from "vitest";
import { pendingEvents } from "../src/pending.ts";

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
    settled: () => {},
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
      settled: () => {},
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
      settled: () => {},
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
      settled: () => {},
    });
    pending.announce("add", "/d/b.txt", undefined, "/d/a.txt");
    pending.announce("change", "/d/b.txt");
    await flush();
    expect(renamedFrom).toEqual([undefined]);
  });
});
