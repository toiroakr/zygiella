---
"zygiella": patch
---

Report a file that is created right after a watched path that did not exist yet appears. `watch("/work/later")` with `/work/later` created and `/work/later/a.txt` written at once reported `addDir` but sometimes never `add` (about 5 in 1000 on a loaded macOS machine), because the native watch of the new directory is attached before the first read of it, but the OS only starts delivering a little later, so a file made in between is neither in that listing nor announced. The directory is now read once more 50 ms after its first read, as `ready` already waits 50 ms.
