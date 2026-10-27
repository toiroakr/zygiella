# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`zygiella` is a dependency-free file watcher for Node.js built on `fs.watch`. It implements the subset of the
chokidar API that most tools use: `watch(paths, options)`, the `FSWatcher` events (`add`, `addDir`, `change`,
`unlink`, `unlinkDir`, `all`, `ready`, `error`) and methods (`add`, `unwatch`, `rescan`, `close`), and the options
`ignored`, `ignoreInitial`, `depth`, `followSymlinks`, `atomic`, `awaitWriteFinish`, `persistent` and `ignorePermissionErrors`. Do
not add the rest of chokidar's surface (globs, polling, `cwd`, `stats`); being small is the point. `rescan()` is not polling: it runs only when the user calls
it, so an interval is the user's to write.

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

The whole library is `src/index.ts`; the tests are `test/watch.test.ts` and run against the real file system.

- Each directory that is descended into has its own `fs.watch`. Native events are not trusted for their type or
  file name: every event re-reads the directory and diffs it against a snapshot (`#entries`), and the diff
  produces the reports. This absorbs coalesced and duplicated events on every platform.
- `Mode` decides whether a diff reports: `quiet` (remember only, for `ignoreInitial`), `initial` (report at
  once, it is what `ready` waits for) and `live` (report after a quiet period, see below).
- `add` and `change` reports wait for 50 ms of quiet per file, because Linux splits a write into truncate and
  write. With `awaitWriteFinish` they wait for a stable size and mtime instead.
- `ready` waits 50 ms after the watchers are attached, because `fs.watch` returns before FSEvents on macOS
  delivers. A test that makes a change right after `ready` covers this; do not shorten the wait without it.
- A link to a directory is descended into unless `followSymlinks` is false. `#ancestry` keeps the real paths of the
  directories from the root down to each directory, and a link whose real path is already there is reported but not
  descended into, because a link back to an ancestor would loop forever. With `followSymlinks: false` a link is an
  entry of its own, compared by its `lstat` data and `readlink` target.
- A directory whose `fs.watch` threw (`ENOSPC`, `EMFILE`) or whose native watcher reported an error and could not be
  set up again is kept in `#unwatched` (public: `unwatched`) and reported as `error`. It is still read once, so what exists at that moment
  is reported; later changes are missed. `rescan()` reaches `#ensureNative` for every directory, so it is also what watches it again;
  there is no timer, because retrying on an interval is the caller's `setInterval`, as with `rescan()` itself.
- `snapshot()` serializes `#entries` (absolute paths, `{ version: 1, entries }`); `since` seeds `#entries` and
  `#children` in the constructor, before the first scan, for the roots given to `watch()` only. Entries outside the
  roots, deeper than `depth`, ignored by path, or below an ignored directory are dropped. The ordinary scan then does
  the diff in the `seed` mode, which `since` (even `null` or an unusable one) selects, so it overrides `ignoreInitial`.
  `seed` is `initial` that also reports `change` and `unlink` at once, because they must come before `ready`; `add()`
  keeps its own mode (`quiet` with `ignoreInitial`, else `initial`), where a `change` is still announced after the quiet
  period (or `awaitWriteFinish`) and an `unlink` is still held for `atomic`. A `Settling` job for a change keeps `before`, the entry
  that was last reported, and a held unlink in `#unlinks` keeps its entry; `snapshot()` (and `close()`, which restores
  them) records those, so a change or unlink that was never reported is reported by the next run. A path whose `add`
  is still waiting is left out. Seeding keeps an entry only if its parent is a kept directory, so no entry sits below one that is
  missing, and a scan that is still reading when `close()` is called adds nothing to the baseline (`#visit` returns once
  closed, also after an `unlink` listener closed it, and so do the removal in `#syncDir` and the loop in `#remove`, which leaves the entries it did not reach). A held unlink keeps
  `job.before` when the file had a change waiting. A root whose `stat` fails for a reason other than
  ENOENT/ENOTDIR (permission) keeps its seeded baseline in `seed` mode instead of reporting it as removed.
- With `atomic`, the unlink of a file is held back in `#unlinks` for the window, and an `add` announced for the same
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
