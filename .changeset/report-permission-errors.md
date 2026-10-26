---
"zygiella": minor
---

Emit `error` for directories that cannot be read (`EACCES`, `EPERM`) instead of skipping them silently, and add `ignorePermissionErrors` to restore the old behavior.
