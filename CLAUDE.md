# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`zygiella` is a dependency-free file watcher for Node.js built on `fs.watch`. It implements the subset of the
chokidar API that most tools use: `watch(paths, options)`, the `FSWatcher` events (`add`, `addDir`, `change`,
`unlink`, `unlinkDir`, `all`, `ready`, `error`) and methods (`add`, `unwatch`, `rescan`, `close`), and the options
`ignored`, `ignoreInitial`, `depth`, `followSymlinks`, `atomic`, `awaitWriteFinish`, `persistent`, `rescanInterval` and `ignorePermissionErrors`. Do
not add the rest of chokidar's surface (globs, polling, `cwd`, `stats`); being small is the point. `rescan()` is not polling, and `rescanInterval` only calls it on a timer:
`fs.watch` stays in place, unlike chokidar's `backend: 'polling'`, which replaces it.

## Planning

Before choosing a design for any change to how zygiella watches, reports, recovers or fails, run the
`survey-watchers` skill (`.claude/skills/survey-watchers/SKILL.md`): check in their source how chokidar, notify,
fsnotify and the other well-known watchers solve the same problem, and write that into the plan and the PR body.
Do it first, not after the design is settled.

## Common Development Commands

This repository uses **pnpm** (pinned via the `packageManager` field). Do not use npm or yarn.

```bash
pnpm build           # Build with tsdown (ESM and types into dist/)
pnpm test            # Run tests once with Vitest
pnpm typecheck       # tsc --noEmit
pnpm lint            # oxlint
pnpm format          # oxfmt (format:check to verify only)
pnpm knip            # Unused files, exports and dependencies
pnpm publint         # Check the published package shape
pnpm changeset       # Record a changeset describing your change
```

CI runs the tests on Linux, macOS and Windows with Node.js 22.18 and 24. Keep the code and the tests working on
all three.

## Architecture

`src/index.ts` holds `watch()`, which keeps the state of one watcher in a closure and returns an `EventEmitter` (`FSWatcher` is
only a type). The parts that own their own state or have none are in their own files: `match.ts` (the `ignored` matcher, no
state), `snapshot.ts` (validating and seeding a snapshot, no state), `options.ts` (the defaults and validation of the options, no state), `native.ts` (the `fs.watch` handles and the unwatched
set), `pending.ts` (add / change waiting to settle and unlinks held for `atomic`) and `types.ts`. The tests in `test/` run against the real file system.

- Each directory that is descended into has its own `fs.watch`, except on macOS, where `natives.ensureTree` watches a
  root and everything below it with one `recursive: true` watch (not with a finite `depth`). `covers` says whether a
  tree watch reports a directory, and `physical` in `index.ts` whether it can: a directory behind a followed link is
  not under the tree physically, so it keeps its own watch. A tree watch that is not available or fails to open
  falls back to one watch per directory. Native events are not trusted for their type: every event (except in a large directory, below) re-reads the
  directory and diffs it against a snapshot (`entries`), and the diff produces the reports. This absorbs coalesced
  and duplicated events on every platform. Only in a directory with more than `LARGE_DIRECTORY` entries is the name
  of the event trusted (`syncName`), because the full read costs 0.2 to 1 s there; `audit` reads that directory whole
  once `AUDIT_QUIET_MS` after its last event (through `onNative` without a name, so dependent file roots and
  missing-path probes are synced too), which repairs an event the OS lost when others of that directory arrived.
  `isLarge` counts tracked entries, so entries under `ignored` do not count. A full read and a named read of one
  directory run in different queues; `scanning` makes the full read keep what a named read recorded meanwhile.
- A native watcher error is retried by one re-sync of its directory, except `EMFILE` / `ENOSPC` and the fourth error
  in a row without an event (`native.ts`); a re-watch after `EMFILE` on macOS made libuv rebuild its one stream for
  every handle, and the process never reached `ready`.
- `Mode` decides whether a diff reports: `quiet` (remember only, for `ignoreInitial`), `initial` (report at
  once, it is what `ready` waits for) and `live` (report after a quiet period, see below).
- `add` and `change` reports wait for 50 ms of quiet per file, because Linux splits a write into truncate and
  write. With `awaitWriteFinish` they wait for a stable size and mtime instead.
