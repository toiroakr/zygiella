import { dirname, sep } from "node:path";
import type { Entry, Snapshot, SnapshotEntry } from "./types.ts";

const SNAPSHOT_VERSION = 1;

const isSnapshotEntry = (entry: unknown): entry is SnapshotEntry => {
  const e = entry as Partial<Record<keyof SnapshotEntry, unknown>> | null;
  return (
    typeof e === "object" &&
    e !== null &&
    typeof e.path === "string" &&
    typeof e.dir === "boolean" &&
    typeof e.mtimeMs === "number" &&
    typeof e.size === "number" &&
    typeof e.ino === "number" &&
    (e.link === undefined || typeof e.link === "string")
  );
};

export const recorded = (path: string, entry: Entry): SnapshotEntry => {
  const { dir, mtimeMs, size, ino, link } = entry;
  return link === undefined
    ? { path, dir, mtimeMs, size, ino }
    : { path, dir, mtimeMs, size, ino, link };
};

export const toSnapshot = (entries: SnapshotEntry[]): Snapshot => ({
  version: SNAPSHOT_VERSION,
  entries: entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
});

/** The entries of `since` that a scan of `roots` can reach again, shallow first. */
export function seedEntries(
  since: Snapshot | null | undefined,
  roots: readonly string[],
  depth: number,
  ignored: (path: string) => boolean,
): SnapshotEntry[] {
  if (!since || since.version !== SNAPSHOT_VERSION || !Array.isArray(since.entries)) return [];
  const rootSet = new Set(roots);
  // the nearest watched root at or above a path, found by walking up, not by looking at every root
  const rootOf = (path: string): string | undefined => {
    for (let p = path; ; p = dirname(p)) {
      if (rootSet.has(p)) return p;
      if (dirname(p) === p) return undefined;
    }
  };
  const ignoredAbove = (path: string): boolean => {
    for (let p = path; ; p = dirname(p)) {
      if (ignored(p)) return true;
      if (rootSet.has(p) || dirname(p) === p) return false;
    }
  };
  const kept = new Set<string>();
  const seeded: SnapshotEntry[] = [];
  // shallow first, so that whether the parent was kept is known
  const usable = since.entries
    .filter(isSnapshotEntry)
    .sort((x, y) => x.path.length - y.path.length);
  for (const entry of usable) {
    const root = rootOf(entry.path);
    if (root === undefined) continue;
    // below the levels that are descended into now, so it is not scanned and would be reported as unlink
    if (entry.path.slice(root.length).split(sep).filter(Boolean).length > depth + 1) continue;
    // an ignored path, or one below an ignored directory, is not scanned: it would be reported as unlink
    if (ignoredAbove(entry.path)) continue;
    // below an entry that is missing, it can never be reached from its parent, and would stay in the baseline
    if (!rootSet.has(entry.path) && !kept.has(dirname(entry.path))) continue;
    if (entry.dir) kept.add(entry.path);
    seeded.push(entry);
  }
  return seeded;
}
