---
"zygiella": patch
---

Report a directory that was replaced by another directory under the same name. After `mv src src.old` and `mv staging src`, the files that were in `src` were never reported as removed and the files that are in it now were never reported as added, until another event of `src` or `rescan()`. A directory whose inode number differs from the one seen before is now reported as `unlinkDir` (with `unlink` for what was in it) and then `addDir` (with `add` for what is in it). A file system that reports inode 0 is not affected.
