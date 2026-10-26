import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm as removeOnce,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { watch, type FSWatcher } from "../src/index.ts";

type Seen = Array<[string, string]>;

// Windows refuses to delete a directory for a moment while a watch handle on it is being closed
const rm = (path: string, options: Parameters<typeof removeOnce>[1] = {}) =>
  removeOnce(path, { maxRetries: 10, retryDelay: 50, ...options });

let dir: string;
let watchers: FSWatcher[];

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "zygiella-")));
  watchers = [];
});

afterEach(async () => {
  await Promise.all(watchers.map((w) => w.close()));
  await rm(dir, { recursive: true, force: true });
});

async function start(paths: string | string[], opts: Parameters<typeof watch>[1] = {}) {
  const w = watch(paths, { ignoreInitial: true, ...opts });
  watchers.push(w);
  const seen: Seen = [];
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

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

describe("file events", () => {
  test("a file created right after ready is reported as add", async () => {
    const { seen } = await start(dir);
    await writeFile(join(dir, "a.txt"), "1");
    await until(() => seen.length > 0);
    expect(seen).toEqual([["add", join(dir, "a.txt")]]);
  });

  test("modifying a file is reported as change", async () => {
    await writeFile(join(dir, "a.txt"), "1");
    const { seen } = await start(dir);
    await writeFile(join(dir, "a.txt"), "22");
    await until(() => seen.length > 0);
    expect(seen).toEqual([["change", join(dir, "a.txt")]]);
  });

  test("deleting a file is reported as unlink", async () => {
    await writeFile(join(dir, "a.txt"), "1");
    const { seen } = await start(dir);
    await rm(join(dir, "a.txt"));
    await until(() => seen.length > 0);
    expect(seen).toEqual([["unlink", join(dir, "a.txt")]]);
  });

  test("renaming a file is reported as unlink of the old name and add of the new one", async () => {
    await writeFile(join(dir, "a.txt"), "1");
    const { seen } = await start(dir);
    await rename(join(dir, "a.txt"), join(dir, "b.txt"));
    await until(() => seen.length >= 2);
    expect(seen).toEqual(
      expect.arrayContaining([
        ["unlink", join(dir, "a.txt")],
        ["add", join(dir, "b.txt")],
      ]),
    );
  });

  test("replacing a file by rename (atomic save) is reported as change", async () => {
    await writeFile(join(dir, "a.txt"), "1");
    const { seen } = await start(dir);
    await writeFile(join(dir, "a.txt.tmp"), "new content");
    await rename(join(dir, "a.txt.tmp"), join(dir, "a.txt"));
    await until(() => seen.some(([e, p]) => e === "change" && p === join(dir, "a.txt")));
  });
});

describe("directory events", () => {
  test("a created directory is reported as addDir, and a file inside it as add", async () => {
    const { seen } = await start(dir);
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "sub", "a.txt"), "1");
    await until(() => seen.some(([e]) => e === "add"));
    expect(seen).toEqual([
      ["addDir", join(dir, "sub")],
      ["add", join(dir, "sub", "a.txt")],
    ]);
  });

  test("a file changed in a nested directory is reported", async () => {
    await mkdir(join(dir, "a", "b"), { recursive: true });
    await writeFile(join(dir, "a", "b", "c.txt"), "1");
    const { seen } = await start(dir);
    await writeFile(join(dir, "a", "b", "c.txt"), "22");
    await until(() => seen.length > 0);
    expect(seen).toEqual([["change", join(dir, "a", "b", "c.txt")]]);
  });

  test("a removed directory reports its contents and itself as unlink / unlinkDir", async () => {
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "sub", "a.txt"), "1");
    const { seen } = await start(dir);
    await rm(join(dir, "sub"), { recursive: true });
    await until(() => seen.some(([e]) => e === "unlinkDir"));
    expect(seen).toEqual([
      ["unlink", join(dir, "sub", "a.txt")],
      ["unlinkDir", join(dir, "sub")],
    ]);
  });
});

