---
name: survey-watchers
description: Before designing or planning any change to how zygiella watches, reports, recovers or fails, check how the well-known file watchers (chokidar, notify, fsnotify, watchdog, @parcel/watcher, Watchman, libuv) solve the same problem, from their source and docs, and write the findings down. Use at the start of planning for an issue or feature, before the design is chosen.
---

# Survey how other file watchers solve it

zygiella is a small chokidar-compatible watcher, so a design chosen without looking at the others tends to
miss a known pitfall or invent an API nobody else needs. Do this survey **before** choosing a design, and put
the result in the plan and later in the PR body.

## 1. State the problem in one line

Name the situation, not the solution. Example: "`fs.watch` fails with ENOSPC for one directory of a tree" or "the
kernel queue overflows and events are lost". Without this, the survey drifts.

## 2. Read the primary source of each watcher

Read code and docs, not blog posts or memory. Use `gh api repos/<owner>/<repo>/contents/<path> --jq .content | base64 -d`
(the tree: `gh api "repos/<owner>/<repo>/git/trees/HEAD?recursive=1" --jq '.tree[].path'`; quote the URL, zsh
treats `?` as a glob). Grep for the error codes and the words for the problem (`ENOSPC`, `EMFILE`, `overflow`,
`rescan`, `fallback`, `poll`, `retry`).

| Watcher                                    | Language   | Where to look                                                                                                          |
| ------------------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| chokidar (`paulmillr/chokidar`)            | TypeScript | `src/backend.ts`, `src/reconcile.ts`, `docs/architecture.md`, README "Troubleshooting". It is the API zygiella copies. |
| notify (`notify-rs/notify`)                | Rust       | `notify/src/inotify.rs`, `fsevent.rs`, `windows.rs`, `error.rs`, `lib.rs` (`Flag::Rescan`, `ErrorKind`)                |
| fsnotify (`fsnotify/fsnotify`)             | Go         | `fsnotify.go` (errors), `backend_inotify.go`, `backend_kqueue.go`, README FAQ                                          |
| watchdog (`gorakhargosh/watchdog`)         | Python     | `src/watchdog/observers/`, polling and inotify emitters                                                                |
| @parcel/watcher (`parcel-bundler/watcher`) | C++        | backends and the fallback order, snapshot / `getEventsSince`                                                           |
| Watchman (`facebook/watchman`)             | C++        | recrawl and `fresh_instance` handling                                                                                  |
| libuv (`libuv/libuv`)                      | C          | `src/unix/linux.c`, `src/unix/fsevents.c`: what Node's `fs.watch` can and cannot tell us                               |

chokidar and @parcel/watcher are always read: chokidar is the API zygiella copies, and @parcel/watcher is the other
one that is widely used from Node. Also take notify and fsnotify. Add the others when the problem touches them (a
snapshot or recrawl question: Watchman; what Node can report at all: libuv; a polling or timer question: watchdog).
Deciding that a watcher does not touch the problem is not a reason to skip it when the problem is about a timer, a
fallback or lost events; read it and write down that it has no answer. A watcher that is not read is listed as not
read with the reason, and is never filled in from memory.

## 3. Write the findings as a table

For each watcher: what it does for the situation, and the file or doc it is read from. Then three lines:

- **What most of them do** (the common answer).
- **What only some do, and why** (polling fallback, retry count, a dedicated "events may be lost" signal).
- **What zygiella cannot copy**, with the reason from its constraints: no polling of its own, no widening of the
  chokidar surface (CLAUDE.md), and what `fs.watch` in Node gives (no overflow signal, no per-event type guarantee).

## 4. Use it in the design

The design states which of the common answers it follows and, for anything new (a new public member, a new
event), why the existing answers were not enough. A design that adds an API no surveyed watcher has needs that
reason in the PR body.

## Output

The survey table and the three lines above, in the plan; the same, shortened, under a heading in the PR body.
