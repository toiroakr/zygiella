---
"zygiella": patch
---

Lower the memory a scan needs further by sizing the budget of entries read at once on each level of nesting from the thread pool instead of fixing it at 256: 4 times `UV_THREADPOOL_SIZE`, but at least 16 and at most 256 (so 16 unless the pool is larger than 4). The thread pool runs only that many calls at a time, so a deeper queue only holds memory: on a tree of 20,000 files the resident set grows by about 20% less than with 256, up to 45% less on Linux for one wide directory (41 to 22 MB), and `ready` is not later. The events reported do not change.
