import type { Entry } from "./types.ts";

// the two halves of a move reach different directory reads, so the first one waits this long for the other
const WINDOW_MS = 1000;

interface Seen {
  path: string;
  entry: Entry;
  at: number;
}

/**
 * Pairs a file that disappeared with a file that appeared: the same device and inode with the same size and mtime.
 * The inode alone is not enough, because a file system can give a freed inode to the next file it creates, and
 * inode numbers repeat across devices.
 */
export interface Moves {
  /** A file was removed at `path`. Returns where the same file appeared, if it did a moment ago. */
  removed(path: string, entry: Entry): string | undefined;
  /** A file appeared at `path`. Returns where the same file was removed from, if it was a moment ago. */
  added(path: string, entry: Entry): string | undefined;
}

export function trackMoves(now: () => number = Date.now): Moves {
  const gone = new Map<string, Seen>();
  const fresh = new Map<string, Seen>();

  const meet = (own: Map<string, Seen>, other: Map<string, Seen>, path: string, entry: Entry) => {
    if (entry.dir || entry.ino === 0 || entry.dev === undefined) return undefined;
    const at = now();
    const key = `${entry.dev}:${entry.ino}`;
    const candidate = other.get(key);
    // the file came and went at one path: the other side's record no longer names anything that exists
    if (candidate?.path === path) other.delete(key);
    else if (
      candidate &&
      at - candidate.at <= WINDOW_MS &&
      candidate.entry.dev === entry.dev &&
      candidate.entry.size === entry.size &&
      candidate.entry.mtimeMs === entry.mtimeMs
    ) {
      other.delete(key);
      own.delete(key);
      return candidate.path;
    }
    // a Map iterates in insertion order, which is the order of `at`, so the expired ones are all at the front
    for (const [expired, seen] of own) {
      if (at - seen.at <= WINDOW_MS) break;
      own.delete(expired);
    }
    own.delete(key);
    own.set(key, { path, entry, at });
    return undefined;
  };

  return {
    removed: (path, entry) => meet(gone, fresh, path, entry),
    added: (path, entry) => meet(fresh, gone, path, entry),
  };
}
