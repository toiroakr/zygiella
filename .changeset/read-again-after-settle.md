---
"zygiella": patch
---

Do not report a second `change` for one write, a false `unlink`, or a file put back in the place of a directory, when a read of the file finishes late. A read that was in flight while the file was recorded as reported, or forgotten, is made again, whether it succeeded or failed and, with `followSymlinks: false`, including the read of the link target, so its older result no longer replaces the recorded size, mtime and target. A file that was missing at its read in a directory scan is looked at once more before it is reported as removed, as it may be back by the time the other names of the directory have been read.
