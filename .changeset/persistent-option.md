---
"zygiella": minor
---

Add the `persistent` option. With `persistent: false` the watcher no longer keeps the process alive: the `fs.watch` handles and the internal timers (the quiet period, `awaitWriteFinish` polling, the `atomic` hold) are unref'd, so `watch(dir, { persistent: false })` left unclosed lets a script exit by itself. The default stays `true`, as before.
