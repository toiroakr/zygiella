---
"zygiella": patch
---

In a directory with more than 1000 entries, inspect only the entry that `fs.watch` names instead of reading the whole directory on every event. A change in a directory of 30,000 files took 0.2 to 1 s to be reported because every event re-read it; a missed event in such a directory is now repaired by `rescan()` rather than by the next event.
