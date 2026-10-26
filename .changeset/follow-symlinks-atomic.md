---
"zygiella": minor
---

Add the `followSymlinks` and `atomic` options, both on by default as in chokidar.

- A symbolic link to a directory used to be reported as `addDir` and never descended into. It is now descended into, and files below it are reported under the link's path (a link to a directory already on the way down, such as a link back to an ancestor, is still not descended into). Pass `followSymlinks: false` to watch a link as itself: it is reported as `add`, and pointing it somewhere else is reported as `change`.
- The `unlink` of a file that is deleted by itself is now reported 100 ms late (the files below a removed directory and `unlinkDir` are still reported at once). A file deleted and created again within that time (how vim saves) is reported as one `change` instead of `unlink` then `add`. Pass `atomic: false` for the old timing, or a number for another window in ms. While `atomic` is on, editor temporary files (`.swp`, `.swx`, a trailing `~`, Sublime's `.subl*.tmp`) are ignored.
