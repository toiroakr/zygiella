---
"zygiella": patch
---

Fix `add()` of a directory that was just released with `unwatch()` reporting `addDir` for it although `ignoreInitial` is set, when a read of that directory (the one a native event or `rescan()` starts) was still going on. That read compared with an entry that `unwatch()` had already dropped, and the read that `add()` asked for was never made, because it was merged into the running one. The read that began before `unwatch()` is now dropped, and `add()` sets the baseline as it did before.
