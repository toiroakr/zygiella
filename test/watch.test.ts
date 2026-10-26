import {
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

describe("atomic", () => {
  test("a file deleted and created again within the window is reported as one change", async () => {
    await writeFile(join(dir, "a.txt"), "1");
    const { seen } = await start(dir, { atomic: 500 });
    await rm(join(dir, "a.txt"));
    await settle(150);
    await writeFile(join(dir, "a.txt"), "22");
    await until(() => seen.length > 0);
    await settle(700);
    expect(seen).toEqual([["change", join(dir, "a.txt")]]);
  });

  test("the window is 100 ms by default", async () => {
    await writeFile(join(dir, "a.txt"), "1");
    const { seen } = await start(dir);
    await rm(join(dir, "a.txt"));
    await settle(30);
    await writeFile(join(dir, "a.txt"), "22");
    await until(() => seen.length > 0);
    await settle();
    expect(seen).toEqual([["change", join(dir, "a.txt")]]);
  });

  test("a file that is not created again is reported as unlink once the window has passed", async () => {
    await writeFile(join(dir, "a.txt"), "1");
    const { seen } = await start(dir, { atomic: 200 });
    const deleted = Date.now();
    await rm(join(dir, "a.txt"));
    await until(() => seen.length > 0);
    expect(Date.now() - deleted).toBeGreaterThanOrEqual(190);
    expect(seen).toEqual([["unlink", join(dir, "a.txt")]]);
  });

  test("with the default window an unlink is reported once 100 ms have passed", async () => {
    await writeFile(join(dir, "a.txt"), "1");
    const { seen } = await start(dir);
    const deleted = Date.now();
    await rm(join(dir, "a.txt"));
    await until(() => seen.length > 0);
    expect(Date.now() - deleted).toBeGreaterThanOrEqual(90);
    expect(seen).toEqual([["unlink", join(dir, "a.txt")]]);
  });

  test("a file created again after the unlink was reported is reported as add", async () => {
    await writeFile(join(dir, "a.txt"), "1");
    const { seen } = await start(dir, { atomic: 50 });
    await rm(join(dir, "a.txt"));
    await until(() => seen.length > 0);
    await writeFile(join(dir, "a.txt"), "22");
    await until(() => seen.length > 1);
    expect(seen).toEqual([
      ["unlink", join(dir, "a.txt")],
      ["add", join(dir, "a.txt")],
    ]);
  });

  test("a file that add() finds again while its unlink is held back is reported as change, not add and unlink", async () => {
    await writeFile(join(dir, "a.txt"), "1");
    const { w, seen } = await start(dir, { atomic: 300 });
    await rm(join(dir, "a.txt"));
    await settle(100);
    await writeFile(join(dir, "a.txt"), "22");
    await w.add(dir).ready;
    await settle(600);
    expect(seen).toEqual([["change", join(dir, "a.txt")]]);
  });

  test("a file that add() finds again while its unlink is held back still waits for awaitWriteFinish", async () => {
    await writeFile(join(dir, "a.txt"), "1");
    const { w, seen } = await start(dir, {
      atomic: 300,
      awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 25 },
    });
    await rm(join(dir, "a.txt"));
    await settle(100);
    await writeFile(join(dir, "a.txt"), "22");
    await w.add(dir).ready;
    expect(seen).toEqual([]);
    await until(() => seen.length > 0);
    await settle(600);
    expect(seen).toEqual([["change", join(dir, "a.txt")]]);
  });

  test("atomic false reports unlink and add as they happen", async () => {
    await writeFile(join(dir, "a.txt"), "1");
    const { seen } = await start(dir, { atomic: false });
    await rm(join(dir, "a.txt"));
    await until(() => seen.length > 0);
    await writeFile(join(dir, "a.txt"), "22");
    await until(() => seen.length > 1);
    expect(seen).toEqual([
      ["unlink", join(dir, "a.txt")],
      ["add", join(dir, "a.txt")],
    ]);
  });

  test("a directory created where a held-back file was is reported after the file's unlink", async () => {
    await writeFile(join(dir, "x"), "1");
    const { seen } = await start(dir, { atomic: 500 });
    await rm(join(dir, "x"));
    await settle(100);
    await mkdir(join(dir, "x"));
    await until(() => seen.length > 1);
    await settle();
    expect(seen).toEqual([
      ["unlink", join(dir, "x")],
      ["addDir", join(dir, "x")],
    ]);
  });

  test("a removed directory still reports its files before itself", async () => {
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "sub", "a.txt"), "1");
    await writeFile(join(dir, "sub", "b.txt"), "1");
    const { seen } = await start(dir, { atomic: 500 });
    await rm(join(dir, "sub", "a.txt"));
    await settle(50);
    await rm(join(dir, "sub"), { recursive: true });
    await until(() => seen.some(([e]) => e === "unlinkDir"));
    expect(seen.map(([e]) => e).slice(-1)).toEqual(["unlinkDir"]);
    expect(seen).toHaveLength(3);
  });

  test("a watched file that is deleted and created again is reported as change", async () => {
    await writeFile(join(dir, "a.txt"), "1");
    const { seen } = await start(join(dir, "a.txt"), { atomic: 500 });
    await rm(join(dir, "a.txt"));
    await settle(100);
    await writeFile(join(dir, "a.txt"), "22");
    await until(() => seen.length > 0);
    await settle(700);
    expect(seen).toEqual([["change", join(dir, "a.txt")]]);
  });

  test("with awaitWriteFinish the file is recreated within the window, and one change is reported once it is stable", async () => {
    await writeFile(join(dir, "a.txt"), "1");
    const { seen } = await start(dir, {
      atomic: 500,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 25 },
    });
    await rm(join(dir, "a.txt"));
    await settle(100);
    await writeFile(join(dir, "a.txt"), "22");
    expect(seen).toEqual([]);
    await until(() => seen.length > 0);
    await settle(700);
    expect(seen).toEqual([["change", join(dir, "a.txt")]]);
  });

  test("with awaitWriteFinish a file deleted again before it is stable is reported as unlink", async () => {
    await writeFile(join(dir, "a.txt"), "1");
    const { seen } = await start(dir, {
      atomic: 100,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 25 },
    });
    await rm(join(dir, "a.txt"));
    await settle(30);
    await writeFile(join(dir, "a.txt"), "22");
    await settle(60);
    await rm(join(dir, "a.txt"));
    await until(() => seen.length > 0);
    await settle(500);
    expect(seen).toEqual([["unlink", join(dir, "a.txt")]]);
  });

  test("unwatch drops an unlink that is still being held back", async () => {
    await writeFile(join(dir, "a.txt"), "1");
    const { w, seen } = await start(dir, { atomic: 300 });
    await rm(join(dir, "a.txt"));
    await settle(100);
    w.unwatch(dir);
    await settle(500);
    expect(seen).toEqual([]);
  });

  test("editor temporary files are ignored", async () => {
    const { seen } = await start(dir);
    await writeFile(join(dir, ".a.txt.swp"), "1");
    await writeFile(join(dir, ".a.txt.swx"), "1");
    await writeFile(join(dir, "a.txt~"), "1");
    await writeFile(join(dir, ".subl1234.tmp"), "1");
    await writeFile(join(dir, "a.txt"), "1");
    await until(() => seen.length > 0);
    await settle();
    expect(seen).toEqual([["add", join(dir, "a.txt")]]);
  });

  test("editor temporary files are reported with atomic false", async () => {
    const { seen } = await start(dir, { atomic: false });
    await writeFile(join(dir, "a.txt~"), "1");
    await until(() => seen.length > 0);
    expect(seen).toEqual([["add", join(dir, "a.txt~")]]);
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

  test("a link to a directory is descended into, and what is below it is reported under the link's path", async () => {
    const root = join(dir, "root");
    const target = join(dir, "target");
    await mkdir(root);
    await mkdir(target);
    await writeFile(join(target, "a.txt"), "1");
    await symlink(target, join(root, "link"), "junction");
    const { seen } = await start(root, { ignoreInitial: false });
    expect(seen).toEqual(
      expect.arrayContaining([
        ["addDir", join(root, "link")],
        ["add", join(root, "link", "a.txt")],
      ]),
    );
    await writeFile(join(target, "b.txt"), "1");
    await until(() => seen.some(([, path]) => path === join(root, "link", "b.txt")));
  });

  test("a directory reachable by a link and by its own path is descended into by both", async () => {
    await mkdir(join(dir, "real"));
    await writeFile(join(dir, "real", "x.txt"), "1");
    await symlink(join(dir, "real"), join(dir, "alias"), "junction");
    const { seen } = await start(dir, { ignoreInitial: false });
    expect(seen).toEqual(
      expect.arrayContaining([
        ["add", join(dir, "real", "x.txt")],
        ["add", join(dir, "alias", "x.txt")],
      ]),
    );
  });

  test("a link to an ancestor several levels up is reported but not descended into", async () => {
    await mkdir(join(dir, "a", "b"), { recursive: true });
    await symlink(join(dir, "a"), join(dir, "a", "b", "up"), "junction");
    const { seen } = await start(dir, { ignoreInitial: false });
    expect(seen).toContainEqual(["addDir", join(dir, "a", "b", "up")]);
    expect(seen.map(([, path]) => path)).not.toContainEqual(
      expect.stringContaining(join("up", "b")),
    );
  });

  test("pointing a followed link at another directory reports what was below it as removed and what is below the new target as added", async () => {
    const root = join(dir, "root");
    await mkdir(root);
    await mkdir(join(dir, "t1"));
    await mkdir(join(dir, "t2"));
    await writeFile(join(dir, "t1", "a.txt"), "1");
    await writeFile(join(dir, "t2", "b.txt"), "1");
    await symlink(join(dir, "t1"), join(root, "link"), "junction");
    const { seen } = await start(root);
    await rm(join(root, "link"));
    await symlink(join(dir, "t2"), join(root, "link"), "junction");
    await until(() => seen.some(([e, p]) => e === "add" && p === join(root, "link", "b.txt")));
    expect(seen).toContainEqual(["unlink", join(root, "link", "a.txt")]);
    await writeFile(join(dir, "t2", "c.txt"), "1");
    await until(() => seen.some(([e, p]) => e === "add" && p === join(root, "link", "c.txt")));
  });

  test("a link given as the watched path is watched as itself with followSymlinks false", async () => {
    await mkdir(join(dir, "t1"));
    await mkdir(join(dir, "t2"));
    await writeFile(join(dir, "t1", "a.txt"), "1");
    await symlink(join(dir, "t1"), join(dir, "link"), "junction");
    const { seen } = await start(join(dir, "link"), {
      ignoreInitial: false,
      followSymlinks: false,
    });
    expect(seen).toEqual([["add", join(dir, "link")]]);
    await rm(join(dir, "link"));
    await symlink(join(dir, "t2"), join(dir, "link"), "junction");
    await until(() => seen.length > 1);
    await settle();
    expect(seen).toEqual([
      ["add", join(dir, "link")],
      ["change", join(dir, "link")],
    ]);
  });

  test("a followed link that is also given as a watched path is not reported as removed and added again", async () => {
    const root = join(dir, "root");
    await mkdir(root);
    await mkdir(join(dir, "target"));
    await symlink(join(dir, "target"), join(root, "link"), "junction");
    const { seen } = await start([root, join(root, "link")]);
    await settle();
    expect(seen).toEqual([]);
  });

  test.skipIf(process.platform === "win32")(
    "with followSymlinks false and awaitWriteFinish a link whose target is missing is still reported",
    async () => {
      const { seen } = await start(dir, {
        followSymlinks: false,
        awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
      });
      await symlink(join(dir, "missing"), join(dir, "link"));
      await until(() => seen.length > 0);
      expect(seen).toEqual([["add", join(dir, "link")]]);
    },
  );

  test("with followSymlinks false a link is watched as itself: reported as add and not descended into", async () => {
    const root = join(dir, "root");
    const target = join(dir, "target");
    await mkdir(root);
    await mkdir(target);
    await writeFile(join(target, "a.txt"), "1");
    await symlink(target, join(root, "link"), "junction");
    const { seen } = await start(root, { ignoreInitial: false, followSymlinks: false });
    expect(seen).toContainEqual(["add", join(root, "link")]);
    expect(seen.map(([, path]) => path)).not.toContainEqual(
      expect.stringContaining(join("link", "a.txt")),
    );
  });

  test("with followSymlinks false pointing a link somewhere else is reported as change", async () => {
    const root = join(dir, "root");
    await mkdir(root);
    await mkdir(join(dir, "t1"));
    await mkdir(join(dir, "t2"));
    await symlink(join(dir, "t1"), join(root, "link"), "junction");
    const { seen } = await start(root, { followSymlinks: false });
    await rm(join(root, "link"));
    await symlink(join(dir, "t2"), join(root, "link"), "junction");
    await until(() => seen.length > 0);
    await settle();
    expect(seen).toEqual([["change", join(root, "link")]]);
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
