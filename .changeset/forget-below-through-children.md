---
"zygiella": patch
---

Make forgetting a path cost what is below it, not what is tracked. Every removal of a file or directory tested every tracked path against it, so deleting 3,000 files from a directory of a tree of 5,000 entries took 3.2 to 6.7 s of CPU on Linux, 2,000 renames in one directory 0.65 s, and the cost grew with the square of the tree. The entries below a path are now found through the tracked directories, which makes those two 0.2 s and 0.27 s, and holding unlinks back for `atomic` no longer reads every held unlink for each file removed. The events reported do not change.
