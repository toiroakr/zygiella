# zygiella

A dependency-free file watcher for Node.js, built on `fs.watch`. It covers the part of the
[chokidar](https://github.com/paulmillr/chokidar) API that most tools actually use, so replacing it is
usually a one-line change to the import.

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

1. Change the import from `chokidar` to `zygiella`. `watch(paths, options)` and the `FSWatcher` methods and
   events listed below keep their names and shapes.
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

Returns an `FSWatcher`, which is an `EventEmitter`. `paths` is a path or an array of paths, each a file or a
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

| Option                   | Default   | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ignoreInitial`          | `false`   | Do not report what already exists when a path is watched.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `depth`                  | unlimited | How many directory levels below a watched directory are descended into. `0` reports the directory's own children (including new subdirectories) only.                                                                                                                                                                                                                                                                                                                  |
| `ignored`                | none      | A `RegExp`, a function `(path, stats?) => boolean`, a path (it and everything below it), or an array of those. A skipped directory is not descended into. See [ignored](#ignored). |
| `followSymlinks`         | `true`    | Descend into directories that a symbolic link points at. A link to a directory that is already on the way down (for example a link to an ancestor) is reported but not descended into. `false` watches a link as itself: it is reported as `add`, and pointing it somewhere else is reported as `change`.                                                                                                                                                              |
| `atomic`                 | `true`    | `true` or a number of ms (`true` is 100). An `unlink` is held back for that long, and a file created again at the same path within it is reported as one `change`, as editors that save by deleting and creating the file produce. Also ignores editor temporary files (`.swp`, `.swx`, a trailing `~`, Sublime's `.subl*.tmp`). `false` reports a deleted file's `unlink` without the wait (an `add` is still reported after the usual 50 ms, or `awaitWriteFinish`). |
| `awaitWriteFinish`       | `false`   | `true` or `{ stabilityThreshold, pollInterval }` in ms (defaults 2000 and 100). Holds `add` and `change` back until size and mtime stop changing.                                                                                                                                                                                                                                                                                                                      |
| `ignorePermissionErrors` | `false`   | Skip directories that cannot be read (`EACCES`, `EPERM`) silently. Otherwise each is emitted once as `error`.                                                                                                                                                                                                                                                                                                                                                          |

### Events

| Event       | Arguments       | Reported when                                                   |
| ----------- | --------------- | --------------------------------------------------------------- |
| `add`       | `path`          | a file appears                                                  |
| `addDir`    | `path`          | a directory appears                                             |
| `change`    | `path`          | a file's contents change                                        |
| `unlink`    | `path`          | a file is removed                                               |
| `unlinkDir` | `path`          | a directory is removed                                          |
| `all`       | `event`, `path` | any of the above                                                |
| `ready`     | `{ missing }`   | the paths given to `watch()` are being watched                  |
| `error`     | `error`         | a path could not be read or watched (see [Behavior](#behavior)) |

### Methods

| Member           | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `add(paths)`     | Start watching more paths. Returns the watcher.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `unwatch(paths)` | Stop watching paths that were given to `watch()` or `add()`. Returns the watcher.                                                                                                                                                                                                                                                                                                                                                                       |
| `rescan()`       | Read every watched path again now and report the difference. Returns a promise. See [Environments without native events](#environments-without-native-events). |
| `close()`        | Stop watching. Takes effect when called: nothing is reported afterwards, even if you do not `await` it. Returns a promise that resolves once work in progress has finished.                                                                                                                                                                                                                                                                             |
| `ready`          | A promise that resolves to `{ missing }` once the paths last given to `watch()` or `add()` are being watched. `missing` lists the paths of that call that did not exist. `await watcher.add(p).ready` is safe to change `p` right after. A change made between `watch()` and `ready` can be missed, or reported as an initial `add` (with `ignoreInitial: false`) or as a normal event, depending on timing, so await `ready` before changing anything. |

### ignored

A `RegExp` is tested against the absolute path with `/` as the separator, so on Windows `C:\work\.git\config` is
tested as `C:/work/.git/config`. A function and a string get the path as it is, with the platform's separator.

A function that declares two parameters is called once per path with the path and its `fs.Stats`. A function that
declares one parameter or none is called with the path alone, and no `stat` is made for it. A path that a `RegExp`,
a string or such a function already skips is not `stat`ed either. Declaring `stats` is how to descend into every
directory and still skip some files, which the path alone cannot tell apart:

```ts
watch("src", { ignored: (path, stats) => stats?.isFile() && !path.endsWith(".js") });
```

For a symbolic link, `stats` describes what the path is reported as: the target with `followSymlinks` (the
default), the link itself with `followSymlinks: false`. A link that points at nothing is not reported with
`followSymlinks`, and the function is not called for it. A function that declares `stats` is also not called for a
watched path that does not exist yet.

## Environments without native events

`fs.watch` reports nothing on some file systems: a Docker bind mount, `/mnt/c` in WSL2, NFS and SMB. Node.js's own
documentation says it is unreliable on network file systems and on the host file systems of Vagrant and Docker, and
may not work at all. The watcher then stays silent while files change. Options, in the order to try them:

1. Watch on the host and forward the change into the container, for example with `docker compose watch`.
2. On WSL2, keep the project in the Linux file system (`~/project`) instead of `/mnt/c/...`.
3. Call `rescan()` yourself. It reads every watched path and every directory descended into right now, and reports
   the difference with the same events as a native notification. zygiella has no polling of its own, so choose
   how often:

```ts
const watcher = watch("src", { ignoreInitial: true });
setInterval(() => void watcher.rescan(), 2000);
```

`rescan()` resolves once the directories have been read. `add` and `change` are reported after the usual wait
(50 ms of quiet, or `awaitWriteFinish`), so they can arrive after the promise resolves. A call made while a read is
running does not report the same change twice, and after `close()` it does nothing. Every call reads the whole
tree, so keep the interval long for a large one.

## Behavior

- A burst of events for one file is reported once, 50 ms after the last event (Linux reports a write as truncate
  then write, and a new file as create then write). `awaitWriteFinish` replaces that wait.
- `ready` comes 50 ms after the OS watchers are attached, because `fs.watch` returns before macOS starts
  delivering events and a change made in that gap would be lost.
- Every directory that is descended into gets its own `fs.watch`, and every event re-reads that directory and
  compares it with what was seen before. A directory under `ignored`, such as `node_modules`, costs no watches.
  On Linux each watched directory uses one inotify watch, so a very large tree can reach
  `fs.inotify.max_user_watches`.
- A symbolic link to a directory is reported as `addDir` and descended into, and what is below it is reported under
  the link's path. The real path of every directory on the way down is remembered, and a link to one of them is
  reported but not descended into, so a link back to an ancestor does not loop. Pointing a followed link at another
  directory is reported as `unlinkDir` of the link (after `unlink` for what was below it), then `addDir` and `add` for
  what is below the new target. With `followSymlinks: false` a link, including one given to `watch()`, is reported as
  `add` and never descended into.
- With `atomic`, the `unlink` of a file that disappears by itself waits for the window before it is reported.
  `unlinkDir` is not held back, and the files below a removed directory are reported at once, before the directory.
- Nothing above a watched path is watched. A link given to `watch()`, or a link whose target is outside the watched
  tree, is not noticed when the link is replaced or when its target is deleted and created again.
- A directory or an entry (including the target of a symbolic link) that cannot be read, watched or inspected
  because of permissions (`EACCES`, `EPERM`) is emitted as `error` once per path, and `ready` still resolves. With `ignorePermissionErrors: true` it is skipped silently. A path that
  disappears while being watched (`ENOENT`, `ENOTDIR`) is skipped silently. Other failures are emitted as
  `error`; without an `error` listener that throws, as with any `EventEmitter`.

## Differences from chokidar

- No glob patterns. `ignored` strings match a path and everything below it.
- Paths are always absolute, with the platform's separator (`C:\work\src\a.ts` on Windows). A function or string
  in `ignored` receives them in that form; a RegExp is tested against the path with `/` as the separator, as in
  chokidar. A RegExp written for `\\` only (`/src\\gen/`) no longer matches on Windows; `[\\/]` still does.
- No `usePolling`, `cwd`, `alwaysStat`, and no `stats` argument on events. `rescan()` is the substitute for
  polling, called by you.
- `change` events are coalesced as described above, so a rapid second write may not produce a second event.

## License

MIT
