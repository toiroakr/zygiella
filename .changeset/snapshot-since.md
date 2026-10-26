---
"zygiella": minor
---

Report changes made while the process was not running. `watcher.snapshot()` returns the state of everything watched as a JSON-serializable `{ version, entries }` object, and the new `since` option takes it on the next start: the initial scan then reports only what was added, changed (size, mtime or inode, as for a live `change`) or removed in between, as `add`, `change`, `unlink`, `addDir` and `unlinkDir` before `ready`. Saving and loading the snapshot is up to the caller. `since: null`, or a snapshot of another version, reports everything as `add`. `since` overrides `ignoreInitial`.
