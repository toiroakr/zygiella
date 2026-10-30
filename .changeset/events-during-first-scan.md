---
"zygiella": patch
---

Do not report what is already there when a native event arrives while the first scan is still reading. With `ignoreInitial: true`, a directory of 1100 files that was created just before `watch()` could be reported as 1100 `add` events: macOS can deliver the events of files created just before watching after the watcher has started, the directory read that such an event starts ran at the same time as the first scan, and it saw the entries that the scan had not recorded yet as new. A read that an event starts now waits for a scan of the root above it that is making the baseline (the first scan, not a `rescan()`), as chokidar serializes its work per root.
