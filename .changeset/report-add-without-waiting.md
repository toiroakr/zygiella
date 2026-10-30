---
"zygiella": patch
---

Report `add` and `change` as soon as the file is known to have content, instead of 50 ms after its last event. Creating 500 files in one directory used to report the first `add` after 0.5 to 1.2 s on a tree of 20,000 files, because a re-read of the directory that saw a file still being written started its 50 ms wait again.

- The first report of an `add` or `change` of a file that is not empty is made at once. A file that is still empty is held for 10 ms for its data (Linux reports a truncate before the write), and is reported at once if a native event for it arrives in that time.
- A write that arrives as several events is now reported as two events: `add` (or `change`) at once with the content so far, then `change` at the end of the burst. A file that is written in two steps 30 ms apart, `"x"` and then 1000 more bytes, used to be reported as one `add` that already had 1001 bytes; it is now an `add` at 1 byte and a `change` at 1001 bytes. A listener that reads the file on `add` and needs all of it should use `awaitWriteFinish`.
- The first `add` of a file waits for the directory reads that are going on at that moment, but for 50 ms at most, so that a file moved within a directory (`a.txt` to `b.txt`) still reports `add` of `b.txt` with `renamedFrom: "a.txt"`. A move to another directory is paired only if the read of the directory of the old path has started by then, and it is not when the two events arrive apart. In a directory of more than 1000 entries, whose entries are read one by one, the `add` does not wait: if the removal is read after the `add` was reported, the `add` carries no `renamedFrom`, which the 50 ms wait used to leave room for.
- `awaitWriteFinish` and `atomic` are unchanged.
