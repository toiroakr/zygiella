import { mkdir, mkdtemp, realpath, rm as removeOnce, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// the native `change` listeners are captured so that the test delivers an event itself, as FSEvents does for what was
// created just before watching
const native = vi.hoisted(() => ({
  listeners: [] as Array<{
    path: string;
    recursive: boolean;
    listener: (type: string, name: string) => void;
  }>,
  hold: undefined as { path: string; reached: boolean; promise: Promise<void> } | undefined,
  reads: new Map<string, number>(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    watch: ((path: string, ...rest: unknown[]) => {
      const options = typeof rest[0] === "object" ? (rest[0] as { recursive?: boolean }) : {};
      const watcher = (
        actual.watch as unknown as (...args: unknown[]) => {
          on: (event: string, listener: (...args: string[]) => void) => unknown;
        }
      )(path, ...rest);
      const on = watcher.on.bind(watcher);
      watcher.on = ((event: string, listener: (type: string, name: string) => void) => {
        if (event === "change")
          native.listeners.push({
            path: String(path),
            recursive: Boolean(options?.recursive),
            listener,
          });
        return on(event, listener as never);
      }) as typeof watcher.on;
      return watcher as never;
    }) as typeof actual.watch,
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: (async (path: string, ...rest: unknown[]) => {
      native.reads.set(String(path), (native.reads.get(String(path)) ?? 0) + 1);
      const names = await (actual.readdir as unknown as (...args: unknown[]) => Promise<unknown>)(
        path,
        ...rest,
      );
      const hold = native.hold;
      if (hold && !hold.reached && String(path) === hold.path) {
        hold.reached = true;
        await hold.promise;
      }
      return names;
    }) as typeof actual.readdir,
  };
});

const { watch } = await import("../src/index.ts");
type FSWatcher = ReturnType<typeof watch>;

const rm = (path: string, options: Parameters<typeof removeOnce>[1] = {}) =>
  removeOnce(path, { maxRetries: 10, retryDelay: 50, ...options });

let dir: string;
let sub: string;
let watchers: FSWatcher[];

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "zygiella-")));
  sub = join(dir, "sub");
  await mkdir(sub);
  for (let i = 0; i < 30; i++) await writeFile(join(sub, `f${i}`), "1");
  watchers = [];
  native.listeners.length = 0;
  native.hold = undefined;
  native.reads.clear();
});

afterEach(async () => {
  await Promise.all(watchers.map((w) => w.close()));
  await rm(dir, { recursive: true, force: true });
});

async function until(predicate: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Tells every native listener that something happened to `name` of `sub`, as its own kind of watch would. */
function deliver(name: string): void {
  for (const { path, recursive, listener } of native.listeners) {
    if (recursive) listener("rename", `sub/${name}`);
    else if (path === sub) listener("rename", name);
  }
}

describe("a native event that arrives while the first scan of a directory is reading", () => {
  test("does not report what the first scan is about to record, with ignoreInitial", async () => {
    let release!: () => void;
    native.hold = {
      path: sub,
      reached: false,
      promise: new Promise<void>((resolve) => (release = resolve)),
    };
    const w = watch(dir, { ignoreInitial: true, atomic: false });
    watchers.push(w);
    const seen: Array<[string, string]> = [];
    w.on("all", (event, path) => seen.push([event, path]));
    await until(() => native.hold!.reached);
    deliver("f0");
    // a read that does not wait for the first scan lists `sub` inside `deliver` and reports what nobody has recorded yet; one
    // that waits does not, so there is nothing to wait for then
    if ((native.reads.get(sub) ?? 0) > 1) await until(() => seen.length > 0);
    release();
    await new Promise<void>((r) => w.once("ready", () => r()));
    await until(() => (native.reads.get(sub) ?? 0) >= 2);
    expect(seen).toEqual([]);
  });

  test("does not read a directory again that the first scan found removed meanwhile", async () => {
    let release!: () => void;
    native.hold = {
      path: sub,
      reached: false,
      promise: new Promise<void>((resolve) => (release = resolve)),
    };
    const w = watch(dir, { ignoreInitial: true, atomic: false });
    watchers.push(w);
    const errors: Error[] = [];
    w.on("error", (error) => errors.push(error));
    await until(() => native.hold!.reached);
    deliver("f0");
    await rm(sub, { recursive: true });
    for (const { path, listener } of native.listeners) if (path === dir) listener("rename", "sub");
    release();
    await new Promise<void>((r) => w.once("ready", () => r()));
    await until(() => !(sub in w.getWatched()), 2000);
    expect(errors).toEqual([]);
  });

  test("is not held back by a rescan of the root, which records nothing new", async () => {
    const w = watch(dir, { ignoreInitial: true, atomic: false });
    watchers.push(w);
    await new Promise<void>((r) => w.once("ready", () => r()));
    let release!: () => void;
    native.hold = {
      path: dir,
      reached: false,
      promise: new Promise<void>((resolve) => (release = resolve)),
    };
    const rescan = w.rescan();
    try {
      await until(() => native.hold!.reached);
      const before = native.reads.get(sub) ?? 0;
      deliver("f0");
      await until(() => (native.reads.get(sub) ?? 0) > before);
    } finally {
      // close() in afterEach waits for the read that is held back
      release();
    }
    await rescan;
  });
});
