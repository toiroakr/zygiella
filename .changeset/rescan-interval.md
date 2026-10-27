---
"zygiella": minor
---

Add the `rescanInterval` option. With `rescanInterval: 2000`, the watcher calls `rescan()` 2000 ms after `ready` and again 2000 ms after each read has finished, until `close()`, for file systems where `fs.watch` reports nothing (NFS, Docker bind mounts, `/mnt/c` in WSL2). With `persistent: false` the timer is unref'd, which a `setInterval` of your own is not. The default is 0 (no timer).
