---
"zygiella": patch
---

Do not watch a directory again after its native watcher reported `EMFILE` or `ENOSPC`, and stop at the fourth error in a row without an event (the first three are retried). On macOS every handle gets `EMFILE` at once when the process holds too many watches, and watching them all again kept the process busy for good: `ready` never came. `rescan()` still tries again.
