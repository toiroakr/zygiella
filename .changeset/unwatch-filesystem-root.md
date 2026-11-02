---
"zygiella": patch
---

Fix `unwatch()` of a watched file system root (`/`, or a drive root on Windows) never returning, and keep forgetting what is below a path correct when watched roots are not connected through tracked directories (for example `watch([dir, dir/a/b/c], { depth: 0 })`).
