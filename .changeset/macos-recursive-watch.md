---
"zygiella": minor
---

Watch a tree with one `fs.watch({ recursive: true })` on macOS (not with `depth`), and watch each directory behind a followed link on its own. Per-directory watches stop working on macOS above 4096 directories: every one of them fails with `EMFILE` and `ready` never arrives, and `close()` takes 20 s for 2000 directories. With a recursive watch `watcher.unwatched` lists the watched path instead of directories. Linux and Windows are unchanged.
