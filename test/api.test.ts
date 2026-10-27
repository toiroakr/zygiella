import { EventEmitter } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { watch, type FSWatcher } from "../src/index.ts";

let dir: string;
let watcher: FSWatcher | undefined;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "zygiella-api-")));
});

afterEach(async () => {
  await watcher?.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

test("watch() returns an EventEmitter that has every method chokidar's FSWatcher has here", () => {
  watcher = watch(dir);
  expect(watcher).toBeInstanceOf(EventEmitter);
  for (const method of [
    "on",
    "off",
    "once",
    "emit",
    "add",
    "unwatch",
    "rescan",
    "close",
    "snapshot",
  ])
    expect(typeof watcher[method as keyof FSWatcher], method).toBe("function");
});

test("add and unwatch return the watcher so calls can be chained", () => {
  watcher = watch(dir);
  expect(watcher.add(dir)).toBe(watcher);
  expect(watcher.unwatch(join(dir, "nothing"))).toBe(watcher);
});

test("ready is a promise and unwatched is a list, as properties", async () => {
  watcher = watch(dir);
  expect(await watcher.ready).toEqual({ missing: [] });
  expect(watcher.unwatched).toEqual([]);
});
