---
"zygiella": minor
---

Add `watcher.unwatched`, the directories that are read but have no native watch because `fs.watch` threw (`ENOSPC`, `EMFILE`) or the native watcher reported an error and could not be set up again. Until now the `error` event was the only sign, `ready` still resolved, and changes below such a directory were missed with no way to tell which directory it was. `rescan()` now also tries to watch those directories again, so a caller that rescans on a timer recovers once the limit is raised or released. zygiella still does not rescan by itself.
