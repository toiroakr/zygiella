---
"zygiella": minor
---

`FSWatcher` is no longer a class: it is exported as a TypeScript type only, and `watch(paths, options)` returns a plain `EventEmitter` with the same methods, properties and events as before (`on`, `add`, `unwatch`, `rescan`, `close`, `snapshot`, `ready`, `unwatched`). Code that calls `new FSWatcher(paths, options)` must call `watch(paths, options)` instead, and `watcher instanceof FSWatcher` must be replaced, for example by `watcher instanceof EventEmitter`. Importing `FSWatcher` as a value, as in `import { watch, FSWatcher } from "zygiella"`, now fails with a SyntaxError when the module loads, so use `import type { FSWatcher }` or `import { watch, type FSWatcher }` when you only need the type. Code that only receives a watcher from `watch()` and calls its methods is not affected. Internally the source is split into modules for path matching, option defaults, snapshots, native watch handles and waiting reports; the behaviour of `watch()` is unchanged.
