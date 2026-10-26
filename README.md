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
3. Expect absolute paths in events and in what `ignored` receives, whatever form you passed in.
4. Remove options that do not exist here (see [Differences](#differences-from-chokidar)).

As in chokidar, a path that does not exist is not an error (it is watched once it appears; `ready` resolves to
the list of such paths, see [`watch()`](#watchpaths-options)), and a directory that cannot be read (`EACCES`,
`EPERM`) is emitted as `error` unless `ignorePermissionErrors: true`.

## Migrating from fs.watch

- `fs.watch` is effective from the moment it returns, but `watch()` is not until `await watcher.ready`. A file
  created right after `watch(dir)` without awaiting `ready` is reported as an initial `addDir` / `add` with
  `ignoreInitial: false`, and not reported at all with `ignoreInitial: true`. Await `ready` before changing
  anything.
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

| Option                   | Default   | Meaning                                                                                                                                               |
| ------------------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ignoreInitial`          | `false`   | Do not report what already exists when a path is watched.                                                                                             |
| `depth`                  | unlimited | How many directory levels below a watched directory are descended into. `0` reports the directory's own children (including new subdirectories) only. |
| `ignored`                | none      | A `RegExp`, a function `(path) => boolean`, a path (it and everything below it), or an array of those. A skipped directory is not descended into.     |
| `awaitWriteFinish`       | `false`   | `true` or `{ stabilityThreshold, pollInterval }` in ms (defaults 2000 and 100). Holds `add` and `change` back until size and mtime stop changing.     |
| `ignorePermissionErrors` | `false`   | Skip directories that cannot be read (`EACCES`, `EPERM`) silently. Otherwise each is emitted once as `error`.                                         |

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

| Member           | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `add(paths)`     | Start watching more paths. Returns the watcher.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `unwatch(paths)` | Stop watching paths that were given to `watch()` or `add()`. Returns the watcher.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `close()`        | Stop watching. Takes effect when called: nothing is reported afterwards, even if you do not `await` it. Returns a promise that resolves once work in progress has finished.                                                                                                                                                                                                                                                                                                                                          |
| `ready`          | A promise that resolves to `{ missing }` once the paths last given to `watch()` or `add()` are being watched. `missing` lists the paths of that call that did not exist. `await watcher.add(p).ready` is safe to change `p` right after. A change made between `watch()` and `ready` is either missed or reported as an initial `add` (with `ignoreInitial: false`, `addDir` and `add` for a file created right after `watch(dir)`; with `ignoreInitial: true`, nothing), so await `ready` before changing anything. |

## Behavior

- A burst of events for one file is reported once, 50 ms after the last event (Linux reports a write as truncate
  then write, and a new file as create then write). `awaitWriteFinish` replaces that wait.
- `ready` comes 50 ms after the OS watchers are attached, because `fs.watch` returns before macOS starts
  delivering events and a change made in that gap would be lost.
- Every directory that is descended into gets its own `fs.watch`, and every event re-reads that directory and
  compares it with what was seen before. A directory under `ignored`, such as `node_modules`, costs no watches.
  On Linux each watched directory uses one inotify watch, so a very large tree can reach
  `fs.inotify.max_user_watches`.
- Symbolic links are reported as what they point at, and never descended into.
- A directory or an entry (including the target of a symbolic link) that cannot be read, watched or inspected
  because of permissions (`EACCES`, `EPERM`) is emitted as `error` once per path, and `ready` still resolves. With `ignorePermissionErrors: true` it is skipped silently. A path that
  disappears while being watched (`ENOENT`, `ENOTDIR`) is skipped silently. Other failures are emitted as
  `error`; without an `error` listener that throws, as with any `EventEmitter`.

## Differences from chokidar

- No glob patterns. `ignored` strings match a path and everything below it.
- Paths are always absolute, with the platform's separator (`C:\work\src\a.ts` on Windows). `ignored` receives
  them in that form, so write a RegExp that spans directories with `[\\/]`.
- No `usePolling`, `cwd`, `atomic`, `followSymlinks`, `alwaysStat`, and no `stats` argument on events.
- `change` events are coalesced as described above, so a rapid second write may not produce a second event.

## License

MIT
