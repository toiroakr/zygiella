import { watch as nativeWatch, type FSWatcher as NativeWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";

export const VANISHED = new Set(["ENOENT", "ENOTDIR"]);
export const DENIED = new Set(["EACCES", "EPERM"]);

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

export interface NativeWatches {
  ensure(dir: string): void;
  release(dir: string): void;
  /** Directories that are read but have no native watch, sorted. */
  unwatched(): string[];
  close(): void;
}

export interface NativeWatchOptions {
  persistent: boolean;
  /** Whether something still needs `dir` to be watched; `release` keeps it if so. */
  needed: (dir: string) => boolean;
  /** `fs.watch` reported something below `dir`, or its watcher failed. */
  onChange: (dir: string) => void;
  onError: (error: NodeJS.ErrnoException, dir: string) => void;
}

export function nativeWatches({
  persistent,
  needed,
  onChange,
  onError,
}: NativeWatchOptions): NativeWatches {
  const watchers = new Map<string, NativeWatcher>();
  const unwatched = new Set<string>();
  let closed = false;

  // a directory that vanished is not listed: whoever removed it is reported by its parent's sync, which releases it
  const failed = (dir: string, error: NodeJS.ErrnoException): void => {
    if (!VANISHED.has(error.code ?? "")) unwatched.add(dir);
    onError(error, dir);
  };

  return {
    ensure(dir) {
      if (closed || watchers.has(dir)) return;
      try {
        const watcher = nativeWatch(dir, { persistent });
        watcher.on("change", () => onChange(dir));
        watcher.on("error", (error) => {
          // the directory itself went away; its parent's or the root's own sync reports it
          watchers.delete(dir);
          watcher.close();
          failed(dir, error);
          onChange(dir);
        });
        watchers.set(dir, watcher);
        unwatched.delete(dir);
      } catch (error) {
        failed(dir, error as NodeJS.ErrnoException);
      }
    },
    release(dir) {
      if (needed(dir)) return;
      unwatched.delete(dir);
      watchers.get(dir)?.close();
      watchers.delete(dir);
    },
    unwatched: () => [...unwatched].sort(),
    close() {
      closed = true;
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
      unwatched.clear();
    },
  };
}
