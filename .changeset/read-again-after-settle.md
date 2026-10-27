---
"zygiella": patch
---

Do not report a second `change` for one write when a directory read that saw the file half written finishes after the quiet period has already reported it. A read that was in flight while the file was recorded as reported is made again, so its older result no longer replaces the recorded size and mtime.
