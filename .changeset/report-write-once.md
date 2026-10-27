---
"zygiella": patch
---

Report one `change` for one write even when the native event for the finished write arrives after the quiet period. The file is read again when the quiet period ends and its size and mtime are recorded as reported, so a late event for a write that was already included no longer reports a second `change`.
