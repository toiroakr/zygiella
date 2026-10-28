import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm as removeOnce,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// the native `change` events of the OS are kept back and the test delivers them itself, so that when the watcher is told
// about a write is the test's choice and not the timing of FSEvents / inotify
const native = vi.hoisted(() => ({
  listeners: [] as Array<() => void>,
  sizesRead: [] as number[],
  linksRead: [] as string[],
  reads: [] as string[],
  root: "",
  watched: "",
  holdPath: "",
  holdFrom: "",
  holdEarly: false,
  fails: [] as Array<{ path: string; code: string }>,
  hidden: "",
  refreshGate: Promise.resolve(),
  releaseRefresh: () => {},
  holdNext: false,
  rejectHeld: false,
  held: false,
  gate: Promise.resolve(),
  open: () => {},
  deliver() {
    for (const listener of native.listeners) listener();
  },
  // the next read of the watched file has its result kept back, as when the completion of one `stat` is delivered late
  holdKind: "stat" as "stat" | "readlink" | "realpath",
  // `path` is the file whose read is kept back (the watched one by default), `from` a name in the stack of the call that made it
  hold(kind: "stat" | "readlink" | "realpath" = "stat", rejecting = false, path = "", from = "") {
    native.holdNext = true;
    native.holdKind = kind;
    native.holdPath = path;
    native.holdFrom = from;
    native.holdEarly = false;
    native.rejectHeld = rejecting;
    native.held = false;
    native.gate = new Promise<void>((resolve) => {
      native.open = resolve;
    });
  },
  // the read at the end of the quiet period is kept back until the test has finished writing, or it could see a half-written file
  holdRefresh() {
    native.refreshGate = new Promise<void>((resolve) => {
      native.releaseRefresh = resolve;
    });
  },
  // the read of `path` waits before it is made, so a file that is gone can be held too, as its read would fail at once
  holdBefore(path: string) {
    native.hold("stat", false, path);
    native.holdEarly = true;
  },
  // the listing of a directory leaves this name out, as when what is being deleted is not listed but can still be read
  hide(name: string) {
    native.hidden = name;
  },
  // each call makes one more read of `path` fail, in the order of the calls
  failNext(path: string, code = "ENOENT") {
    native.fails.push({ path, code });
  },
  async pause(kind: "stat" | "readlink" | "realpath", path: string, stack: string) {
    if (!native.holdNext || native.holdKind !== kind) return;
    if (path !== (native.holdPath || native.watched) || !stack.includes(native.holdFrom)) return;
    native.holdNext = false;
    native.held = true;
    await native.gate;
    if (native.rejectHeld) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  },
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    watch: ((...args: Parameters<typeof actual.watch>) => {
      const watcher = actual.watch(...args);
      const on = watcher.on.bind(watcher) as (event: string, listener: () => void) => unknown;
      watcher.on = ((event: string, listener: () => void) => {
        if (event === "change") native.listeners.push(listener);
        return event === "change" ? watcher : on(event, listener);
      }) as typeof watcher.on;
      return watcher;
    }) as typeof actual.watch,
  };
});

// the sizes the scans read for the watched file, so the test can wait for the read that saw the truncated file
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const isRefresh = (path: string, stack: string) =>
    path === native.watched && stack.includes("pending.ts");
  const recording = (read: typeof actual.stat): typeof actual.stat =>
    (async (path: string, ...rest: unknown[]) => {
      const stack = new Error().stack ?? "";
      const refresh = isRefresh(path, stack);
      if (refresh) await native.refreshGate;
      if (native.holdEarly && !refresh) await native.pause("stat", path, stack);
      const failing = refresh ? -1 : native.fails.findIndex((fail) => fail.path === path);
      if (failing >= 0) {
        const { code } = native.fails[failing]!;
        native.fails.splice(failing, 1);
        throw Object.assign(new Error(code), { code });
      }
      let info: { size: number } | undefined;
      let failure: unknown;
      try {
        info = await (read as (...args: unknown[]) => Promise<{ size: number }>)(path, ...rest);
      } catch (error) {
        failure = error;
      }
      if (!refresh && path.startsWith(native.root)) {
        native.reads.push(path);
        if (info && path === native.watched) native.sizesRead.push(info.size);
        await native.pause("stat", path, stack);
      }
      if (!info) throw failure;
      return info;
    }) as typeof actual.stat;
  const resolving = (async (path: string, ...rest: unknown[]) => {
    const stack = new Error().stack ?? "";
    const real = await (actual.realpath as (...args: unknown[]) => Promise<string>)(path, ...rest);
    if (!isRefresh(path, stack)) await native.pause("realpath", path, stack);
    return real;
  }) as typeof actual.realpath;
  const listing = (async (path: string, ...rest: unknown[]) => {
    const names = await (actual.readdir as (...args: unknown[]) => Promise<string[]>)(
      path,
      ...rest,
    );
    return native.hidden ? names.filter((name) => name !== native.hidden) : names;
  }) as typeof actual.readdir;
  const pausing = (async (path: string, ...rest: unknown[]) => {
    const stack = new Error().stack ?? "";
    const refresh = isRefresh(path, stack);
    if (refresh) await native.refreshGate;
    const target = await (actual.readlink as (...args: unknown[]) => Promise<string>)(
      path,
      ...rest,
    );
    if (path === native.watched && !refresh) {
      native.linksRead.push(target);
      await native.pause("readlink", path, stack);
    }
    return target;
  }) as typeof actual.readlink;
  return {
    ...actual,
    stat: recording(actual.stat),
    lstat: recording(actual.lstat),
    readlink: pausing,
    readdir: listing,
    realpath: resolving,
  };
});

