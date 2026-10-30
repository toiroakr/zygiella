---
"zygiella": patch
---

Report `add` and `change` as soon as the file is known to have content, instead of 50 ms after its last event. Creating 500 files in one directory used to report the first `add` after 0.5 to 1.2 s on a tree of 20,000 files, because a re-read of the directory that saw a file still being written started its 50 ms wait again.

- An `add` or `change` of a file that is not empty is reported at once. A file that is still empty is held for 10 ms for its data (Linux reports a truncate before the write), and is reported at once if a native event for it arrives in that time.
- A path reported less than 50 ms ago waits for 50 ms of quiet before its next report, so a write that arrives as several events can now be reported as two `change` events (the first at once, the second at the end of the burst) where it used to be one.
- The first `add` of a file waits for the directory reads that are going on at that moment, so that a file moved within a directory or to another one (`a.txt` to `b.txt`) still reports `add` of `b.txt` with `renamedFrom: "a.txt"`. In a directory of more than 1000 entries, whose entries are read one by one, the `add` does not wait: if the removal is read after the `add` was reported, the `add` carries no `renamedFrom`, which the 50 ms wait used to leave room for.
- `awaitWriteFinish` and `atomic` are unchanged.
