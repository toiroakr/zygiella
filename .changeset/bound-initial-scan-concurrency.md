---
"zygiella": patch
---

Lower the memory a watcher needs for its first scan. The scan used to start one task for every entry of a directory at once, so watching a tree of 20,000 files grew the resident set by 145 to 164 MB on macOS and about 200 MB on Linux, and Node with `--max-old-space-size=64` ran out of memory while scanning. The scan now examines at most 256 entries at a time across the whole tree, as chokidar does, and the same tree grows it by 17 to 39 MB. The events reported and the time until `ready` do not change.
