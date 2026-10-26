---
"zygiella": minor
---

Emit `error` for directories that cannot be read (`EACCES`, `EPERM`) instead of skipping them silently, and add `ignorePermissionErrors` to restore the old behavior. A watcher without an `error` listener now throws for such a directory, so pass `ignorePermissionErrors: true` to keep skipping them.
