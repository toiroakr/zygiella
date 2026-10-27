---
"zygiella": minor
---

Add `getWatched()`, the chokidar method that tells which directories are watched and what is in them. `watch("/work/src").getWatched()` returns `{ "/work": ["src"], "/work/src": ["a.ts", "sub"], "/work/src/sub": ["c.ts"] }`: absolute directory paths as keys, the sorted names of the files and directories watched directly in each as values. Skipped by `ignored` or below `depth`, they are not listed, and a directory at the `depth` limit is a name without a key of its own. It is `{}` after `close()`.
