# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`zygiella` is a dependency-free file watcher for Node.js built on `fs.watch`. It implements the subset of the
chokidar API that most tools use: `watch(paths, options)`, the `FSWatcher` events (`add`, `addDir`, `change`,
`unlink`, `unlinkDir`, `all`, `ready`, `error`) and methods (`add`, `unwatch`, `close`), and the options
`ignored`, `ignoreInitial`, `depth` and `awaitWriteFinish`. Do not add the rest of chokidar's surface (globs,
polling, `cwd`, `stats`); being small is the point.

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
- Symbolic links are reported but not descended into, because a link back to an ancestor would loop forever.

## Testing

- Tests wait for a condition with the `until` helper, never a fixed sleep, because event latency differs per
  platform.
- Deleting a watched directory can fail for a moment on Windows, so the tests remove with retries.
- When a test is flaky, find the lost or duplicated event instead of widening a timeout.

## Release

Releases go through changesets and `.github/workflows/release.yml`, which publishes with npm provenance
through a trusted publisher (no npm token is stored). Add a changeset with `pnpm changeset` for any change a
user can see.
