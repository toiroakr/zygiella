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
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { watch, type FSWatcher, type Snapshot } from "../src/index.ts";

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

describe("rescan order", () => {
  test("a link that is pointed at its own ancestor is not descended into by the read of the directory below it", async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), "zygiella-outside-")));
    try {
      await writeFile(join(outside, "x.txt"), "1");
      await mkdir(join(dir, "sub"));
      const link = join(dir, "sub", "link");
      await symlink(outside, link, "junction");
      const { w, seen } = await start(dir);
      await rm(link, { recursive: true });
      await symlink(join(dir, "sub"), link, "junction");
      await w.rescan();
      await settle();
      expect(
        seen.map(([, path]) => path).filter((path) => path.includes(join("link", "link"))),
      ).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("ignored receives stats", () => {
  test("a RegExp is matched against a path with / as the separator", async () => {
    await mkdir(join(dir, ".git"));
    const { seen } = await start(dir, { ignored: /(^|\/)\../ });
    await writeFile(join(dir, ".git", "config"), "1");
    await writeFile(join(dir, "a.txt"), "1");
    await until(() => seen.length > 0);
    await settle();
    expect(seen).toEqual([["add", join(dir, "a.txt")]]);
  });

  test("a RegExp with the g flag skips every matching path, not every other one", async () => {
    await writeFile(join(dir, "a.log"), "1");
    await writeFile(join(dir, "b.log"), "1");
    await writeFile(join(dir, "c.log"), "1");
    const { seen } = await start(dir, { ignoreInitial: false, ignored: /\.log$/g });
    expect(seen.map(([, path]) => path)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/\.log$/)]),
    );
  });

  test("a function given stats can skip files of one kind while directories are still descended into", async () => {
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "sub", "a.js"), "1");
    await writeFile(join(dir, "sub", "b.txt"), "1");
    await writeFile(join(dir, "c.txt"), "1");
    const { seen } = await start(dir, {
      ignoreInitial: false,
      ignored: (path, stats) => stats?.isFile() === true && !path.endsWith(".js"),
    });
    expect(seen).toEqual(
      expect.arrayContaining([
        ["addDir", join(dir, "sub")],
        ["add", join(dir, "sub", "a.js")],
      ]),
    );
    expect(seen.map(([, path]) => path)).not.toContain(join(dir, "c.txt"));
    expect(seen.map(([, path]) => path)).not.toContain(join(dir, "sub", "b.txt"));
  });

  test("a function that takes one argument is called with the path alone, a function that takes two is called once with stats", async () => {
    await writeFile(join(dir, "a.txt"), "1");
    await settle(500);
    const one: Array<[string, number]> = [];
    const two: Array<[string, boolean]> = [];
    await start(dir, {
      ignoreInitial: false,
      ignored: (...args: [string]) => (one.push([args[0], args.length]), false),
    });
    await start(dir, {
      ignoreInitial: false,
      ignored: (path, stats) => (two.push([path, stats !== undefined]), false),
    });
    const file = join(dir, "a.txt");
    expect(one.filter(([p]) => p === file)).toEqual([[file, 1]]);
    expect(two.filter(([p]) => p === file)).toEqual([[file, true]]);
  });

  test("an array calls a function that takes two arguments only when no other entry has matched", async () => {
    await writeFile(join(dir, "a.log"), "1");
    await writeFile(join(dir, "a.txt"), "1");
    await settle(500);
    const two: Array<[string, boolean]> = [];
    const { seen } = await start(dir, {
      ignoreInitial: false,
      ignored: [/\.log$/, (path, stats) => (two.push([path, stats !== undefined]), false)],
    });
    expect(seen).toContainEqual(["add", join(dir, "a.txt")]);
    expect(seen.map(([, path]) => path)).not.toContain(join(dir, "a.log"));
    expect(two.filter(([path]) => path !== dir)).toEqual([[join(dir, "a.txt"), true]]);
  });

  test("a path that is already watched keeps being reported when its stats start to match", async () => {
    const file = join(dir, "a.txt");
    await writeFile(file, "1");
    const { w, seen } = await start(dir, {
      ignored: (_path, stats) => stats?.isFile() === true && stats.size > 5,
    });
    await writeFile(file, "123456789");
    await w.rescan();
    await until(() => seen.length > 0);
    expect(seen).toEqual([["change", file]]);
  });

  test("a path whose stats match is picked up once they stop matching", async () => {
    const file = join(dir, "a.txt");
    await writeFile(file, "123456789");
    const { w, seen } = await start(dir, {
      ignored: (_path, stats) => stats?.isFile() === true && stats.size > 5,
    });
    await writeFile(file, "12");
    await w.rescan();
    await until(() => seen.length > 0);
    expect(seen).toEqual([["add", file]]);
  });

  test("a watched file whose stats match is picked up without rescan once they stop matching", async () => {
    const file = join(dir, "a.txt");
    await writeFile(file, "123456789");
    const { seen } = await start(file, {
      ignored: (_path, stats) => stats?.isFile() === true && stats.size > 5,
    });
    await writeFile(file, "12");
    await until(() => seen.length > 0);
    expect(seen).toEqual([["add", file]]);
  });

  test("a link is given the stats of what it points at", async () => {
    await mkdir(join(dir, "sub"));
    const link = join(dir, "link");
    await symlink(join(dir, "sub"), link, "junction");
    await settle(500);
    const given: Array<[boolean, boolean]> = [];
    await start(dir, {
      ignoreInitial: false,
      ignored: (path, stats) => {
        if (path === link && stats) given.push([stats.isDirectory(), stats.isSymbolicLink()]);
        return false;
      },
    });
    expect(given).toEqual([[true, false]]);
  });
});

