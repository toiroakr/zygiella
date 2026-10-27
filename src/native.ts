import { watch as nativeWatch, type FSWatcher as NativeWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { within } from "./match.ts";

export const VANISHED = new Set(["ENOENT", "ENOTDIR"]);
export const DENIED = new Set(["EACCES", "EPERM"]);
// watching again after one of these only makes the shortage worse; rescan() is what tries again
const EXHAUSTED = new Set(["EMFILE", "ENOSPC"]);
// chokidar gives up the same way: after this many errors in a row with no event in between
const MAX_REWATCHES = 3;

/** The closest directory at or above the parent of `path` that exists. */
export async function nearestDirectory(path: string): Promise<string> {
  let ancestor = dirname(path);
  while (
    !(await stat(ancestor).catch(() => undefined))?.isDirectory() &&
    dirname(ancestor) !== ancestor
  )
    ancestor = dirname(ancestor);
  return ancestor;
}

// libuv watches a whole tree with one FSEventStream on macOS; on Linux Node walks the tree and opens a watch for
// every directory itself (and for every file before Node 24), which saves nothing. Windows was not measured.
const TREE_WATCH = process.platform === "darwin";
const FEATURE_UNAVAILABLE = "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM";

export interface NativeWatches {
  /** Watches `dir` alone. */
  ensure(dir: string): void;
  /**
   * Watches `root` and everything below it with one native watch. False when that is not possible here, in which
   * case the caller watches each directory with `ensure`.
   */
  ensureTree(root: string): boolean;
  /** Whether a tree watch already reports what happens in `dir`. */
  covers(dir: string): boolean;
  /** `dir` is reported by a tree watch from now on: it is no longer listed as unwatched and needs no watch of its own. */
  covered(dir: string): void;
  /** Lets `ensure` and `ensureTree` try again where a limit was hit; only `rescan()` does this. */
  retry(): void;
  release(dir: string): void;
  /** Directories (or tree roots) that are read but have no native watch, sorted. */
  unwatched(): string[];
  close(): void;
}

export interface NativeWatchOptions {
  persistent: boolean;
  /** Whether something still needs `dir` to be watched; `release` keeps it if so. */
  needed: (dir: string) => boolean;
  /** `fs.watch` reported something below `dir`, or its watcher failed. `name` is the entry it named, when it did. */
  onChange: (dir: string, name?: string) => void;
  /** A tree watch reported something without saying where, so anything below `root` may have changed. */
  onLost: (root: string) => void;
  onError: (error: NodeJS.ErrnoException, dir: string) => void;
}

export function nativeWatches({
  persistent,
  needed,
  onChange,
  onLost,
  onError,
}: NativeWatchOptions): NativeWatches {
  const watchers = new Map<string, NativeWatcher>();
  const trees = new Map<string, NativeWatcher>();
  const unwatched = new Set<string>();
  const rewatches = new Map<string, number>();
  // keys whose watch was given up on: only rescan() asks for another try, not a read that happens to pass by
  const blocked = new Set<string>();
  let treesUnavailable = false;
  let closed = false;

  // a directory that vanished is not listed: whoever removed it is reported by its parent's sync, which releases it
  const failed = (dir: string, error: NodeJS.ErrnoException): void => {
    if (!VANISHED.has(error.code ?? "")) unwatched.add(dir);
    onError(error, dir);
  };

  /** What both kinds of watch do with an error: close it, report it, and have the directory read again unless that cannot help. */
  const lost = (
    key: string,
    watcher: NativeWatcher,
    open: Map<string, NativeWatcher>,
    error: NodeJS.ErrnoException,
    reconcile: () => void,
  ): void => {
    open.delete(key);
    watcher.close();
    failed(key, error);
    // a vanished directory is reported by its parent's or the root's own sync; any other error is retried by that
    // sync too, which watches the directory again
    const tries = rewatches.get(key) ?? 0;
    if (!VANISHED.has(error.code ?? "")) {
      if (EXHAUSTED.has(error.code ?? "") || tries >= MAX_REWATCHES) {
        blocked.add(key);
        return;
      }
      rewatches.set(key, tries + 1);
    }
    reconcile();
  };

  return {
    ensure(dir) {
      if (closed || watchers.has(dir) || blocked.has(dir)) return;
      try {
        const watcher = nativeWatch(dir, { persistent });
        watcher.on("change", (_type, name) => {
          rewatches.delete(dir);
          onChange(dir, name ? String(name) : undefined);
        });
        watcher.on("error", (error: NodeJS.ErrnoException) =>
          lost(dir, watcher, watchers, error, () => onChange(dir)),
        );
        watchers.set(dir, watcher);
        unwatched.delete(dir);
      } catch (error) {
        failed(dir, error as NodeJS.ErrnoException);
      }
    },
    ensureTree(root) {
      if (closed || !TREE_WATCH || treesUnavailable || blocked.has(root)) return false;
      if (trees.has(root)) return true;
      try {
        const watcher = nativeWatch(root, { persistent, recursive: true });
        watcher.on("change", (_type, name) => {
          rewatches.delete(root);
          if (!name) return onLost(root);
          const path = join(root, String(name));
          onChange(dirname(path), basename(path));
        });
        watcher.on("error", (error: NodeJS.ErrnoException) =>
          // what was missed anywhere below the root is only found by reading all of it
          lost(root, watcher, trees, error, () => onLost(root)),
        );
        trees.set(root, watcher);
        unwatched.delete(root);
        return true;
      } catch (error) {
        // whatever the reason, the directories are watched one by one, and that reports an error of its own if it fails too
        if ((error as NodeJS.ErrnoException).code === FEATURE_UNAVAILABLE) treesUnavailable = true;
        return false;
      }
    },
    covered(dir) {
      unwatched.delete(dir);
      watchers.get(dir)?.close();
      watchers.delete(dir);
    },
    retry: () => blocked.clear(),
    covers: (dir) => [...trees.keys()].some((root) => within(root, dir)),
    release(dir) {
      if (needed(dir)) return;
      unwatched.delete(dir);
      rewatches.delete(dir);
      blocked.delete(dir);
      watchers.get(dir)?.close();
      watchers.delete(dir);
      trees.get(dir)?.close();
      trees.delete(dir);
    },
    unwatched: () => [...unwatched].sort(),
    close() {
      closed = true;
      for (const watcher of [...watchers.values(), ...trees.values()]) watcher.close();
      watchers.clear();
      trees.clear();
      unwatched.clear();
      rewatches.clear();
      blocked.clear();
    },
  };
}
