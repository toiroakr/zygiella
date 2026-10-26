# zygiella

A dependency-free file watcher for Node.js, built on `fs.watch`. It covers the part of the
[chokidar](https://github.com/paulmillr/chokidar) API that most tools actually use, so replacing it is
usually a one-line change to the import.

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

## API

### `watch(paths, options?)`

Returns an `FSWatcher`, which is an `EventEmitter`. `paths` is a path or an array of paths, each a file or a
directory. A path that does not exist yet is watched from the moment it appears.

### Options

| Option             | Default   | Meaning                                                                                                                                               |
| ------------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ignoreInitial`    | `false`   | Do not report what already exists when a path is watched.                                                                                             |
| `depth`            | unlimited | How many directory levels below a watched directory are descended into. `0` reports the directory's own children (including new subdirectories) only. |
| `ignored`          | none      | A `RegExp`, a function `(path) => boolean`, a path (it and everything below it), or an array of those. A skipped directory is not descended into.     |
| `awaitWriteFinish` | `false`   | `true` or `{ stabilityThreshold, pollInterval }` in ms (defaults 2000 and 100). Holds `add` and `change` back until size and mtime stop changing.     |

### Events

| Event       | Arguments       | Reported when                                  |
| ----------- | --------------- | ---------------------------------------------- |
| `add`       | `path`          | a file appears                                 |
| `addDir`    | `path`          | a directory appears                            |
| `change`    | `path`          | a file's contents change                       |
| `unlink`    | `path`          | a file is removed                              |
| `unlinkDir` | `path`          | a directory is removed                         |
| `all`       | `event`, `path` | any of the above                               |
| `ready`     | none            | the paths given to `watch()` are being watched |
| `error`     | `error`         | something other than an unreadable path failed |

### Methods

| Member           | Meaning                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `add(paths)`     | Start watching more paths. Returns the watcher.                                                                                                              |
| `unwatch(paths)` | Stop watching paths that were given to `watch()` or `add()`. Returns the watcher.                                                                            |
| `close()`        | Stop watching. Returns a promise that resolves once work in progress has finished.                                                                           |
| `ready`          | A promise that resolves once the paths last given to `watch()` or `add()` are being watched. `await watcher.add(p).ready` is safe to change `p` right after. |

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
- Directories that cannot be read (`EACCES`, `EPERM`, `ENOENT`) are skipped silently. Other failures are emitted
  as `error`; without an `error` listener that throws, as with any `EventEmitter`.

## Differences from chokidar

- No glob patterns. `ignored` strings match a path and everything below it.
- Paths are always absolute, with the platform's separator (`C:\work\src\a.ts` on Windows). `ignored` receives
  them in that form, so write a RegExp that spans directories with `[\\/]`.
- No `usePolling`, `cwd`, `atomic`, `followSymlinks`, `alwaysStat`, and no `stats` argument on events.
- `change` events are coalesced as described above, so a rapid second write may not produce a second event.

## License

MIT