- `ready` waits 50 ms after the watchers are attached, because `fs.watch` returns before FSEvents on macOS
  delivers. A test that makes a change right after `ready` covers this; do not shorten the wait without it.
- A link to a directory is descended into unless `followSymlinks` is false. `ancestries` keeps the real paths of the
  directories from the root down to each directory, and a link whose real path is already there is reported but not
  descended into, because a link back to an ancestor would loop forever. With `followSymlinks: false` a link is an
  entry of its own, compared by its `lstat` data and `readlink` target.
- A directory whose `fs.watch` threw (`ENOSPC`, `EMFILE`) or whose native watcher reported an error and could not be
  set up again is kept in the unwatched set of `native.ts` (public: `unwatched`) and reported as `error`. It is still read once, so what exists at that moment
  is reported; later changes are missed. `rescan()` reaches `natives.ensure` for every directory, so it is also what watches it again;
  the timer is `rescanInterval`, off by default. It reads the whole tree, not only the unwatched set, because on NFS and Docker
  bind mounts `fs.watch` succeeds and stays silent, so nothing is ever in it.
- `rescanInterval` chains `setTimeout` from `ready`: the next one is set when `rescan()` has finished, so a slow tree is
  not read back to back. It goes through `timeout` (unref'd with `persistent: false`) and `close()` clears it.
- `snapshot()` serializes `entries` (absolute paths, `{ version: 1, entries }`); `since` seeds `entries` and
  `children` when `watch()` starts, before the first scan, for the roots given to `watch()` only. Entries outside the
  roots, deeper than `depth`, ignored by path, or below an ignored directory are dropped. The ordinary scan then does
  the diff in the `seed` mode, which `since` (even `null` or an unusable one) selects, so it overrides `ignoreInitial`.
  `seed` is `initial` that also reports `change` and `unlink` at once, because they must come before `ready`; `add()`
  keeps its own mode (`quiet` with `ignoreInitial`, else `initial`), where a `change` is still announced after the quiet
  period (or `awaitWriteFinish`) and an `unlink` is still held for `atomic`. A `Settling` job for a change keeps `before`, the entry
  that was last reported, and a held unlink in `unlinks` (`pending.ts`) keeps its entry; `snapshot()` (and `close()`, which restores
  them) records those, so a change or unlink that was never reported is reported by the next run. A path whose `add`
  is still waiting is left out. Seeding keeps an entry only if its parent is a kept directory, so no entry sits below one that is
  missing, and a scan that is still reading when `close()` is called adds nothing to the baseline (`visit` returns once
  closed, also after an `unlink` listener closed it, and so do the removal in `syncDir` and the loop in `remove`, which leaves the entries it did not reach). A held unlink keeps
  `job.before` when the file had a change waiting. A root whose `stat` fails for a reason other than
  ENOENT/ENOTDIR (permission) keeps what is below it in any mode, instead of reporting it as removed, so `rescan()`
  does not turn a still unreadable root into `unlink` for every seeded entry. In `seed` mode, `forgetBelow` drops what was seeded below a link back to an ancestor (never descended into), except what a watched root at or
  below that path covers (and the directories above that root), and only when the link already pointed there when the snapshot
  was taken (a retargeted link is reported by `visit`, with what was below it), so no entry stays that no scan can reach; a directory that was merely not read (`depth`, a
  permission error) keeps its baseline. The `awaitWriteFinish` poll writes the final stable `stat` (and, with `followSymlinks: false`, the `readlink`) into the entry before it dispatches, so a
  write that settles after the last scan is what the snapshot records (nothing else reads it again where native events are silent).
- With `atomic`, the unlink of a file is held back in `unlinks` (`pending.ts`) for the window, and an `add` announced for the same
  path in that time becomes a `change`. A removed directory reports what is below it at once, flushing held unlinks
  first. `atomic` also adds the editor temporary file patterns to `ignored`.

## Testing

- Tests wait for a condition with the `until` helper, never a fixed sleep, because event latency differs per
  platform.
- Deleting a watched directory can fail for a moment on Windows, so the tests remove with retries.
- When a test is flaky, find the lost or duplicated event instead of widening a timeout.

## Release

Releases go through changesets and `.github/workflows/release.yml`, which publishes with npm provenance
through a trusted publisher (no npm token is stored). Add a changeset with `pnpm changeset` for any change a
user can see.
