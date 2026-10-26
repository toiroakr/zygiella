---
"zygiella": minor
---

Emit `error` for directories and entries that cannot be read or inspected (`EACCES`, `EPERM`), including symbolic links whose target cannot be reached, instead of skipping them silently, and add `ignorePermissionErrors` to restore the old behavior. A watcher without an `error` listener now throws for such a path, so pass `ignorePermissionErrors: true` to keep skipping them.