describe("rescan", () => {
  test("reports a file created, changed and removed without waiting for a native event", async () => {
    await writeFile(join(dir, "b.txt"), "1");
    await writeFile(join(dir, "c.txt"), "1");
    const { w, seen } = await start(dir);
    await writeFile(join(dir, "a.txt"), "1");
    await writeFile(join(dir, "b.txt"), "22");
    await rm(join(dir, "c.txt"));
    await w.rescan();
    await until(() => seen.length >= 3);
    await settle();
    expect(seen).toHaveLength(3);
    expect(seen).toEqual(
      expect.arrayContaining([
        ["add", join(dir, "a.txt")],
        ["change", join(dir, "b.txt")],
        ["unlink", join(dir, "c.txt")],
      ]),
    );
  });

  test("reports nothing when nothing has changed", async () => {
    await writeFile(join(dir, "a.txt"), "1");
    const { w, seen } = await start(dir);
    await w.rescan();
    await settle();
    expect(seen).toEqual([]);
  });

  test("reads directories below the watched one again", async () => {
    await mkdir(join(dir, "sub", "deep"), { recursive: true });
    const { w, seen } = await start(dir);
    await writeFile(join(dir, "sub", "deep", "a.txt"), "1");
    await w.rescan();
    await until(() => seen.length > 0);
    await settle();
    expect(seen).toEqual([["add", join(dir, "sub", "deep", "a.txt")]]);
  });

  test("reports a file that appears at a watched path that did not exist", async () => {
    const file = join(dir, "a.txt");
    const { w, seen } = await start(file);
    await writeFile(file, "1");
    await w.rescan();
    await until(() => seen.length > 0);
    expect(seen).toEqual([["add", file]]);
  });

  test("respects depth and ignored", async () => {
    await mkdir(join(dir, "sub"));
    const { w, seen } = await start(dir, { depth: 0, ignored: /\.log$/ });
    await writeFile(join(dir, "sub", "a.txt"), "1");
    await writeFile(join(dir, "a.log"), "1");
    await writeFile(join(dir, "b.txt"), "1");
    await w.rescan();
    await until(() => seen.length > 0);
    await settle();
    expect(seen).toEqual([["add", join(dir, "b.txt")]]);
  });

  test("calls made while a read is running do not report the same change twice", async () => {
    const { w, seen } = await start(dir);
    await writeFile(join(dir, "a.txt"), "1");
    await Promise.all([w.rescan(), w.rescan(), w.rescan()]);
    await until(() => seen.length > 0);
    await settle();
    expect(seen).toEqual([["add", join(dir, "a.txt")]]);
  });

  test("resolves without reporting after close", async () => {
    const { w, seen } = await start(dir);
    await w.close();
    await writeFile(join(dir, "a.txt"), "1");
    await w.rescan();
    await settle();
    expect(seen).toEqual([]);
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
      await w.add(other).ready;
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

  test("calling close inside an event listener stops the all event for that report", async () => {
    const { w, seen } = await start(dir);
    let listened = false;
    w.on("add", () => {
      void w.close();
      listened = true;
    });
    await writeFile(join(dir, "a.txt"), "1");
    await until(() => listened);
    await settle();
    expect(seen).toEqual([]);
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

  test("a missing path is returned again when it is unwatched and added", async () => {
    const missing = join(dir, "again");
    const { w } = await start(missing);
    w.unwatch(missing);
    await expect(w.add(missing).ready).resolves.toEqual({ missing: [missing] });
  });

  test("overlapping adds of the same missing path each return it", async () => {
    const missing = join(dir, "overlap");
    const { w } = await start(dir);
    const first = w.add(missing).ready;
    const second = w.add(missing).ready;
    await expect(first).resolves.toEqual({ missing: [missing] });
    await expect(second).resolves.toEqual({ missing: [missing] });
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
      await chmod(join(dir, "root"), 0o755).catch(() => undefined);
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
      await until(() => errors.length > 0);
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
      await until(() => errors.length > 0);
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

    test("an unreadable directory that is removed and created again is reported again", async () => {
      const root = join(dir, "root");
      await mkdir(join(root, "locked"), { recursive: true });
      await chmod(join(root, "locked"), 0o000);
      const { w, errors } = await startCollecting(root);
      let removed = false;
      w.on("unlinkDir", () => (removed = true));
      await until(() => errors.length === 1);
      await rm(join(root, "locked"), { recursive: true });
      await until(() => removed);
      await mkdir(join(root, "locked"));
      await chmod(join(root, "locked"), 0o000);
      await until(() => errors.length === 2);
    });

    test("an unreadable directory is reported again after unwatch and add", async () => {
      const locked = await lockedDir(0o000);
      const { w, errors } = await startCollecting(locked);
      w.unwatch(locked);
      await w.add(locked).ready;
      expect(errors).toHaveLength(2);
    });

    test("an entry that cannot be inspected inside a listable directory is reported once", async () => {
      const root = join(dir, "root");
      await mkdir(root);
      await writeFile(join(root, "a.txt"), "1");
      await chmod(root, 0o400);
      const { errors } = await startCollecting(root);
      await until(() => errors.length > 0);
      await settle();
      expect(errors.map((e) => e.code)).toEqual(["EACCES"]);
    });

    test("a symbolic link whose target cannot be reached is reported once", async () => {
      const root = join(dir, "root");
      const locked = join(dir, "locked");
      await mkdir(root);
      await mkdir(locked);
      await symlink(join(locked, "target"), join(root, "link"));
      await chmod(locked, 0o000);
      const { errors } = await startCollecting(root);
      await until(() => errors.length > 0);
      await settle();
      expect(errors.map((e) => e.code)).toEqual(["EACCES"]);
    });

    test("ignorePermissionErrors skips entries that cannot be inspected silently", async () => {
      const root = join(dir, "root");
      await mkdir(root);
      await writeFile(join(root, "a.txt"), "1");
      await chmod(root, 0o400);
      const { errors } = await startCollecting(root, { ignorePermissionErrors: true });
      await settle();
      expect(errors).toEqual([]);
    });

    test("adding a directory that is still unreadable does not report it again", async () => {
      const locked = await lockedDir(0o000);
      const { w, errors } = await startCollecting(locked);
      await w.add(locked).ready;
      expect(errors).toHaveLength(1);
    });

    test("a symbolic link that is deleted and created again with an unreachable target is reported again", async () => {
      const root = join(dir, "root");
      const locked = join(dir, "locked");
      await mkdir(root);
      await mkdir(locked);
      await symlink(join(locked, "target"), join(root, "link"));
      await chmod(locked, 0o000);
      const { w, errors } = await startCollecting(root);
      const added: string[] = [];
      w.on("add", (path) => added.push(path));
      await until(() => errors.length === 1);
      await removeOnce(join(root, "link"));
      await writeFile(join(root, "marker"), "1");
      await until(() => added.includes(join(root, "marker")));
      await symlink(join(locked, "target"), join(root, "link"));
      await until(() => errors.length === 2);
    });

    test("an entry that becomes inaccessible is neither reported as removed nor reported twice", async () => {
      const root = join(dir, "root");
      await mkdir(root);
      await writeFile(join(root, "a.txt"), "1");
      const { w, errors } = await startCollecting(root);
      const removed: string[] = [];
      w.on("unlink", (path) => removed.push(path));
      await chmod(root, 0o600);
      await until(() => errors.length === 1);
      await chmod(root, 0o400);
      await settle();
      expect(errors).toHaveLength(1);
      expect(removed).toEqual([]);
    });

    test("ignorePermissionErrors skips unreadable directories silently", async () => {
      const locked = await lockedDir(0o000);
      const { errors } = await startCollecting(locked, { ignorePermissionErrors: true });
      await settle();
      expect(errors).toEqual([]);
    });

    test("ready is emitted even when the directory is unreadable", async () => {
      const locked = await lockedDir(0o000);
      const w = watch(locked, { ignoreInitial: true });
      watchers.push(w);
      w.on("error", () => undefined);
      const result = await new Promise((r) => w.once("ready", r));
      expect(result).toEqual({ missing: [] });
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

describe("persistent", () => {
  const entry = pathToFileURL(join(import.meta.dirname, "../src/index.ts")).href;

  const children: ChildProcess[] = [];
  afterEach(() => {
    for (const proc of children) proc.kill();
  });

  function child(body: string) {
    const proc = spawn(
      process.execPath,
      ["--input-type=module", "-e", `import { watch } from ${JSON.stringify(entry)};\n${body}`],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    children.push(proc);
    let out = "";
    proc.stdout.on("data", (chunk) => (out += chunk));
    const exited = new Promise<number | null>((r) => proc.once("close", (code) => r(code)));
    return { proc, exited, output: () => out };
  }

  const watched = (options: string) => `
    const w = watch(${JSON.stringify(dir)}, ${options});
    await w.ready;
    console.log("ready");
  `;

  test("persistent: false lets the process exit with the watcher left open", async () => {
    const { proc, exited } = child(watched("{ persistent: false }"));
    const timer = setTimeout(() => proc.kill(), 5000);
    expect(await exited).toBe(0);
    clearTimeout(timer);
  });

  test("a watcher keeps the process alive by default", async () => {
    const { proc, exited, output } = child(watched("{}"));
    await until(() => output().includes("ready"), 5000);
    let done = false;
    void exited.then(() => (done = true));
    await settle(500);
    expect(done).toBe(false);
    proc.kill();
    await exited;
  });

  test("persistent: false still reports a change while something else keeps the process alive", async () => {
    const { proc, exited, output } = child(`
      const w = watch(${JSON.stringify(dir)}, { persistent: false, ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 } });
      const alive = setInterval(() => {}, 1000);
      w.on("add", (path) => { console.log("add", path); clearInterval(alive); });
      await w.ready;
      console.log("ready");
    `);
    const timer = setTimeout(() => proc.kill(), 8000);
    await until(() => output().includes("ready"), 5000);
    await writeFile(join(dir, "a.txt"), "1");
    expect(await exited).toBe(0);
    clearTimeout(timer);
    expect(output()).toContain(`add ${join(dir, "a.txt")}`);
  });
});

describe("snapshot", () => {
  // what a process would write to a file on exit and read back on the next start
  const saved = (w: FSWatcher): Snapshot => JSON.parse(JSON.stringify(w.snapshot()));

  async function stopped(paths: string | string[], opts: Parameters<typeof watch>[1] = {}) {
    const { w } = await start(paths, opts);
    const snapshot = saved(w);
    await w.close();
    return snapshot;
  }

  test("a file whose size changed while the watcher was not running is reported as change before ready", async () => {
    await writeFile(join(dir, "a.txt"), "1");
    const snapshot = await stopped(dir);
    await writeFile(join(dir, "a.txt"), "22");
    const { seen } = await start(dir, { since: snapshot });
    expect(seen).toEqual([["change", join(dir, "a.txt")]]);
  });

  test("nothing is reported for what is the same as in the snapshot", async () => {
    await writeFile(join(dir, "a.txt"), "1");
    const snapshot = await stopped(dir);
    const { seen } = await start(dir, { since: snapshot });
    await settle();
    expect(seen).toEqual([]);
  });

  test("a file deleted while the watcher was not running is reported as unlink before ready", async () => {
    await writeFile(join(dir, "a.txt"), "1");
    await writeFile(join(dir, "b.txt"), "1");
    const snapshot = await stopped(dir);
    await rm(join(dir, "b.txt"));
    const { seen } = await start(dir, { since: snapshot });
    expect(seen).toEqual([["unlink", join(dir, "b.txt")]]);
  });

  test("a file created while the watcher was not running is reported as add before ready", async () => {
    await writeFile(join(dir, "a.txt"), "1");
    const snapshot = await stopped(dir);
    await writeFile(join(dir, "b.txt"), "1");
    const { seen } = await start(dir, { since: snapshot });
    expect(seen).toEqual([["add", join(dir, "b.txt")]]);
  });

  test("changes below a subdirectory are reported with the subdirectory's own state unchanged", async () => {
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "sub", "a.txt"), "1");
    await writeFile(join(dir, "sub", "gone.txt"), "1");
    const snapshot = await stopped(dir);
    await writeFile(join(dir, "sub", "a.txt"), "22");
    await rm(join(dir, "sub", "gone.txt"));
    await writeFile(join(dir, "sub", "new.txt"), "1");
    const { seen } = await start(dir, { since: snapshot });
    expect(seen).toHaveLength(3);
    expect(seen).toEqual(
      expect.arrayContaining([
        ["change", join(dir, "sub", "a.txt")],
        ["unlink", join(dir, "sub", "gone.txt")],
        ["add", join(dir, "sub", "new.txt")],
      ]),
    );
  });

  test("a directory removed while the watcher was not running is reported as unlinkDir after what was in it", async () => {
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "sub", "a.txt"), "1");
    const snapshot = await stopped(dir);
    await rm(join(dir, "sub"), { recursive: true });
    const { seen } = await start(dir, { since: snapshot });
    expect(seen).toEqual([
      ["unlink", join(dir, "sub", "a.txt")],
      ["unlinkDir", join(dir, "sub")],
    ]);
  });

  test("a directory created while the watcher was not running is reported as addDir and add before ready", async () => {
    const snapshot = await stopped(dir);
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "sub", "a.txt"), "1");
    const { seen } = await start(dir, { since: snapshot });
    expect(seen).toEqual([
      ["addDir", join(dir, "sub")],
      ["add", join(dir, "sub", "a.txt")],
    ]);
  });

  test("a watcher started from a snapshot goes on reporting live changes below known directories", async () => {
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "sub", "a.txt"), "1");
    const snapshot = await stopped(dir);
    const { seen } = await start(dir, { since: snapshot });
    await writeFile(join(dir, "sub", "a.txt"), "22");
    await until(() => seen.length > 0);
    expect(seen).toEqual([["change", join(dir, "sub", "a.txt")]]);
  });

  test("a root that was deleted while the watcher was not running reports what was in it as unlink", async () => {
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "sub", "a.txt"), "1");
    const snapshot = await stopped(join(dir, "sub"));
    await rm(join(dir, "sub"), { recursive: true });
    const { seen } = await start(join(dir, "sub"), { since: snapshot });
    expect(seen).toEqual([
      ["unlink", join(dir, "sub", "a.txt")],
      ["unlinkDir", join(dir, "sub")],
    ]);
  });

  test("ignoreInitial does not hide the difference from the snapshot", async () => {
    await writeFile(join(dir, "a.txt"), "1");
    const snapshot = await stopped(dir);
    await writeFile(join(dir, "a.txt"), "22");
    await writeFile(join(dir, "b.txt"), "1");
    const { seen } = await start(dir, { since: snapshot, ignoreInitial: true });
    expect(seen).toHaveLength(2);
    expect(seen).toEqual(
      expect.arrayContaining([
        ["change", join(dir, "a.txt")],
        ["add", join(dir, "b.txt")],
      ]),
    );
  });

  test("a snapshot of another version is dropped and everything is reported as add", async () => {
    await writeFile(join(dir, "a.txt"), "1");
    const snapshot = { ...(await stopped(dir)), version: 999 } as unknown as Snapshot;
    const { seen } = await start(dir, { since: snapshot, ignoreInitial: true });
    expect(seen).toEqual([
      ["addDir", dir],
      ["add", join(dir, "a.txt")],
    ]);
  });

  test.each([[null], [{}], [{ version: 1 }], [{ version: 1, entries: "x" }]])(
    "a malformed snapshot (%j) is dropped and everything is reported as add",
    async (snapshot) => {
      await writeFile(join(dir, "a.txt"), "1");
      const { seen } = await start(dir, { since: snapshot as unknown as Snapshot });
      expect(seen).toEqual([
        ["addDir", dir],
        ["add", join(dir, "a.txt")],
      ]);
    },
  );

  test("an entry of a snapshot with a malformed entry is skipped and the rest is used", async () => {
    await writeFile(join(dir, "a.txt"), "1");
    const snapshot = await stopped(dir);
    snapshot.entries.push({ path: 5 } as never);
    const { seen } = await start(dir, { since: snapshot });
    await settle();
    expect(seen).toEqual([]);
  });

  test("a path that is ignored now is not reported as unlink although it is in the snapshot", async () => {
    await writeFile(join(dir, "a.txt"), "1");
    await writeFile(join(dir, "b.log"), "1");
    const snapshot = await stopped(dir);
    const { seen } = await start(dir, { since: snapshot, ignored: /\.log$/ });
    await settle();
    expect(seen).toEqual([]);
  });

  test("a path that is ignored when the snapshot is taken is not in it", async () => {
    await writeFile(join(dir, "a.txt"), "1");
    await writeFile(join(dir, "b.log"), "1");
    const snapshot = await stopped(dir, { ignored: /\.log$/ });
    expect(snapshot.entries.map((e) => e.path)).toEqual([dir, join(dir, "a.txt")]);
  });

  test("entries outside the watched paths are not reported as unlink", async () => {
    await mkdir(join(dir, "x"));
    await mkdir(join(dir, "y"));
    await writeFile(join(dir, "x", "a.txt"), "1");
    await writeFile(join(dir, "y", "b.txt"), "1");
    const snapshot = await stopped(dir);
    const { seen } = await start(join(dir, "x"), { since: snapshot });
    await settle();
    expect(seen).toEqual([]);
  });

  test("a file still waiting to be reported is left out, so the next start reports it as add", async () => {
    const { w, seen } = await start(dir, {
      awaitWriteFinish: { stabilityThreshold: 600, pollInterval: 20 },
    });
    await writeFile(join(dir, "a.txt"), "1");
    await w.rescan();
    expect(w.snapshot().entries.map((e) => e.path)).toEqual([dir]);
    await until(() => seen.length > 0, 5000);
    expect(w.snapshot().entries.map((e) => e.path)).toEqual([dir, join(dir, "a.txt")]);
  });

  test("a file that was still waiting to be reported when the watcher was closed is not in the snapshot taken after", async () => {
    const { w } = await start(dir, {
      awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 20 },
    });
    await writeFile(join(dir, "a.txt"), "1");
    await w.rescan();
    await w.close();
    expect(w.snapshot().entries.map((e) => e.path)).toEqual([dir]);
  });

  test("a change still waiting to be reported keeps the state before it, so the next start reports change", async () => {
    await writeFile(join(dir, "a.txt"), "1");
    const { w } = await start(dir, {
      awaitWriteFinish: { stabilityThreshold: 600, pollInterval: 20 },
    });
    await writeFile(join(dir, "a.txt"), "22");
    await w.rescan();
    const entry = (snapshot: Snapshot) =>
      snapshot.entries.find((e) => e.path === join(dir, "a.txt"));
    expect(entry(w.snapshot())?.size).toBe(1);
    await w.close();
    const snapshot = saved(w);
    expect(entry(snapshot)?.size).toBe(1);
    const { seen } = await start(dir, { since: snapshot });
    expect(seen).toEqual([["change", join(dir, "a.txt")]]);
  });

  test("entries deeper than depth are dropped, not reported as unlink", async () => {
    await mkdir(join(dir, "sub", "deep"), { recursive: true });
    await writeFile(join(dir, "sub", "a.txt"), "1");
    await writeFile(join(dir, "sub", "deep", "b.txt"), "1");
    const snapshot = await stopped(dir);
    const { w, seen } = await start(dir, { since: snapshot, depth: 0 });
    await settle();
    expect(seen).toEqual([]);
    expect(w.snapshot().entries.map((e) => e.path)).toEqual([dir, join(dir, "sub")]);
  });

  test("add() on a running watcher still waits for awaitWriteFinish before reporting a change", async () => {
    await writeFile(join(dir, "a.txt"), "1");
    const { w, seen } = await start(dir, {
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 20 },
    });
    await writeFile(join(dir, "a.txt"), "22");
    await w.add(dir).ready;
    expect(seen.filter(([e]) => e === "change")).toEqual([]);
    await until(() => seen.some(([e]) => e === "change"), 5000);
  });

  test("an entry whose parent directory is missing from the snapshot is dropped, not kept unreachable", async () => {
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "sub", "a.txt"), "1");
    const snapshot = await stopped(dir);
    snapshot.entries = snapshot.entries.filter((e) => e.path !== join(dir, "sub"));
    await rm(join(dir, "sub"), { recursive: true });
    const { w, seen } = await start(dir, { since: snapshot });
    await settle();
    expect(seen).toEqual([]);
    expect(w.snapshot().entries.map((e) => e.path)).toEqual([dir]);
  });

  test("files read after close() is called from a listener are not in the snapshot taken afterwards", async () => {
    for (let i = 0; i < 40; i++) await writeFile(join(dir, `f${i}.txt`), "1");
    const w = watch(dir, { ignoreInitial: false });
    watchers.push(w);
    const seen: string[] = [];
    w.on("add", (path) => {
      seen.push(path);
      void w.close();
    });
    await until(() => seen.length > 0);
    await w.close();
    await w.rescan();
    const files = w.snapshot().entries.filter((e) => !e.dir);
    expect(files.every((e) => seen.includes(e.path))).toBe(true);
  });

  test("a file deleted and created again within the atomic window keeps its reported state in the snapshot", async () => {
    await writeFile(join(dir, "a.txt"), "1");
    const { w } = await start(dir, {
      atomic: 500,
      awaitWriteFinish: { stabilityThreshold: 600, pollInterval: 20 },
    });
    await rm(join(dir, "a.txt"));
    await w.rescan();
    await writeFile(join(dir, "a.txt"), "22");
    await w.rescan();
    await w.close();
    const snapshot = saved(w);
    expect(snapshot.entries.find((e) => e.path === join(dir, "a.txt"))?.size).toBe(1);
    const { seen } = await start(dir, { since: snapshot });
    expect(seen).toEqual([["change", join(dir, "a.txt")]]);
  });

  test("a file whose unlink is still held back is in the snapshot, so the next start reports the unlink", async () => {
    await writeFile(join(dir, "a.txt"), "1");
    const { w } = await start(dir, { atomic: 2000 });
    await rm(join(dir, "a.txt"));
    await w.rescan();
    const snapshot = saved(w);
    expect(snapshot.entries.map((e) => e.path)).toContain(join(dir, "a.txt"));
    await w.close();
    expect(saved(w).entries.map((e) => e.path)).toContain(join(dir, "a.txt"));
    const { seen } = await start(dir, { since: snapshot });
    expect(seen).toEqual([["unlink", join(dir, "a.txt")]]);
  });

  test("a directory is in the snapshot as a directory with the file entries around it", async () => {
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "sub", "a.txt"), "12");
    const { w } = await start(dir);
    const { version, entries } = w.snapshot();
    expect(version).toBe(1);
    expect(entries.map((e) => [e.path, e.dir])).toEqual([
      [dir, true],
      [join(dir, "sub"), true],
      [join(dir, "sub", "a.txt"), false],
    ]);
    expect(entries.find((e) => e.path === join(dir, "sub", "a.txt"))?.size).toBe(2);
  });
});
