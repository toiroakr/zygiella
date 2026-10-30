# zygiella

A dependency-free file watcher for Node.js, built on `fs.watch`. It covers the part of the
[chokidar](https://github.com/paulmillr/chokidar) API that most tools actually use, so replacing it usually
means changing the import and, if you construct or test for `FSWatcher` yourself, that code too (see
[Migrating from chokidar](#migrating-from-chokidar)).

**Requires Node.js 22.18 or later.**

- No dependencies.
- Linux, macOS and Windows, tested on Node.js 22.18 and 24.
- Reports `add`, `addDir`, `change`, `unlink` and `unlinkDir` for files and directories, including paths that do
  not exist yet.

## Install

```sh
npm install zygiella
```

Node.js 22.18 or later.

## Usage

```ts
import { watch } from "zygiella";

const watcher = watch(["src", "config.yml"], {
  ignored: /node_modules/,
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 100 },
});

watcher.on("all", (event, path) => console.log(event, path));
watcher.on("error", (error) => console.error(error));
await watcher.ready;

// watch another path, and wait until a change made right after is reported
await watcher.add("more").ready;
watcher.unwatch("src/generated");

await watcher.close();
```

## Migrating from chokidar

1. Change the import from `chokidar` to `zygiella`. What `watch(paths, options)` returns has the same method
   names, event names and argument shapes as chokidar's watcher (`on`, `off`, `once`, `add`, `unwatch`, `getWatched`, `close`,
   the events `add`, `addDir`, `change`, `unlink`, `unlinkDir`, `all`, `ready`, `error`), except that `ready`
   passes `{ missing }` where chokidar passes nothing, and `add`, `addDir` and `change` listeners never receive
   `stats`, so code that only receives a watcher from `watch()` and does not read those arguments keeps working:

   ```ts
   import { watch } from "zygiella"; // was: import { watch } from "chokidar";

   const watcher = watch("src");
   watcher.on("change", (path) => console.log(path));
   ```

   `FSWatcher` is not a class here, only a TypeScript type. Importing it as a value fails when the module loads,
   so a type annotation needs a type-only import, even in code that never constructs a watcher:

   ```ts
   import { watch, type FSWatcher } from "zygiella"; // not: import { watch, FSWatcher } from "zygiella";
   const watcher: FSWatcher = watch("src");
   ```

   The watcher is an `EventEmitter` created by `watch()`, so these two chokidar patterns also stop working:

   ```ts
   // chokidar
   import { FSWatcher } from "chokidar";
   const watcher = new FSWatcher({ ignoreInitial: true });
   if (value instanceof FSWatcher) {
   }
   // zygiella: the first line already fails when the module loads:
   // SyntaxError: The requested module 'zygiella' does not provide an export named 'FSWatcher'

   // zygiella
   import { EventEmitter } from "node:events";
   import { watch, type FSWatcher } from "zygiella";
   const watcher: FSWatcher = watch("src", { ignoreInitial: true });
   if (value instanceof EventEmitter) {
   } // the closest test; it also accepts other emitters
   ```

   Chokidar's `new FSWatcher(options)` followed by `watcher.add(paths)` becomes `watch(paths, options)`.

2. Pass files and directories, not glob patterns. Expand a glob first, for example with `fs.glob`.
3. Expect absolute paths in events and in what `ignored` receives, whatever form you passed in. A function in
   `ignored` receives `(path, stats?)`, but unlike chokidar a function that declares `stats` is called once, with it; a `RegExp` is tested against the path with `/` as the
   separator, also on Windows, so `/(^|\/)\../` (dotfiles) works as written in chokidar's README.
4. Remove options that do not exist here (see [Differences](#differences-from-chokidar)).

As in chokidar, a path that does not exist is not an error (it is watched once it appears; `ready` resolves to
the list of such paths, see [`watch()`](#watchpaths-options)), and a directory that cannot be read (`EACCES`,
`EPERM`) is emitted as `error` unless `ignorePermissionErrors: true`.

## Migrating from fs.watch

- `ready` is this library's signal that watching is established. A file created right after `watch(dir)`,
  before `ready` resolves, can be missed or reported as an initial `addDir` / `add` (with `ignoreInitial: false`)
  or as a normal `add`, depending on timing. Await `ready` before changing anything.
- `close()` returns a promise, but stopping takes effect synchronously when it is called, as with `fs.watch`:
  no event is reported after it, even without `await`, so `watchers.forEach((w) => w.close())` keeps working
  (write `void w.close()` if your lint forbids floating promises). `await` it only to wait until work in
  progress has finished.
- A path that does not exist is not an error: no `error` is emitted, and the path is watched once it appears.
  The paths that did not exist are the `missing` of the value `ready` resolves to, so you can treat them as an
  error or ignore them:

  ```ts
  const { missing } = await watch(["src", "config.yml"]).ready;
  if (missing.length) throw new Error(`not found: ${missing.join(", ")}`);
  ```

- A directory that cannot be read (`EACCES`, `EPERM`) is emitted as `error`; `ignorePermissionErrors: true`
  silences it. Without an `error` listener, an `EventEmitter` throws on `error`.
- Node.js 22.18 or later is required.

## API

### `watch(paths, options?)`

Returns an `FSWatcher`: an `EventEmitter` (not an instance of a class you can import) with the methods and properties below. `paths` is a path or an array of paths, each a file or a
directory. A path that does not exist yet is not an error: no `error` is emitted, `ready` resolves as usual, and
the path is watched from the moment it appears. The paths that did not exist when watching started are returned
as `missing` in the value `ready` resolves to (absolute, in the order given), so you decide whether that is an
error or not:

```ts
const watcher = watch(["src", "config.yml"]);
const { missing } = await watcher.ready;
if (missing.length) console.warn(`waiting for ${missing.join(", ")}`);
```

A path that cannot be read because of permissions is not in `missing`; it is emitted as `error`.

### Options

| Option                   | Default   | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------ | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ignoreInitial`          | `false`   | Do not report what already exists when a path is watched.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `depth`                  | unlimited | How many directory levels below a watched directory are descended into. `0` reports the directory's own children (including new subdirectories) only.                                                                                                                                                                                                                                                                                                                                  |
| `ignored`                | none      | A `RegExp`, a function `(path, stats?) => boolean`, a path (it and everything below it), or an array of those. A skipped directory is not descended into. See [ignored](#ignored).                                                                                                                                                                                                                                                                                                     |
| `followSymlinks`         | `true`    | Descend into directories that a symbolic link points at. A link to a directory that is already on the way down (for example a link to an ancestor) is reported but not descended into. `false` watches a link as itself: it is reported as `add`, and pointing it somewhere else is reported as `change`.                                                                                                                                                                              |
| `atomic`                 | `true`    | `true` or a number of ms (`true` is 100). An `unlink` is held back for that long, and a file created again at the same path within it is reported as one `change`, as editors that save by deleting and creating the file produce. Also ignores editor temporary files (`.swp`, `.swx`, a trailing `~`, Sublime's `.subl*.tmp`). `false` reports a deleted file's `unlink` without the wait (an `add` is still reported as soon as the file has content, or after `awaitWriteFinish`). |
| `awaitWriteFinish`       | `false`   | `true` or `{ stabilityThreshold, pollInterval }` in ms (defaults 2000 and 100). Holds `add` and `change` back until size and mtime stop changing.                                                                                                                                                                                                                                                                                                                                      |
| `ignorePermissionErrors` | `false`   | Skip directories that cannot be read (`EACCES`, `EPERM`) silently. Otherwise each is emitted once as `error`.                                                                                                                                                                                                                                                                                                                                                                          |
| `since`                  | none      | A `Snapshot` from `watcher.snapshot()`, taken in an earlier run (`null` on the first run). The initial scan then reports only what differs from it, before `ready`, whatever `ignoreInitial` says. See [Changes made while the process was not running](#changes-made-while-the-process-was-not-running).                                                                                                                                                                              |
| `persistent`             | `true`    | With `false`, the watcher does not keep the process alive: a process with nothing else to do exits without `close()`. Events are still reported while something else keeps the process running.                                                                                                                                                                                                                                                                                        |
| `rescanInterval`         | `0`       | Call `rescan()` every this many ms (the wait starts when the previous read is done), from `ready` until `close()`. For file systems where `fs.watch` reports nothing. With `persistent: false` the timer does not keep the process alive. `0`: no timer. See [Environments without native events](#environments-without-native-events).                                                                                                                                                |

### Events

| Event       | Arguments                           | Reported when                                                                                     |
| ----------- | ----------------------------------- | ------------------------------------------------------------------------------------------------- |
| `add`       | `path`, `{ renamedFrom }`?          | a file appears; `renamedFrom` is set when it is a file that was moved (see [Behavior](#behavior)) |
| `addDir`    | `path`                              | a directory appears                                                                               |
| `change`    | `path`                              | a file's contents change                                                                          |
| `unlink`    | `path`                              | a file is removed                                                                                 |
| `unlinkDir` | `path`                              | a directory is removed                                                                            |
| `all`       | `event`, `path`, `{ renamedFrom }`? | any of the above, with the extra argument of `add`                                                |
| `ready`     | `{ missing }`                       | the paths given to `watch()` are being watched                                                    |
| `error`     | `error`                             | a path could not be read or watched (see [Behavior](#behavior))                                   |

### Methods

| Member           | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `add(paths)`     | Start watching more paths. Returns the watcher.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `unwatch(paths)` | Stop watching paths that were given to `watch()` or `add()`. Returns the watcher.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `rescan()`       | Read every watched path again now and report the difference. Returns a promise. See [Environments without native events](#environments-without-native-events).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `unwatched`      | The directories that are read but have no native watch, as a sorted array of absolute paths: `fs.watch` threw (`ENOSPC`, `EMFILE`) or reported an error, and watching again failed. Changes below them are missed. Where a whole tree is one native watch (macOS), the watched path stands for the tree. Empty when every watch is established. See [Behavior](#behavior).                                                                                                                                                                                                                                                                                                                                                                   |
| `getWatched()`   | The directories that are read and the names inside them, as an object of absolute directory path to the sorted names (files and directories) watched directly in it, for example `{ "/work": ["src"], "/work/src": ["a.ts", "sub"], "/work/src/sub": ["c.ts"] }` after `watch("/work/src")`. The directory of each path given to `watch()` or `add()` is a key as well, so `watch("/work/src/a.ts")` gives `{ "/work/src": ["a.ts"] }`, and a path that does not exist yet gives its directory with no names. Names that `ignored` skips are left out. A directory at the `depth` limit is a name in its parent but has no key, because it is not read. Taken from what is watched now: await `ready` first, and it is `{}` after `close()`. |
| `snapshot()`     | The state of everything watched as a JSON-serializable `{ version, entries }`, to save on exit and pass as `since` on the next start. See [Changes made while the process was not running](#changes-made-while-the-process-was-not-running).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `close()`        | Stop watching. Takes effect when called: nothing is reported afterwards, even if you do not `await` it. Returns a promise that resolves once work in progress has finished.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `ready`          | A promise that resolves to `{ missing }` once the paths last given to `watch()` or `add()` are being watched. `missing` lists the paths of that call that did not exist. `await watcher.add(p).ready` is safe to change `p` right after. A change made between `watch()` and `ready` can be missed, or reported as an initial `add` (with `ignoreInitial: false`) or as a normal event, depending on timing, so await `ready` before changing anything.                                                                                                                                                                                                                                                                                      |

### ignored

A `RegExp` is tested against the absolute path with `/` as the separator, so on Windows `C:\work\.git\config` is
tested as `C:/work/.git/config`. A function and a string get the path as it is, with the platform's separator.

A function that declares two parameters (its `length` is 2 or more, so a default or rest parameter does not count) is called once per path with the path and its `fs.Stats`. A function that
declares one parameter or none is called with the path alone, and no `stat` is made for it. A path that a `RegExp`,
a string or such a function already skips is not `stat`ed either. Declaring `stats` is how to descend into every
directory and still skip some files, which the path alone cannot tell apart:

```ts
watch("src", { ignored: (path, stats) => stats?.isFile() === true && !path.endsWith(".js") });
```

For a symbolic link, `stats` describes what the path is reported as: the target with `followSymlinks` (the
default), the link itself with `followSymlinks: false`. A link that points at nothing is not reported with
`followSymlinks`, and the function is not called for it. A function that declares `stats` is also not called for a
watched path that does not exist yet.

`stats` is looked at when a path is first seen, and again on each read while the path is being skipped. A path that is
already being watched keeps being watched when its `stats` later start to match (for example, a file grows past a
size limit), and a skipped path is reported (`add`, or `addDir` for a directory) once its `stats` stop matching.

## Environments without native events

`fs.watch` reports nothing on some file systems: a Docker bind mount, `/mnt/c` in WSL2, NFS and SMB. Node.js's own
documentation says it is unreliable on network file systems and on the host file systems of Vagrant and Docker, and
may not work at all. The watcher then stays silent while files change. Options, in the order to try them:

1. Watch on the host and forward the change into the container, for example with `docker compose watch`.
2. On WSL2, keep the project in the Linux file system (`~/project`) instead of `/mnt/c/...`.
3. Set `rescanInterval`. zygiella then calls `rescan()` for you, which reads every watched path and every directory
   descended into and reports the difference with the same events as a native notification. This is not polling
   in place of `fs.watch`: the native watches stay, and the timer only adds reads.

```ts
const watcher = watch("src", { ignoreInitial: true, rescanInterval: 2000 });
watcher.on("error", (error) => console.error(error));

// when you are done
await watcher.close();
```

The first read comes `rescanInterval` ms after `ready`, and each next one that long after the previous read has
finished, so a tree that takes 3 s to read with `rescanInterval: 2000` is read every 5 s, not back to back. `close()`
stops the timer. With `persistent: false` the timer is unref'd, like the `fs.watch` handles. A `setInterval` of your
own is not: `watch(dir, { persistent: false })` with `setInterval(() => void watcher.rescan(), 2000)` keeps the
process running forever, and it keeps running after `close()` unless you `clearInterval` it too.

`rescanInterval` reads the whole tree, not only `watcher.unwatched`. On the file systems above `fs.watch` succeeds and
simply stays silent, so no directory is in `unwatched`, and reading only those would find nothing. When you only want
`unwatched` (see [Behavior](#behavior)) tried again, for example after raising `fs.inotify.max_user_watches`, call
`rescan()` yourself; it also tries to watch those directories again, and so does the timer.

`rescan()` resolves once the directories have been read. `add` and `change` are reported once the file has
content (or after `awaitWriteFinish`), so they can arrive after the promise resolves. A `rescan()` call made while
a read is running does not report the same change twice, and after `close()` it does nothing. Every read covers the
whole tree, so keep the interval long for a large one. `rescanInterval` must be a number from 0 to 2147483647; any other number, and any value that is not a number
(including `false` and a numeric string), throws a `RangeError`. `undefined` and `null` mean the default, 0.

## Changes made while the process was not running

`ignoreInitial: false` reports everything that exists as `add`. To learn instead that `a.ts` changed and `b.ts` was
deleted since the last run, save `watcher.snapshot()` when you stop and pass it back as `since`. Reading and
writing the file is yours; zygiella does no I/O for it, so it stays dependency-free:

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { watch } from "zygiella";

const file = ".cache/watch-snapshot.json";
const since = await readFile(file, "utf8")
  .then(JSON.parse)
  .catch(() => null); // null: first run, or a file that cannot be read

const watcher = watch("src", { since });
// before `ready`: add / change / unlink / addDir / unlinkDir for what differs from the snapshot
watcher.on("all", (event, path) => console.log(event, path));
await watcher.ready;

// on exit
await mkdir(dirname(file), { recursive: true });
await writeFile(file, JSON.stringify(watcher.snapshot()));
await watcher.close();
```

- A path is reported as `add` when it is not in the snapshot, `unlink` when it is in the snapshot and gone, and
  `change` when its size, mtime, inode or symbolic link target differs, the same test as a live `change`. Directories are `addDir` and
  `unlinkDir`; what was below a removed directory is reported as `unlink` first.
- `since` replaces the initial report: `ignoreInitial` has no effect on it, so `ignoreInitial: true` with a snapshot
  still reports the difference. Without a usable snapshot, everything is reported as `add` (`addDir` for directories),
  whatever `ignoreInitial` says. A usable snapshot has `version: 1` and an `entries` array; an entry that does not
  look like one is skipped. When the format changes, `version` changes and an old snapshot is dropped this way, so
  the worst case is a full `add`. `null` is for the first run, when there is no file yet.
- The snapshot holds absolute paths, as events report them, so use it on the same machine and with the same
  paths. An entry outside the paths you now watch is ignored, not reported as `unlink`.
- Pass the same `ignored`, `depth` and `followSymlinks` as when it was taken. A path that `ignored` skips now
  (by its path, or because a directory above it is skipped) is left out of the comparison, so it is not reported as
  `unlink`; so is a path deeper than `depth` now. Turning `followSymlinks` off makes what was below a link count as
  removed.
- The snapshot is what has been reported so far. A file whose `add` is still waiting (for the directory reads that are going on, 10 ms for an empty
  file, or `awaitWriteFinish`) is left out, so the next start reports it as `add`. A `change` that is waiting, or an `unlink`
  held back by `atomic`, is recorded as it was before, so the next start reports `change` or `unlink`. This also holds
  for `snapshot()` called after `close()`.

## Behavior

- `add` and `change` are reported at once when the file has content. An empty file is held for 10 ms for its data (Linux
  reports a write as truncate then write, and a new file as create then write). Events for a file that was reported less
  than 50 ms ago are reported once more, 50 ms after the last of them, so a file that is written in two steps is reported
  as `add` (or `change`) with the content so far and then as `change` with the rest. Use `awaitWriteFinish` to wait for the
  whole file; it replaces these waits.
- A directory whose inode number changed between two reads is another directory under the same name (`mv src
  src.old` and then `mv staging src`): it is reported as `unlinkDir` with what was in it as `unlink`, then as
  `addDir` with what is in it now as `add`. A file system that reports inode 0 cannot tell, and a freed inode
  number that is given to the new directory is not noticed either; `rescan()` does not help in those cases.
- `ready` comes 50 ms after the OS watchers are attached, because `fs.watch` returns before macOS starts
  delivering events and a change made in that gap would be lost.
- Every event re-reads the directory it came from and compares it with what was seen before. A directory with more
  than 1000 entries that are not under `ignored` is the exception: its events are trusted for the name they carry,
  and only that entry is inspected, because reading 30,000 entries (a `readdir` and an `lstat` for each) took 0.2
  to 1 s per event on macOS and Linux. The directory is read whole once, 1 s after its last event. That read
  reports an entry whose own event was lost when other events of the directory started the wait; an entry whose
  event was lost with nothing after it stays missed until another event of that directory starts the wait, or
  until `rescan()`.
- On Linux and Windows every directory that is descended into gets its own `fs.watch`, and a directory under
  `ignored`, such as `node_modules`, costs no watches. On Linux each one uses an inotify watch, so a very large tree
  can reach `fs.inotify.max_user_watches`.
- On macOS a watched directory and everything below it is one `fs.watch` with `recursive: true`, unless `depth` is
  set. Per-directory watches do not scale there: libuv keeps one FSEventStream for the process and rebuilds it for
  every handle added or closed, so above 4096 directories every watch fails with `EMFILE` and `close()` took 3 s
  for 1000 directories and 20 s for 2000. A directory behind a followed symbolic link (and what is below it) is not
  reported by the watch of the tree, so each of those directories keeps its own `fs.watch`. A directory under
  `ignored` is watched as part of the tree, and its events are dropped. If a recursive watch is not available
  (`ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`) or cannot be set up, every directory is watched on its own as above.
- A file that is moved (`mv a.txt dir/b.txt`) is still reported as `unlink` of the old path and `add` of the new one,
  and the `add` carries `{ renamedFrom: '/work/a.txt' }` as its second argument (also the third of `all`). The two are
  paired when a file that disappeared and a file that appeared within 1 s have the same device, inode, size and mtime;
  the inode alone is not used, because a file system can give a freed inode to the next file it creates, and inode
  numbers repeat across devices. It works in either order, across directories, for a file moved again before its `add`
  is reported (`a`, then `b`, then `c`: the `add` of `c` names `a`), and for the files below a moved directory (the
  `addDir` carries nothing). It is best effort, and `renamedFrom` is absent when the file system reports inode 0, when
  the move crosses file systems (the inode changes), when the file is written, or replaced by another file, before
  its `add` is reported, when the two halves are noticed more than 1 s apart, when the `add` was already reported by
  the time the removal is noticed (a directory read that takes longer than 50 ms, or a directory of more than 1000 entries, whose entries are read one by one), and for what is reported before
  `ready` after `since` (an entry restored from a snapshot gets its device at the first read, so a move after `ready` is paired). A file that is replaced in place (`atomic`) stays one `change`, and so is the old path of a move when another file is created there before the held `unlink` is released (the `atomic` window, counted from when the removal is noticed): that `unlink` is not reported, only a `change`.
- A symbolic link to a directory is reported as `addDir` and descended into, and what is below it is reported under
  the link's path. The real path of every directory on the way down is remembered, and a link to one of them is
  reported but not descended into, so a link back to an ancestor does not loop. Pointing a followed link at another
  directory is reported as `unlinkDir` of the link (after `unlink` for what was below it), then `addDir` and `add` for
  what is below the new target. With `followSymlinks: false` a link, including one given to `watch()`, is reported as
  `add` and never descended into.
- With `atomic`, the `unlink` of a file that disappears by itself waits for the window before it is reported.
  `unlinkDir` is not held back, and the files below a removed directory are reported at once, before the directory.
- When `fs.watch` cannot be set up for a directory (`ENOSPC`, `EMFILE`: the limits on inotify watches or open
  files; with a recursive watch on macOS it is the watched path that is listed, as the whole tree is one watch), the failure is emitted as `error` and `ready` still resolves. The directory is still read, so it is
  reported once (with `ignoreInitial: false`, as `addDir` and `add` for what is below it), but later changes under it
  are not noticed, and the directory is listed in `watcher.unwatched`. The same goes for a native watcher that
  reports an error and cannot be set up again, or that reports `ENOSPC` or `EMFILE` (watching again would only use up
  more of the limit), or that reports an error a fourth time in a row with no event in between (it is watched again after the first three). Otherwise zygiella
  watches the directory again once. `rescan()` reads the directory
  again, reports what changed, and tries to watch it again, after which it leaves `unwatched`. If it still fails,
  `error` is emitted again (except a permission error, which follows the rules below). Raise the limit (on Linux, `fs.inotify.max_user_watches` and
  `fs.inotify.max_user_instances`; `ulimit -n` for open files), or set `rescanInterval` as described in
  [Environments without native events](#environments-without-native-events).
- Nothing above a watched path is watched. A link given to `watch()`, or a link whose target is outside the watched
  tree, is not noticed when the link is replaced or when its target is deleted and created again.
- A directory or an entry (including the target of a symbolic link) that cannot be read, watched or inspected
  because of permissions (`EACCES`, `EPERM`) is emitted as `error` once per path, and `ready` still resolves. With `ignorePermissionErrors: true` it is skipped silently. A watched path
  that cannot be inspected for lack of permission is not reported as removed, and what is below it stays as it was
  until it can be read again. A path that
  disappears while being watched (`ENOENT`, `ENOTDIR`) is skipped silently. Other failures are emitted as
  `error`; without an `error` listener that throws, as with any `EventEmitter`.

## Differences from chokidar

- `FSWatcher` is a type only: `new FSWatcher(...)` and `instanceof FSWatcher` do not work, and a watcher is only created by `watch()`.
- No glob patterns. `ignored` strings match a path and everything below it.
- Paths are always absolute, with the platform's separator (`C:\work\src\a.ts` on Windows). A function or string
  in `ignored` receives them in that form; a RegExp is tested against the path with `/` as the separator, as in
  chokidar. A RegExp written for `\\` only (`/src\\gen/`) no longer matches on Windows; `[\\/]` still does.
- No `usePolling`, `cwd`, `alwaysStat`, and no `stats` argument on events. `rescanInterval` (or `rescan()`, called by you) is the
  substitute for polling: it reads the tree again and keeps `fs.watch` in place, instead of replacing it.
- `persistent: false` is supported, with one difference: `ready` still resolves when nothing else keeps the process alive, because its short settle wait is not unref'd.
- `getWatched()` returns a plain object of absolute paths sorted by path (no `cwd`, so no relative keys and no `.`), and a directory at the `depth` limit has no key, where chokidar lists it with no names. After `close()` it returns `{}`, as chokidar does.
- `change` events are coalesced as described above, so a rapid second write may not produce a second event.
- `change` is the only event for a modification, and listeners get the path only (chokidar also passes `stats`). A
  `touch` that changes only the modification time is reported as `change`; a `chmod` that changes only the
  permissions is not reported. Nothing tells a content change from a time change.
- There is no rename event, and no separate event for a move. `mv a.txt b.txt` is reported as `add` of `b.txt` and `unlink` of `a.txt`, two events
  with their own delays: the `add` is reported when the file has content (or after `awaitWriteFinish`), and the `unlink` is held back for the `atomic`
  window (100 ms by default) that starts when the removal is noticed. Which one arrives first is not promised. A moved
  file is the one thing that links them: see `renamedFrom` under [Behavior](#behavior).

## License

MIT
