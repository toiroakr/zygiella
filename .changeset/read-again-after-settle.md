---
"zygiella": patch
---

Do not report a second `change` for one write, or a false `unlink`, when a directory read that saw the file half written or missing finishes after the quiet period has already reported it. A read that was in flight while the file was recorded as reported is made again, whether it succeeded or failed and, with `followSymlinks: false`, including the read of the link target, so its older result no longer replaces the recorded size, mtime and target.
