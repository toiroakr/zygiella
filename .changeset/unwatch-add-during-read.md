---
"zygiella": patch
---

Fix `addDir` being reported for a directory that is added again right after `unwatch()` although `ignoreInitial` is set, when a read of that directory (started by a native event or `rescan()`) was still going on.
