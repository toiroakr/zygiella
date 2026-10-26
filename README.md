# naruko

A dependency-free file watcher for Node.js (>= 22.18) built on `fs.watch`. It covers the part of the
[chokidar](https://github.com/paulmillr/chokidar) API that most tools actually use, so replacing it is
usually a one-line change to the import.

```ts
import { watch } from "naruko";

const watcher = watch(["src", "config.yml"], {
  ignored: /node_modules/,
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 100 },
});

watcher.on("all", (event, path) => console.log(event, path));
watcher.on("error", (error) => console.error(error));
await new Promise((resolve) => watcher.once("ready", resolve));

watcher.add("more");
watcher.unwatch("src/generated");
await watcher.close();
```

## API

- `watch(paths, options)` returns an `FSWatcher` (an `EventEmitter`)
- events: `add` `addDir` `change` `unlink` `unlinkDir`, `all(event, path)`, `ready`, `error`
- methods: `add(paths)`, `unwatch(paths)`, `close(): Promise<void>`; `ready: Promise<void>`
- options: `ignoreInitial`, `depth`, `ignored` (`RegExp`, function, path prefix string, or an array of those),
  `awaitWriteFinish` (`true` or `{ stabilityThreshold, pollInterval }`)

## Differences from chokidar

- Paths are always reported as absolute paths, with the platform's separator (`C:\work\src\a.ts` on Windows).
  `ignored` receives them in that form, so write a RegExp that spans directories with `[\\/]`.
- No glob patterns: pass files and directories. `ignored` strings match a path and everything below it.
- No `usePolling`, `cwd`, `atomic`, `followSymlinks`, `alwaysStat`, or `stats` argument on events.
- Symbolic links to directories are reported but not descended into.
- A watcher is attached to every directory that is descended into, one by one (not `recursive: true`), so
  an ignored directory such as `node_modules` costs no watches on any platform.
- `ready` is emitted 50 ms after the OS watchers are attached, because `fs.watch` returns before macOS
  (FSEvents) starts delivering and a change made in that gap would be lost. A change made right after `ready`
  is reported. `add()` has no such wait, so a change made immediately after it can be missed.
- `add` and `change` are reported once the events for a file have been quiet for 50 ms (Linux reports a write
  as truncate then write, and a new file as create then write), unless `awaitWriteFinish` is set, which
  replaces that wait. Events found by the initial scan are reported at once.
- Directories that cannot be read (`EACCES`, `EPERM`, `ENOENT`) are skipped silently; other failures are
  emitted as `error`.
