import { describe, expect, test } from "vitest";
import { readsInFlight } from "../src/reads.ts";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred() {
  let done!: () => void;
  const promise = new Promise<void>((resolve) => (done = resolve));
  return { promise, done };
}

describe("the reads that are in flight", () => {
  test("is nothing to wait for while no read is in flight", () => {
    expect(readsInFlight().all()).toBeUndefined();
  });

  test("an older read of a directory is still waited for after a newer read of it finished", async () => {
    const reads = readsInFlight();
    const older = deferred();
    const newer = deferred();
    reads.track("/d", older.promise);
    reads.track("/d", newer.promise);
    newer.done();
    await flush();
    let waited = false;
    void reads.all()?.then(() => (waited = true));
    await flush();
    expect(waited).toBe(false);
    older.done();
    await flush();
    expect(waited).toBe(true);
  });

  test("a read that finished is forgotten", async () => {
    const reads = readsInFlight();
    const read = deferred();
    reads.track("/d", read.promise);
    read.done();
    await flush();
    expect(reads.all()).toBeUndefined();
  });

  test("a read that failed is forgotten too", async () => {
    const reads = readsInFlight();
    const failed = Promise.reject(new Error("EACCES"));
    reads.track("/d", failed);
    await flush();
    expect(reads.all()).toBeUndefined();
  });

  test("the same promise is returned until the reads in flight change", async () => {
    const reads = readsInFlight();
    const first = deferred();
    reads.track("/a", first.promise);
    const all = reads.all();
    expect(reads.all()).toBe(all);
    reads.track("/b", deferred().promise);
    expect(reads.all()).not.toBe(all);
    first.done();
  });
});
