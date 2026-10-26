---
"zygiella": minor
---

`ready` now resolves to `{ missing: string[] }`, the paths given to `watch()` or `add()` that did not exist, and the `ready` event receives the same object. Missing paths are still watched once they appear.
