import { chmod, mkdtemp, realpath, rm as removeOnce, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { watch, type FSWatcher } from "../src/index.ts";

let dir: string;
let watcher: FSWatcher | undefined;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "zygiella-kinds-")));
});

afterEach(async () => {
  await watcher?.close();
  watcher = undefined;
  await removeOnce(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function until(predicate: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function start() {
  await writeFile(join(dir, "a.txt"), "hello");
  watcher = watch(dir, { ignoreInitial: true });
  const seen: unknown[][] = [];
  watcher.on("all", (...args) => seen.push(args));
  await watcher.ready;
  return seen;
}

test("a change of the modification time alone is reported as change, with the path only", async () => {
  const seen = await start();
  await utimes(join(dir, "a.txt"), new Date(2020, 0, 1), new Date(2020, 0, 1));
  await until(() => seen.length > 0);
  expect(seen).toEqual([["change", join(dir, "a.txt")]]);
});

// Windows keeps only a read-only flag, which chmod 0o600 does not change
test.skipIf(process.platform === "win32")(
  "a change of the permissions alone is not reported",
  async () => {
    const seen = await start();
    await chmod(join(dir, "a.txt"), 0o600);
    // the file made afterwards is reported only after the event of the chmod was handled
    await writeFile(join(dir, "b.txt"), "1");
    await until(() => seen.length > 0);
    expect(seen).toEqual([["add", join(dir, "b.txt")]]);
  },
);
