---
"zygiella": patch
---

In a directory with more than 1000 entries, inspect only the entry that `fs.watch` names instead of reading the whole directory on every event. A change in a directory of 30,000 files took 0.2 to 1 s to be reported because every event re-read it; the directory is read whole once, 1 s after its last event, so an entry whose event was lost is still reported.
