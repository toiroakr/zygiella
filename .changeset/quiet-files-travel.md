---
"zygiella": patch
---

Report where a moved file came from: the `add` of a file that was moved carries `{ renamedFrom }` as its second argument (the third of `all`), found as a file that disappeared and one that appeared within 1 s with the same device, inode, size and mtime (best effort: not on a file system that reports inode 0, across file systems, or when either half is noticed late). `unlink` and `add` are reported as before.