const { watch } = await import("../src/index.ts");
type FSWatcher = ReturnType<typeof watch>;

const rm = (path: string, options: Parameters<typeof removeOnce>[1] = {}) =>
  removeOnce(path, { maxRetries: 10, retryDelay: 50, ...options });

let dir: string;
let watchers: FSWatcher[];

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "zygiella-")));
  watchers = [];
  native.listeners = [];
  native.sizesRead = [];
  native.linksRead = [];
  native.reads = [];
  native.root = dir;
  native.watched = "";
  native.holdPath = "";
  native.holdFrom = "";
  native.holdEarly = false;
  native.fails = [];
  native.hidden = "";
  native.holdNext = false;
  native.rejectHeld = false;
  native.held = false;
  native.open = () => {};
  native.refreshGate = Promise.resolve();
  native.releaseRefresh = () => {};
});

afterEach(async () => {
  native.open();
  native.releaseRefresh();
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

async function watching(
  target: string | string[],
  file: string,
  options: { followSymlinks?: boolean; atomic?: boolean } = {},
) {
  native.watched = file;
  const w = watch(target, { ignoreInitial: true, ...options });
  watchers.push(w);
  const seen: Array<[string, string]> = [];
  w.on("all", (event, path) => seen.push([event, path]));
  await new Promise<void>((r) => w.once("ready", () => r()));
  return { w, seen };
}

async function sizeLastReportedAfterLateEvent(
  w: FSWatcher,
  file: string,
): Promise<number | undefined> {
  const reads = native.sizesRead.length;
  native.deliver();
  await until(() => native.sizesRead.length > reads);
  return w.snapshot().entries.find((entry) => entry.path === file)?.size;
}

describe("a write whose native event arrives after the quiet period", () => {
  test("is reported as add only when a new file was empty at the first read and complete at the second", async () => {
    const file = join(dir, "a.txt");
    const { w, seen } = await watching(dir, file);

    native.holdRefresh();
    await writeFile(file, "");
    native.deliver();
    await until(() => native.sizesRead.includes(0));
    await writeFile(file, "22");
    native.releaseRefresh();
    await until(() => seen.length > 0);

    expect(await sizeLastReportedAfterLateEvent(w, file)).toBe(2);
    expect(seen).toEqual([["add", file]]);
  });

  test("is reported as one change when the file was truncated at the first read and complete at the second", async () => {
    const file = join(dir, "a.txt");
    await writeFile(file, "1");
    const { w, seen } = await watching(file, file);

    native.holdRefresh();
    await truncate(file, 0);
    native.deliver();
    await until(() => native.sizesRead.includes(0));
    await writeFile(file, "22");
    native.releaseRefresh();
    await until(() => seen.length > 0);

    expect(await sizeLastReportedAfterLateEvent(w, file)).toBe(2);
    expect(seen).toEqual([["change", file]]);
  });
});

describe("a read of the file that completes after the change was reported", () => {
  test("does not report the write again when it had seen the truncated file", async () => {
    const file = join(dir, "a.txt");
    await writeFile(file, "1");
    const { w, seen } = await watching(file, file);

    native.holdRefresh();
    await truncate(file, 0);
    native.deliver();
    await until(() => native.sizesRead.includes(0));
    native.hold();
    native.deliver();
    await until(() => native.held);
    await writeFile(file, "22");
    native.releaseRefresh();
    await until(() => seen.length > 0);
    const reads = native.sizesRead.length;
    native.open();
    await until(() => native.sizesRead.length > reads || seen.length > 1);

    expect(seen).toEqual([["change", file]]);
    expect(w.snapshot().entries.find((entry) => entry.path === file)?.size).toBe(2);
  });

  test("does not report the file as removed when the read that failed because it was missing completes after the change was reported", async () => {
    const file = join(dir, "a.txt");
    await writeFile(file, "1");
    const { w, seen } = await watching(dir, file);

    native.holdRefresh();
    await truncate(file, 0);
    native.deliver();
    await until(() => native.sizesRead.includes(0));
    native.hold("stat", true);
    native.deliver();
    await until(() => native.held);
    await writeFile(file, "22");
    native.releaseRefresh();
    await until(() => seen.length > 0);
    const reads = native.sizesRead.length;
    native.open();
    await until(() => native.sizesRead.length > reads || seen.length > 1);

    expect(seen).toEqual([["change", file]]);
    expect(w.snapshot().entries.find((entry) => entry.path === file)?.size).toBe(2);
  });

  test("does not report a file as removed when it was missing at its read and was back before the siblings were read", async () => {
    const a = join(dir, "a.txt");
    const b = join(dir, "b.txt");
    await writeFile(a, "1");
    await writeFile(b, "1");
    const { seen } = await watching(dir, a);
    const readsBefore = native.reads.length;

    native.holdRefresh();
    await truncate(a, 0);
    native.deliver();
    await until(() => native.sizesRead.includes(0) && native.reads.includes(b, readsBefore));
    native.hold("stat", false, b);
    native.failNext(a);
    native.deliver();
    await until(() => native.held);
    await writeFile(a, "22");
    native.releaseRefresh();
    await until(() => seen.length > 0);
    const reads = native.sizesRead.length;
    native.open();
    await until(() => native.sizesRead.length > reads || seen.length > 1);

    expect(seen).toEqual([["change", a]]);
  });

  test("does not put a file back in the place of the directory that replaced it when the read of the file returns late", async () => {
    const x = join(dir, "x");
    await writeFile(x, "1");
    const { seen } = await watching([dir, x], x);

    native.hold("stat", false, x, "statRoot");
    native.deliver();
    await until(() => native.held);
    await rm(x);
    await mkdir(x);
    native.deliver();
    await until(() => seen.length > 1);
    const reads = native.reads.length;
    native.open();
    await until(() => native.reads.length > reads || seen.length > 2);

    expect(seen).toEqual([
      ["unlink", x],
      ["addDir", x],
    ]);
  });

  test("reports each missing file as removed without waiting for the check of another one", async () => {
    const a = join(dir, "a.txt");
    const b = join(dir, "b.txt");
    const c = join(dir, "c.txt");
    for (const file of [a, b, c]) await writeFile(file, "1");
    const { seen } = await watching(dir, a);

    await Promise.all([rm(a), rm(b), rm(c)]);
    native.holdBefore(b);
    native.deliver();
    await until(() => native.held);
    await until(() => seen.length >= 2);

    expect(seen.map(([, path]) => path).sort()).toEqual([a, c]);
    native.open();
    await until(() => seen.length >= 3);
    expect(seen.map(([event]) => event)).toEqual(["unlink", "unlink", "unlink"]);
  });

  test("reports a file that is gone as removed when the second look at it fails with a permission error", async () => {
    const file = join(dir, "a.txt");
    await writeFile(file, "1");
    const { w, seen } = await watching(dir, file);
    w.on("error", () => {});

    await rm(file);
    native.failNext(file, "EPERM");
    native.deliver();
    await until(() => seen.length > 0);

    expect(seen).toEqual([["unlink", file]]);
  });

  test("keeps a file that became a watched root while the result of its failed read was on the way", async () => {
    const a = join(dir, "a.txt");
    const b = join(dir, "b.txt");
    await writeFile(a, "1");
    await writeFile(b, "1");
    const { w, seen } = await watching(dir, b, { atomic: false });

    await rm(b);
    native.hold("stat", false, b);
    native.deliver();
    await until(() => native.held);
    await writeFile(b, "1");
    await w.add(b).ready;
    native.open();
    await w.rescan();

    expect(seen).toEqual([]);
  });

  test("keeps a name the listing had when its second look is refused after the first one found it missing", async () => {
    const file = join(dir, "a.txt");
    await writeFile(file, "1");
    const { w, seen } = await watching(dir, file, { atomic: false });
    w.on("error", () => {});

    native.failNext(file, "ENOENT");
    native.failNext(file, "EPERM");
    native.deliver();
    await w.rescan();

    expect(seen).toEqual([]);
  });

  test("removes a directory that the listing no longer has without looking at it again", async () => {
    const sub = join(dir, "sub");
    await mkdir(sub);
    const { seen } = await watching(dir, sub, { atomic: false });

    native.hide("sub");
    native.deliver();
    await until(() => seen.length > 0);

    expect(seen).toEqual([["unlinkDir", sub]]);
  });

  test.skipIf(process.platform === "win32")(
    "does not turn a link into a directory when it points to a file again before the read of its target is used",
    async () => {
      const link = join(dir, "link");
      const file1 = join(dir, "file1");
      const file2 = join(dir, "file2");
      const sub = join(dir, "sub");
      const replaceLink = async (target: string) => {
        await symlink(target, `${link}.tmp`);
        await rename(`${link}.tmp`, link);
      };
      await writeFile(file1, "1");
      await writeFile(file2, "1");
      await mkdir(sub);
      await symlink(file1, link);
      const { w, seen } = await watching(dir, link, { atomic: false });
      const readsBefore = native.reads.length;

      native.holdRefresh();
      await writeFile(file1, "22");
      native.deliver();
      await until(
        () => native.reads.slice(readsBefore).filter((path) => path === link).length >= 2,
      );
      native.hold("realpath", false, link);
      await replaceLink(sub);
      native.deliver();
      await until(() => native.held);
      await replaceLink(file2);
      native.releaseRefresh();
      await until(() => seen.some(([, path]) => path === link));
      native.open();
      await w.rescan();

      expect(seen.filter(([, path]) => path === link)).toEqual([["change", link]]);
    },
  );

  test.skipIf(process.platform === "win32")(
    "does not turn a root link into a directory when it points to a file again before the real path of the root is used",
    async () => {
      const link = join(dir, "link");
      const file1 = join(dir, "file1");
      const file2 = join(dir, "file2");
      const sub = join(dir, "sub");
      const replaceLink = async (target: string) => {
        await symlink(target, `${link}.tmp`);
        await rename(`${link}.tmp`, link);
      };
      await writeFile(file1, "1");
      await writeFile(file2, "1");
      await mkdir(sub);
      await symlink(file1, link);
      const { w, seen } = await watching(link, link, { atomic: false });
      const readsBefore = native.reads.length;

      native.holdRefresh();
      await writeFile(file1, "22");
      native.deliver();
      await until(
        () => native.reads.slice(readsBefore).filter((path) => path === link).length >= 1,
      );
      native.hold("realpath", false, link);
      await replaceLink(sub);
      native.deliver();
      await until(() => native.held);
      await replaceLink(file2);
      native.releaseRefresh();
      await until(() => seen.some(([, path]) => path === link));
      native.open();
      await w.rescan();

      expect(seen.filter(([, path]) => path === link)).toEqual([["change", link]]);
    },
  );

  test("detects a root that is created again when it was deleted while its real path was being resolved at startup", async () => {
    const root = join(dir, "root");
    await mkdir(root);
    native.watched = root;
    native.hold("realpath", false, root);
    const w = watch(root, { ignoreInitial: true, atomic: false });
    watchers.push(w);
    w.on("error", () => {});
    const seen: Array<[string, string]> = [];
    w.on("all", (event, path) => seen.push([event, path]));
    await until(() => native.held);
    await rm(root, { recursive: true, force: true });
    native.deliver();
    native.open();
    await new Promise<void>((r) => w.once("ready", () => r()));
    await mkdir(root);
    await writeFile(join(root, "file"), "1");
    native.deliver();
    await until(() => seen.some(([event]) => event === "add"));

    expect(seen).toContainEqual(["add", join(root, "file")]);
  });

  test.skipIf(process.platform === "win32")(
    "does not report the link target again when the read of it completes after the change was reported",
    async () => {
      const link = join(dir, "link");
      const replaceLink = async (target: string) => {
        await symlink(target, `${link}.tmp`);
        await rename(`${link}.tmp`, link);
      };
      await symlink(join(dir, "first"), link);
      const { w, seen } = await watching(link, link, { followSymlinks: false });

      native.holdRefresh();
      const linksBefore = native.linksRead.length;
      await replaceLink(join(dir, "second"));
      native.deliver();
      await until(() => native.linksRead.length > linksBefore);
      native.hold("readlink");
      native.deliver();
      await until(() => native.held);
      await replaceLink(join(dir, "third"));
      native.releaseRefresh();
      await until(() => seen.length > 0);
      const reads = native.linksRead.length;
      native.open();
      await until(() => native.linksRead.length > reads || seen.length > 1);

      expect(seen).toEqual([["change", link]]);
      expect(w.snapshot().entries.find((entry) => entry.path === link)?.link).toBe(
        join(dir, "third"),
      );
    },
  );
});
