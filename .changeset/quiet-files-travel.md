---
"zygiella": patch
---

Report where a moved file came from: the `add` of a file that was moved carries `{ renamedFrom }` as its second argument (the third of `all`), found by inode, size and mtime. `unlink` and `add` are reported as before.
