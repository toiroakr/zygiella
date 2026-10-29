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
  const gone = new Map<number, Seen>();
  const fresh = new Map<number, Seen>();

  const meet = (own: Map<number, Seen>, other: Map<number, Seen>, path: string, entry: Entry) => {
    if (entry.dir || entry.ino === 0 || entry.dev === undefined) return undefined;
    const at = now();
    const candidate = other.get(entry.ino);
    if (
      candidate &&
      at - candidate.at <= WINDOW_MS &&
      candidate.path !== path &&
      candidate.entry.dev === entry.dev &&
      candidate.entry.size === entry.size &&
      candidate.entry.mtimeMs === entry.mtimeMs
    ) {
      other.delete(entry.ino);
      own.delete(entry.ino);
      return candidate.path;
    }
    // a Map iterates in insertion order, which is the order of `at`, so the expired ones are all at the front
    for (const [ino, seen] of own) {
      if (at - seen.at <= WINDOW_MS) break;
      own.delete(ino);
    }
    own.delete(entry.ino);
    own.set(entry.ino, { path, entry, at });
    return undefined;
  };

  return {
    removed: (path, entry) => meet(gone, fresh, path, entry),
    added: (path, entry) => meet(fresh, gone, path, entry),
  };
}
