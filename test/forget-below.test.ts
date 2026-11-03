import { mkdir, mkdtemp, realpath, rm as removeOnce, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { watch, type FSWatcher } from "../src/index.ts";

// Silent native watches that the test drives itself: a native event for the removal below is not always delivered on
// macOS when the machine is busy (an independent fs.watch of the directory got none either). The test raises the event
// of the directory alone, so that only the read of that directory sees the removal and what it reports is checked.
const native = vi.hoisted(() => ({
  emitters: [] as Array<{ path: string; emitter: import("node:events").EventEmitter }>,
}));

vi.mock("node:fs", async (importOriginal) => {
  const { EventEmitter } = await import("node:events");
  return {
    ...(await importOriginal<typeof import("node:fs")>()),
    watch: (path: string) => {
      const emitter = Object.assign(new EventEmitter(), { close: () => {} });
      native.emitters.push({ path: String(path), emitter });
      return emitter;
    },
  };
});

const rm = (path: string) =>
  removeOnce(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

let dir: string;
let watchers: FSWatcher[];

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "zygiella-")));
  watchers = [];
  native.emitters.length = 0;
});

afterEach(async () => {
  await Promise.all(watchers.map((w) => w.close()));
  await rm(dir);
});

async function start(paths: string | string[], opts: Parameters<typeof watch>[1]) {
  const w = watch(paths, opts);
  watchers.push(w);
  const seen: Array<[string, string]> = [];
  w.on("all", (event, path) => seen.push([event, path]));
  await new Promise<void>((r) => w.once("ready", () => r()));
  return { w, seen };
}

async function until(predicate: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("unwatching a file system root returns instead of walking the root's own entry forever", async () => {
  const root = parse(dir).root;
  const { w } = await start(root, {
    depth: 0,
    ignoreInitial: true,
    ignored: (path) => path !== root,
  });
  w.unwatch(root);
  expect(w.getWatched()).toEqual({});
});

test("a removed directory reports what a watched root below an untracked directory kept before the directory itself", async () => {
  const deep = join(dir, "sub", "gap", "deep");
  await mkdir(deep, { recursive: true });
  await writeFile(join(deep, "f.txt"), "1");
  const { seen } = await start([dir, deep], { depth: 0 });
  await rm(join(dir, "sub"));
  for (const { path, emitter } of native.emitters)
    if (path === dir) emitter.emit("change", "rename", "sub");
  await until(() =>
    seen.some(([event, path]) => event === "unlinkDir" && path === join(dir, "sub")),
  );
  const order = seen.map(([event, path]) => `${event} ${path}`);
  expect(order.indexOf(`unlink ${join(deep, "f.txt")}`)).toBeGreaterThanOrEqual(0);
  expect(order.indexOf(`unlink ${join(deep, "f.txt")}`)).toBeLessThan(
    order.indexOf(`unlinkDir ${join(dir, "sub")}`),
  );
});
