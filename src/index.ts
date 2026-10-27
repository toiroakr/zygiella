import { EventEmitter } from "node:events";
import type { Stats } from "node:fs";
import { lstat, readdir, readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { pendingEvents } from "./pending.ts";
import { DENIED, VANISHED, nativeWatches, nearestDirectory } from "./native.ts";
import { recorded, seedEntries, toSnapshot } from "./snapshot.ts";
import { list, within } from "./match.ts";
import { resolveOptions } from "./options.ts";
import type {
  Entry,
  Events,
  ReadyResult,
  Snapshot,
  SnapshotEntry,
  WatchEvent,
  WatchOptions,
} from "./types.ts";

export type {
  Ignored,
  ReadyResult,
  Snapshot,
  SnapshotEntry,
  WatchEvent,
  WatchOptions,
} from "./types.ts";

const READY_SETTLE_MS = 50;
const differs = (previous: Entry, next: Entry): boolean =>
  previous.mtimeMs !== next.mtimeMs ||
  previous.size !== next.size ||
  previous.ino !== next.ino ||
  previous.link !== next.link;
const isTrue = (): boolean => true;
const isFalse = (): boolean => false;

/**
 * quiet: remember only. initial: report at once (it is what `ready` waits for). seed: initial against a snapshot, so
 * `change` and `unlink` come at once too. live: report once the burst of events is over.
 */
type Mode = "quiet" | "initial" | "seed" | "live";

/**
 * What `watch()` returns: an `EventEmitter` with the events of `WatchEvent`, `all`, `ready` and `error`.
 */
export interface FSWatcher extends EventEmitter<Events> {
  /**
   * Resolves once the paths last given to `watch()` or `add()` are being watched, so a change made right after it
   * is reported. It resolves to the paths of that call that did not exist. The `ready` event is emitted for the
   * paths given to `watch()` only.
   */
  readonly ready: Promise<ReadyResult>;
  /**
   * Directories that are read but have no native watch, because `fs.watch` threw (`ENOSPC`, `EMFILE`) or the
   * watcher reported an error. Changes below them are missed until `rescan()` reads them, and it also tries to
   * watch them again.
   */
  readonly unwatched: readonly string[];
  /**
   * The state to start the next run from (`since`): what has been reported so far. A file whose `add` is still
   * waiting is left out, so the next run reports it; a `change` that is waiting, or an `unlink` held back for
   * `atomic`, is recorded as it was before, so the next run reports that too.
   */
  snapshot(): Snapshot;
  add(paths: string | readonly string[]): this;
  unwatch(paths: string | readonly string[]): this;
  /**
   * Reads every watched root and every directory descended into again, and reports what differs from the last
   * time. Resolves once that is read; add / change are reported after their usual wait.
   */
  rescan(): Promise<void>;
  close(): Promise<void>;
}

export function watch(paths: string | readonly string[], options: WatchOptions = {}): FSWatcher {
  const emitter = new EventEmitter<Events>();
  const {
    ignored,
    atomicMs,
    ignoreInitial,
    maxDepth,
    followSymlinks,
    ignorePermissionErrors,
    persistent,
    rescanInterval,
    settle,
  } = resolveOptions(options);

  const watchedRoots = new Set<string>();
  const kinds = new Map<string, "dir" | "file" | "missing">();
  const probes = new Map<string, string>();
  const entries = new Map<string, Entry>();
  const children = new Map<string, Set<string>>();
  const depthLeft = new Map<string, number>();
  /** Real paths of the directories from the watched root down to each directory, the directory's own last. */
  const ancestries = new Map<string, readonly string[]>();
  const queues = new Map<string, { dirty: boolean; done: Promise<void> }>();
  const denied = new Set<string>();
  const missingAtStart = new Set<string>();
  const settles = new Map<string, number>();
  let rescanTimer: NodeJS.Timeout | undefined;
  let closed = false;
  let ready: Promise<ReadyResult>;

  const natives = nativeWatches({ persistent, needed, onChange: onNative, onError: fail });
  const pending = pendingEvents({
    atomic: atomicMs,
    settle,
    followSymlinks,
    timeout,
    dispatch,
    stat: followStat,
    settled,
  });

  /**
   * The state to start the next run from (`since`): what has been reported so far. A file whose `add` is still
   * waiting is left out, so the next run reports it; a `change` that is waiting, or an `unlink` held back for
   * `atomic`, is recorded as it was before, so the next run reports that too.
   */
  function snapshot(): Snapshot {
    const recordedEntries: SnapshotEntry[] = [];
    for (const [path, current] of entries) {
      const before = pending.baseline(path, current);
      if (before) recordedEntries.push(recorded(path, before));
    }
    for (const [path, entry] of pending.heldEntries()) recordedEntries.push(recorded(path, entry));
    return toSnapshot(recordedEntries);
  }

  /** The file settled at this size and mtime: the entry may not know yet, as no native event reads it again. */
  function settled(path: string, info: Stats, link: string | undefined): void {
    const entry = entries.get(path);
    if (entry && !entry.dir) {
      settles.set(path, (settles.get(path) ?? 0) + 1);
      entries.set(path, {
        ...entry,
        mtimeMs: info.mtimeMs,
        size: info.size,
        ino: info.ino,
        link: info.isSymbolicLink() ? (link ?? entry.link) : undefined,
      });
    }
  }

  /**
   * Reads again when `settled` recorded the path meanwhile: the result may be older than the entry and would put it back.
   * Dropping it instead could lose a newer state whose native event was merged into the one that started this read.
   */
  async function unsettled<T>(path: string, read: () => Promise<T>): Promise<T> {
    for (;;) {
      const before = settles.get(path);
      let result: T;
      try {
        result = await read();
      } catch (error) {
        if (settles.get(path) === before) throw error;
        continue;
      }
      if (settles.get(path) === before) return result;
    }
  }

  /** Remembers what `since` holds for the watched roots, so the first scan reports only the difference. */
  function seed(since: Snapshot | null | undefined, roots: string[]): void {
    for (const { path, dir, mtimeMs, size, ino, link } of seedEntries(
      since,
      roots,
      maxDepth,
      ignored.byPath,
    ))
      setEntry(path, { dir, mtimeMs, size, ino, link });
  }

  function add(paths: string | readonly string[]): FSWatcher {
    ready = begin(list(paths));
    return watcher;
  }

  function unwatch(paths: string | readonly string[]): FSWatcher {
    for (const path of list(paths)) forget(path);
    return watcher;
  }

  function forget(path: string): void {
    watchedRoots.delete(path);
    missingAtStart.delete(path);
    for (const key of denied) if (within(path, key)) denied.delete(key);
    kinds.delete(path);
    const probe = probes.get(path);
    probes.delete(path);
    remove(path, false, (key) => ![...watchedRoots].some((root) => within(root, key)));
    if (probe) natives.release(probe);
    // a directory whose watch failed has no entry, so remove never released it
    for (const key of natives.unwatched()) if (within(path, key)) natives.release(key);
    const parent = dirname(path);
    if (parent !== path) natives.release(parent);
  }

  /**
   * Reads every watched root and every directory descended into again, and reports what differs from the last
   * time. Resolves once that is read; add / change are reported after their usual wait.
   */
  async function rescan(): Promise<void> {
    if (closed) return;
    // a call made while a rescan runs makes it run once more afterwards, so two rescans never read at the same time
    await serial("rescan", () => rescanOnce());
  }

  async function rescanOnce(): Promise<void> {
    await Promise.all(
      [...watchedRoots].map((root) => serial(`root:${root}`, () => syncRoot(root, "live"))),
    );
    // a read can drop a directory or change what lies below it, so shallow directories go first and each one is
    // looked up again when its turn comes
    const levels = new Map<number, string[]>();
    for (const dir of depthLeft.keys()) {
      const depth = dir.split(sep).length;
      const level = levels.get(depth);
      if (level) level.push(dir);
      else levels.set(depth, [dir]);
    }
    for (const depth of [...levels.keys()].sort((a, b) => a - b)) {
      await Promise.all(
        levels.get(depth)!.map((dir) => {
          const left = depthLeft.get(dir);
          const ancestry = ancestries.get(dir);
          return left !== undefined && ancestry && !watchedRoots.has(dir)
            ? serial(`dir:${dir}`, () => syncDir(dir, left, "live", ancestry))
            : undefined;
        }),
      );
    }
  }

  async function close(): Promise<void> {
    closed = true;
    clearTimeout(rescanTimer);
    pending.close(entries);
    natives.close();
    await Promise.all([...queues.values()].map((q) => q.done));
  }

  function scheduleRescan(): void {
    if (closed || rescanInterval === 0) return;
    rescanTimer = timeout(() => {
      void watcher.rescan().finally(() => scheduleRescan());
    }, rescanInterval);
  }

  function timeout(fn: () => void, ms: number): NodeJS.Timeout {
    const timer = setTimeout(fn, ms);
    if (!persistent) timer.unref();
    return timer;
  }

  async function begin(roots: string[], since = false): Promise<ReadyResult> {
    await start(roots, since ? "seed" : ignoreInitial ? "quiet" : "initial");
    const missing = [...new Set(roots)].filter((root) => missingAtStart.has(root));
    // not unref'd: a caller awaiting `ready` would otherwise see the process exit before it resolves (exit code 13)
    // fs.watch returns before the OS starts delivering (FSEvents on macOS): a change made in that gap is never reported
    await new Promise<void>((done) => setTimeout(done, READY_SETTLE_MS));
    return { missing };
  }

  function start(roots: string[], mode: Mode): Promise<void> {
    for (const root of roots) watchedRoots.add(root);
    return Promise.all(
      roots.map((root) => serial(`root:${root}`, () => syncRoot(root, mode))),
    ).then(() => undefined);
  }

  /** Runs `fn` for `key` one at a time; a request made while it runs makes it run once more afterwards. */
  function serial(key: string, fn: () => Promise<void>): Promise<void> {
    const running = queues.get(key);
    if (running) {
      running.dirty = true;
      return running.done;
    }
    const queue = { dirty: false, done: Promise.resolve() };
    queues.set(key, queue);
    queue.done = (async () => {
      try {
        do {
          queue.dirty = false;
          await fn().catch((error: NodeJS.ErrnoException) => fail(error, key));
        } while (queue.dirty && !closed);
      } finally {
        queues.delete(key);
      }
    })();
    return queue.done;
  }

  async function syncRoot(root: string, mode: Mode): Promise<void> {
    if (closed || !watchedRoots.has(root)) return;
    if (ignored.byPath(root)) return;
    const previousProbe = probes.get(root);
    const previousParent = kinds.get(root) === "file" ? dirname(root) : undefined;
    if (mode !== "live") missingAtStart.delete(root);
    const { info, link, unreadable } = await statRoot(root, mode);
    if (closed || !watchedRoots.has(root)) return;
    if (info && !info.isDirectory()) denied.delete(root);

    if (!info) {
      await watchMissing(root, mode, unreadable, previousProbe);
      if (previousParent) natives.release(previousParent);
      // the root may have been created between the stat above and the watch being attached
      if (await followStat(root).then(isTrue, isFalse)) await syncRoot(root, "live");
      return;
    }

    if (!entries.has(root) && ignored.byStats?.(root, info)) watchSkipped(root, info);
    else await scanRoot(root, info, link, mode);
    if (previousProbe) natives.release(previousProbe);
    if (previousParent) natives.release(previousParent);
  }

  /** A root skipped by its stats is watched all the same, so that it is read again when its stats may have changed. */
  function watchSkipped(root: string, info: Stats): void {
    kinds.set(root, info.isDirectory() ? "dir" : "file");
    // a directory has no entry to keep its watch while it is skipped, so the probe does, and unwatch() releases it
    if (info.isDirectory()) probes.set(root, root);
    else probes.delete(root);
    natives.ensure(info.isDirectory() ? root : dirname(root));
  }

  async function scanRoot(
    root: string,
    info: Stats,
    link: string | undefined,
    mode: Mode,
  ): Promise<void> {
    probes.delete(root);
    if (!info.isDirectory()) {
      kinds.set(root, "file");
      natives.ensure(dirname(root));
      await visit(root, info, 0, mode, [], link);
      return;
    }
    kinds.set(root, "dir");
    natives.ensure(root);
    const real = await realpath(root).catch(() => root);
    await visit(root, info, 0, mode, [], real);
    await syncDir(root, maxDepth, mode, [real]);
  }

  async function statRoot(
    root: string,
    mode: Mode,
  ): Promise<{ info: Stats | undefined; link: string | undefined; unreadable: boolean }> {
    let unreadable = false;
    const read = await unsettled(root, async () => {
      const info = await followStat(root);
      const link =
        !followSymlinks && info.isSymbolicLink()
          ? await readlink(root).catch(() => undefined)
          : undefined;
      return { info, link };
    }).catch((error: NodeJS.ErrnoException) => {
      fail(error, root);
      unreadable = !VANISHED.has(error.code ?? "");
      if (mode !== "live" && VANISHED.has(error.code ?? "")) missingAtStart.add(root);
      return undefined;
    });
    const gone = !!read && !followSymlinks && read.info.isSymbolicLink() && read.link === undefined;
    return { info: gone ? undefined : read?.info, link: read?.link, unreadable };
  }

  /** Watches the nearest directory that exists, so that the root is seen when it is created. */
  async function watchMissing(
    root: string,
    mode: Mode,
    unreadable: boolean,
    previousProbe: string | undefined,
  ): Promise<void> {
    // a root that cannot be inspected is not known to be gone, and neither is what is below it
    if (!unreadable) remove(root, true, undefined, mode !== "seed");
    kinds.set(root, "missing");
    // a deeper folder may be created while the watcher is being attached, and would then never be seen
    let ancestor = await nearestDirectory(root);
    const attached = new Set<string>();
    for (;;) {
      probes.set(root, ancestor);
      natives.ensure(ancestor);
      attached.add(ancestor);
      const again = await nearestDirectory(root);
      if (again === ancestor) break;
      ancestor = again;
    }
    if (previousProbe) attached.add(previousProbe);
    attached.delete(ancestor);
    for (const stale of attached) natives.release(stale);
  }

  /**
   * Forgets what a snapshot put below a link back to an ancestor, which is never descended into: nothing would scan
   * it, so it would stay in the baseline after the file is gone. What a watched root at or below that path covers is
   * scanned through that root and keeps its entries, and so do the directories between that path and the root.
   */
  function forgetBelow(path: string): void {
    if (!children.get(path)?.size) return;
    remove(
      path,
      false,
      (key) =>
        key !== path &&
        ![...watchedRoots].some(
          (root) => within(path, root) && (within(root, key) || within(key, root)),
        ),
    );
  }

  function followStat(path: string): Promise<Stats> {
    return followSymlinks ? stat(path) : lstat(path);
  }

  async function syncDir(
    dir: string,
    left: number,
    mode: Mode,
    ancestry: readonly string[],
  ): Promise<void> {
    if (closed || ![...watchedRoots].some((root) => within(root, dir))) return;
    // attach the watcher before reading, so nothing that changes during the scan is lost
    depthLeft.set(dir, left);
    ancestries.set(dir, ancestry);
    natives.ensure(dir);
    const names = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
      fail(error, dir);
      return undefined;
    });
    if (!names || closed) return;
    denied.delete(dir);

    const seen = new Set<string>();
    const uninspectable = new Set<string>();
    const failed = (error: NodeJS.ErrnoException, path: string): undefined => {
      fail(error, path);
      if (!VANISHED.has(error.code ?? "")) uninspectable.add(path);
      return undefined;
    };
    await Promise.all(
      names.map(async (name) => {
        const path = join(dir, name);
        const found = await inspect(path, left, mode, ancestry, failed);
        if (!found) return;
        seen.add(path);
        await visit(
          path,
          found.info,
          found.descend,
          mode,
          [...ancestry, found.real],
          found.info.isDirectory() ? found.real : found.link,
        );
      }),
    );
    if (closed) return;
    for (const path of children.get(dir) ?? []) {
      if (!seen.has(path) && !uninspectable.has(path) && !watchedRoots.has(path))
        remove(path, true, undefined, mode !== "seed");
    }
    const listed = new Set(names);
    for (const path of denied) {
      if (dirname(path) === dir && !listed.has(basename(path))) denied.delete(path);
    }
  }

  interface Found {
    info: Stats;
    /** The real path of the entry, for a directory it is what `ancestry` records. */
    real: string;
    link: string | undefined;
    /** How many levels below it are descended into. */
    descend: number;
  }

  type Failed = (error: NodeJS.ErrnoException, path: string) => undefined;

  /** What a name in a directory is, or undefined when it is skipped (ignored, gone, unreadable). */
  async function inspect(
    path: string,
    left: number,
    mode: Mode,
    ancestry: readonly string[],
    failed: Failed,
  ): Promise<Found | undefined> {
    if (ignored.byPath(path)) return;
    const read = await unsettled(path, async () => {
      const own = await lstat(path);
      return {
        own,
        link: !followSymlinks && own.isSymbolicLink() ? await readlink(path) : undefined,
      };
    }).catch((error) => failed(error, path));
    if (!read) return;
    const { own } = read;
    let found: Found | undefined = {
      info: own,
      real: join(ancestry.at(-1)!, basename(path)),
      link: read.link,
      descend: left,
    };
    if (own.isSymbolicLink() && followSymlinks) {
      found = await followLink(path, found, mode, ancestry, failed);
      if (!found) return;
    }
    if (own.isSymbolicLink() || !found.info.isDirectory()) denied.delete(path);
    if (!entries.has(path) && ignored.byStats?.(path, found.info)) return;
    return found;
  }

  async function followLink(
    path: string,
    found: Found,
    mode: Mode,
    ancestry: readonly string[],
    failed: Failed,
  ): Promise<Found | undefined> {
    const info = await unsettled(path, () => stat(path)).catch((error) => failed(error, path));
    if (!info) return;
    if (!info.isDirectory()) return { ...found, info };
    const real = await realpath(path).catch((error) => failed(error, path));
    if (!real) return;
    // a link to a directory already on the way down would loop forever
    if (!ancestry.includes(real)) return { ...found, info, real };
    // a link that points somewhere else than before is reported by `visit`, with what was below it
    if (mode === "seed" && entries.get(path)?.link === real) forgetBelow(path);
    return { ...found, info, real, descend: 0 };
  }

  async function visit(
    path: string,
    info: Stats,
    left: number,
    mode: Mode,
    ancestry: readonly string[] = [],
    link?: string,
  ): Promise<void> {
    // a scan that was reading when close() was called must not add what was never reported to the baseline
    if (closed) return;
    const next: Entry = {
      dir: info.isDirectory(),
      mtimeMs: info.mtimeMs,
      size: info.size,
      ino: info.ino,
      link,
    };
    let previous = entries.get(path);
    if (previous && (previous.dir !== next.dir || (next.dir && previous.link !== next.link))) {
      remove(path, true);
      previous = undefined;
    }
    if (!previous) {
      await visitNew(path, next, left, mode, ancestry);
      return;
    }
    // a directory remembered from a snapshot has not been read yet
    if (next.dir && left > 0 && !depthLeft.has(path)) await syncDir(path, left - 1, mode, ancestry);
    if (!next.dir && differs(previous, next)) {
      setEntry(path, next);
      if (mode === "seed") dispatch("change", path);
      else if (mode !== "quiet") pending.announce("change", path, previous);
    }
  }

  async function visitNew(
    path: string,
    next: Entry,
    left: number,
    mode: Mode,
    ancestry: readonly string[],
  ): Promise<void> {
    if (next.dir) pending.flush(path);
    // an unlink listener may have closed the watcher: the entry would be in the baseline without being reported
    if (closed) return;
    setEntry(path, next);
    if (next.dir) {
      if (mode !== "quiet") dispatch("addDir", path);
      if (left > 0) await syncDir(path, left - 1, mode, ancestry);
    } else if (mode === "live" || pending.isHeld(path)) pending.announce("add", path);
    else if (mode !== "quiet") dispatch("add", path);
  }

  function setEntry(path: string, entry: Entry): void {
    entries.set(path, entry);
    const parent = dirname(path);
    let siblings = children.get(parent);
    if (!siblings) children.set(parent, (siblings = new Set()));
    siblings.add(path);
  }

  /**
   * Forgets `path` and everything below it, deepest first, optionally reporting each as unlink / unlinkDir.
   * With `defer`, the unlink of `path` itself is held back for the `atomic` window if it is a file.
   */
  function remove(
    path: string,
    report: boolean,
    only: (key: string) => boolean = () => true,
    defer = false,
  ): void {
    pending.dropHeld(path, only, report);
    const keys = [...entries.keys()].filter((key) => within(path, key) && only(key));
    keys.sort((a, b) => b.length - a.length);
    for (const key of keys) {
      // a listener closed the watcher: what is left was not reported, so it stays for the snapshot
      if (closed) break;
      const entry = entries.get(key)!;
      const job = pending.cancel(key);
      entries.delete(key);
      settles.delete(key);
      denied.delete(key);
      children.get(dirname(key))?.delete(key);
      children.delete(key);
      if (entry.dir) {
        depthLeft.delete(key);
        ancestries.delete(key);
        natives.release(key);
      }
      // an add that never settled was never reported, so there is nothing to take back
      if (!report || job?.event === "add") continue;
      if (entry.dir) dispatch("unlinkDir", key);
      else if (defer && pending.holdsUnlinks && key === path)
        pending.hold(key, job?.before ?? entry);
      else dispatch("unlink", key);
    }
  }

  function dispatch(event: WatchEvent, path: string): void {
    if (closed) return;
    // `emit` forwards the arguments as given, and the events map types them per event
    (emitter.emit as (event: string, ...args: unknown[]) => boolean)(event, path);
    if (!closed) emitter.emit("all", event, path);
  }

  /** A path that vanished is a race with whoever removed it. A permission error is reported once per path until the path reads again. */
  function fail(error: NodeJS.ErrnoException, path: string): void {
    const code = error.code ?? "";
    if (closed || VANISHED.has(code)) return;
    if (DENIED.has(code)) {
      if (ignorePermissionErrors || denied.has(path)) return;
      denied.add(path);
    }
    emitter.emit("error", error);
  }

  function needed(dir: string): boolean {
    return (
      depthLeft.has(dir) ||
      [...probes.values()].includes(dir) ||
      [...watchedRoots].some((root) => kinds.get(root) === "file" && dirname(root) === dir)
    );
  }

  function onNative(dir: string): void {
    if (closed) return;
    for (const root of watchedRoots) {
      const kind = kinds.get(root);
      const affected =
        kind === "dir"
          ? root === dir
          : kind === "file"
            ? dirname(root) === dir
            : probes.get(root) === dir;
      if (affected) void serial(`root:${root}`, () => syncRoot(root, "live"));
    }
    const left = depthLeft.get(dir);
    const ancestry = ancestries.get(dir);
    if (left !== undefined && ancestry && !watchedRoots.has(dir))
      void serial(`dir:${dir}`, () => syncDir(dir, left, "live", ancestry));
  }
  const watcher = Object.defineProperties(emitter, {
    ready: { get: () => ready, configurable: true },
    unwatched: { get: () => natives.unwatched(), configurable: true },
    snapshot: { value: snapshot, writable: true, configurable: true },
    add: { value: add, writable: true, configurable: true },
    unwatch: { value: unwatch, writable: true, configurable: true },
    rescan: { value: rescan, writable: true, configurable: true },
    close: { value: close, writable: true, configurable: true },
  }) as unknown as FSWatcher;

  const given = list(paths);
  seed(options.since, given);
  ready = begin(given, options.since !== undefined).then((result) => {
    if (!closed) emitter.emit("ready", result);
    scheduleRescan();
    return result;
  });
  return watcher;
}
