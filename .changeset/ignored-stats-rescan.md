---
"zygiella": minor
---

Breaking: a `RegExp` in `ignored` is now tested against the path with `/` as the separator on every platform, as in chokidar v6. On Windows `C:\work\.git\config` is tested as `C:/work/.git/config`, so `/(^|\/)\../` matches, and a `RegExp` written for `\\` only (`/src\\gen/`) no longer does; `[\\/]` still works. Functions and strings are unchanged.

A function in `ignored` that declares two parameters is now called once per path with `(path, stats)`, where `stats` is the `fs.Stats` of the path, so `ignored: (path, stats) => stats?.isFile() === true && !path.endsWith(".js")` descends into directories and skips other files. Unlike chokidar, which calls it with the path alone first, it is never called without `stats`. A function with one parameter is called with the path alone, and no `stat` is made for it.

Add `watcher.rescan()`, which reads every watched path and directory again and reports the difference, for file systems where `fs.watch` is silent (Docker bind mounts, WSL2 `/mnt/c`, NFS, SMB).
