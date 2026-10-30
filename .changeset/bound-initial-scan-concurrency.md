---
"zygiella": patch
---

Lower the memory a watcher needs to read a large directory, which is most of what its first scan costs. Reading a directory used to start one task for every entry of it at once, so watching a tree of 20,000 files grew the resident set by 145 to 164 MB on macOS and about 200 MB on Linux, and Node with `--max-old-space-size=64` ran out of memory while scanning. Reading a directory now hands its entries to workers that share a budget of 256 on each level of nesting, as readdirp (the directory walker of chokidar) does with its batches of 256, and the same tree grows it by 17 to 39 MB. The events reported do not change, and on CI the time until `ready` was shorter or within the noise of the runners in every tree shape measured.