describe("initial scan", () => {
  test("existing files are reported as add before ready unless ignoreInitial is set", async () => {
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "a.txt"), "1");
    const w = watch(dir);
    watchers.push(w);
    const seen: Seen = [];
    w.on("all", (event, path) => seen.push([event, path]));
    await new Promise<void>((r) => w.once("ready", () => r()));
    expect(seen).toEqual(
      expect.arrayContaining([
        ["addDir", dir],
        ["addDir", join(dir, "sub")],
        ["add", join(dir, "a.txt")],
      ]),
    );
  });
});

describe("symbolic links", () => {
  test("a link that points back at its own directory is reported but not descended into", async () => {
    await writeFile(join(dir, "a.txt"), "1");
    // an absolute target and a junction, which Windows can create without elevated rights
    await symlink(dir, join(dir, "loop"), "junction");
    const w = watch(dir);
    watchers.push(w);
    const seen: Seen = [];
    w.on("all", (event, path) => seen.push([event, path]));
    await Promise.race([
      new Promise<void>((r) => w.once("ready", () => r())),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("ready never came: the link was followed in a loop")),
          3000,
        ),
      ),
    ]);
    expect(seen.map(([, path]) => path)).not.toContainEqual(
      expect.stringContaining(join("loop", "a.txt")),
    );
    expect(seen).toContainEqual(["addDir", join(dir, "loop")]);
  });
});

describe("depth", () => {
  test("depth 0 reports a new child directory but does not descend into it", async () => {
    const { seen } = await start(dir, { depth: 0 });
    await mkdir(join(dir, "sub"));
    await until(() => seen.length > 0);
    await writeFile(join(dir, "sub", "a.txt"), "1");
    await settle();
    expect(seen).toEqual([["addDir", join(dir, "sub")]]);
  });

  test("depth 0 still reports files directly in the root", async () => {
    const { seen } = await start(dir, { depth: 0 });
    await writeFile(join(dir, "a.txt"), "1");
    await until(() => seen.length > 0);
    expect(seen).toEqual([["add", join(dir, "a.txt")]]);
  });
});

describe("ignored", () => {
  test("a RegExp skips matching paths and everything below them", async () => {
    await mkdir(join(dir, "node_modules"));
    const { seen } = await start(dir, { ignored: /node_modules/ });
    await writeFile(join(dir, "node_modules", "x.js"), "1");
    await writeFile(join(dir, "a.txt"), "1");
    await until(() => seen.length > 0);
    await settle();
    expect(seen).toEqual([["add", join(dir, "a.txt")]]);
  });

  test("a function skips the paths it returns true for", async () => {
    const { seen } = await start(dir, { ignored: (p) => p.endsWith(".log") });
    await writeFile(join(dir, "a.log"), "1");
    await writeFile(join(dir, "a.txt"), "1");
    await until(() => seen.length > 0);
    await settle();
    expect(seen).toEqual([["add", join(dir, "a.txt")]]);
  });
});

describe("awaitWriteFinish", () => {
  test("a write in several steps is reported once, after the file stops growing", async () => {
    const { seen } = await start(dir, {
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 25 },
    });
    const file = join(dir, "a.txt");
    await writeFile(file, "1");
    for (let i = 2; i <= 5; i++) {
      await settle(40);
      await writeFile(file, "1".repeat(i));
    }
    expect(seen).toEqual([]);
    await until(() => seen.length > 0);
    await settle(400);
    expect(seen).toEqual([["add", file]]);
  });

  test("a file deleted before it settles is never reported", async () => {
    const { seen } = await start(dir, {
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 25 },
    });
    await writeFile(join(dir, "a.txt"), "1");
    await settle(60);
    await rm(join(dir, "a.txt"));
    await settle(500);
    expect(seen).toEqual([]);
  });
});

describe("watching a file", () => {
  test("only the given file is reported, not its siblings", async () => {
    await writeFile(join(dir, "a.txt"), "1");
    const { seen } = await start(join(dir, "a.txt"));
    await writeFile(join(dir, "b.txt"), "1");
    await writeFile(join(dir, "a.txt"), "22");
    await until(() => seen.length > 0);
    await settle();
    expect(seen).toEqual([["change", join(dir, "a.txt")]]);
  });
});

describe("paths that do not exist yet", () => {
  test("a file whose folder is created later is reported once it appears", async () => {
    const file = join(dir, "later", "deep", "a.txt");
    const { seen } = await start(file);
    await mkdir(join(dir, "later", "deep"), { recursive: true });
    await writeFile(file, "1");
    await until(() => seen.some(([e, p]) => e === "add" && p === file));
  });

  test("a directory created later is watched from then on", async () => {
    const target = join(dir, "later");
    const { seen } = await start(target);
    await mkdir(target);
    await until(() => seen.some(([e]) => e === "addDir"));
    await writeFile(join(target, "a.txt"), "1");
    await until(() => seen.some(([e]) => e === "add"));
  });
});

describe("add / unwatch / close", () => {
  test("add starts reporting a new path and unwatch stops it", async () => {
    const other = await realpath(await mkdtemp(join(tmpdir(), "zygiella-other-")));
    try {
      const { w, seen } = await start(dir);
      w.add(other);
      await settle(100);
      await writeFile(join(other, "x.txt"), "1");
      await until(() => seen.length > 0);
      w.unwatch(other);
      await writeFile(join(other, "y.txt"), "1");
      await settle();
      expect(seen).toEqual([["add", join(other, "x.txt")]]);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  test("ready after add settles once the added path is watched, so a change made right after it is reported", async () => {
    const { w } = await start(dir);
    const initial = w.ready;
    for (let i = 0; i < 15; i++) {
      const other = await realpath(await mkdtemp(join(tmpdir(), "zygiella-added-")));
      try {
        const reported: string[] = [];
        w.on("add", (path) => reported.push(path));
        await w.add(other).ready;
        expect(w.ready).not.toBe(initial);
        await writeFile(join(other, "x.txt"), "1");
        await until(() => reported.includes(join(other, "x.txt")));
        w.unwatch(other);
        w.removeAllListeners("add");
      } finally {
        await rm(other, { recursive: true, force: true });
      }
    }
  });

  test("close stops reporting, and a pending awaitWriteFinish is dropped", async () => {
    const { w, seen } = await start(dir, {
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 25 },
    });
    await writeFile(join(dir, "a.txt"), "1");
    await settle(60);
    await w.close();
    await writeFile(join(dir, "b.txt"), "1");
    await settle(500);
    expect(seen).toEqual([]);
  });

  test("unwatch then add of the same directory reports files created afterwards", async () => {
    const { w, seen } = await start(dir);
    w.unwatch(dir);
    w.add(dir);
    await settle(100);
    await writeFile(join(dir, "a.txt"), "1");
    await until(() => seen.length > 0);
    expect(seen).toEqual([["add", join(dir, "a.txt")]]);
  });
});

describe("missing paths", () => {
  test("a path that does not exist is returned in missing by ready, and is not an error", async () => {
    const missing = join(dir, "missing");
    const w = watch(missing, { ignoreInitial: true });
    watchers.push(w);
    await expect(w.ready).resolves.toEqual({ missing: [missing] });
  });

  test("the ready event receives the same result", async () => {
    const missing = join(dir, "missing");
    const w = watch(missing, { ignoreInitial: true });
    watchers.push(w);
    const result = await new Promise((r) => w.once("ready", r));
    expect(result).toEqual({ missing: [missing] });
  });

  test("only the paths that do not exist are returned, in the order given", async () => {
    const first = join(dir, "first");
    const second = join(dir, "second");
    const present = join(dir, "present");
    await mkdir(present);
    const w = watch([first, present, second], { ignoreInitial: true });
    watchers.push(w);
    await expect(w.ready).resolves.toEqual({ missing: [first, second] });
  });

  test("a path below a file is returned in missing", async () => {
    const file = join(dir, "file");
    await writeFile(file, "1");
    const below = join(file, "child");
    const w = watch(below, { ignoreInitial: true });
    watchers.push(w);
    await expect(w.ready).resolves.toEqual({ missing: [below] });
  });

  test("existing paths give an empty missing", async () => {
    const w = watch(dir, { ignoreInitial: true });
    watchers.push(w);
    await expect(w.ready).resolves.toEqual({ missing: [] });
  });

  test("a missing path that is created afterwards is watched and reports add", async () => {
    const missing = join(dir, "later");
    const { w, seen } = await start(missing);
    await mkdir(missing);
    await w.ready;
    await writeFile(join(missing, "a.txt"), "1");
    await until(() => seen.some(([event]) => event === "add"));
    expect(seen.at(-1)).toEqual(["add", join(missing, "a.txt")]);
  });

  test("ready after add returns only the paths given to that add", async () => {
    const { w } = await start(join(dir, "initially-missing"));
    const present = join(dir, "present");
    const absent = join(dir, "absent");
    await mkdir(present);
    await expect(w.add([present, absent]).ready).resolves.toEqual({ missing: [absent] });
    await expect(w.add(present).ready).resolves.toEqual({ missing: [] });
  });

  test("a path added while missing is watched once it appears", async () => {
    const { w, seen } = await start(dir);
    const missing = join(dir, "added-later");
    await w.add(missing).ready;
    await mkdir(missing);
    await until(() => seen.some(([event, path]) => event === "addDir" && path === missing));
    await w.ready;
    await writeFile(join(missing, "a.txt"), "1");
    await until(() => seen.some(([event]) => event === "add"));
  });
});

describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "permission errors",
  () => {
    async function startCollecting(path: string, opts: Parameters<typeof watch>[1] = {}) {
      const w = watch(path, { ignoreInitial: true, ...opts });
      watchers.push(w);
      const errors: NodeJS.ErrnoException[] = [];
      w.on("error", (error) => errors.push(error));
      await w.ready;
      return { w, errors };
    }

    async function lockedDir(mode: number) {
      const locked = join(dir, "locked");
      await mkdir(locked);
      await chmod(locked, mode);
      return locked;
    }

    afterEach(async () => {
      await chmod(join(dir, "locked"), 0o755).catch(() => undefined);
      await chmod(join(dir, "root", "locked"), 0o755).catch(() => undefined);
    });

    test.each([0o000, 0o100])(
      "a watched directory with mode %o is reported once as an error",
      async (mode) => {
        const locked = await lockedDir(mode);
        const { errors } = await startCollecting(locked);
        await settle();
        expect(errors.map((e) => e.code)).toEqual(["EACCES"]);
      },
    );

    test("an unreadable subdirectory is reported as an error", async () => {
      const root = join(dir, "root");
      await mkdir(join(root, "locked"), { recursive: true });
      await chmod(join(root, "locked"), 0o000);
      const { errors } = await startCollecting(root);
      await settle();
      expect(errors.map((e) => e.code)).toEqual(["EACCES"]);
    });

    test("an unreadable subdirectory that appears later is reported as an error", async () => {
      const root = join(dir, "root");
      await mkdir(root);
      const { errors } = await startCollecting(root);
      await mkdir(join(root, "locked"));
      await chmod(join(root, "locked"), 0o000);
      await writeFile(join(root, "a.txt"), "1");
      await settle();
      expect(errors.map((e) => e.code)).toEqual(["EACCES"]);
    });

    test("the same unreadable directory is not reported again when its parent changes", async () => {
      const root = join(dir, "root");
      await mkdir(join(root, "locked"), { recursive: true });
      await chmod(join(root, "locked"), 0o000);
      const { errors } = await startCollecting(root);
      await writeFile(join(root, "a.txt"), "1");
      await settle();
      await writeFile(join(root, "b.txt"), "1");
      await settle();
      expect(errors).toHaveLength(1);
    });

    test("ignorePermissionErrors skips unreadable directories silently", async () => {
      const locked = await lockedDir(0o000);
      const { errors } = await startCollecting(locked, { ignorePermissionErrors: true });
      await settle();
      expect(errors).toEqual([]);
    });

    test("ready is emitted even when the directory is unreadable", async () => {
      const locked = await lockedDir(0o000);
      const { w } = await startCollecting(locked);
      await expect(w.ready).resolves.toEqual({ missing: [] });
    });

    test("an unreadable path is not returned in missing", async () => {
      const locked = await lockedDir(0o000);
      const { w } = await startCollecting(join(locked, "child"));
      await expect(w.ready).resolves.toEqual({ missing: [] });
    });

    test("a path that does not exist is not an error", async () => {
      const { errors } = await startCollecting(join(dir, "missing"));
      await settle();
      expect(errors).toEqual([]);
    });
  },
);
