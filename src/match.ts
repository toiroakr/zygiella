import type { Stats } from "node:fs";
import { resolve, sep } from "node:path";
import type { Ignored } from "./types.ts";

export const EDITOR_TEMP = /\..*\.(sw[px])$|~$|\.subl.*\.tmp/;

export const within = (root: string, path: string): boolean =>
  path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

export interface Matcher {
  byPath: (path: string) => boolean;
  /** Present only when some function asked for stats. */
  byStats?: (path: string, stats: Stats) => boolean;
}

const slashed = sep === "/" ? (path: string) => path : (path: string) => path.split(sep).join("/");

export function matcher(ignored: Ignored | undefined): Matcher {
  if (ignored === undefined) return { byPath: () => false };
  if (typeof ignored === "function")
    return ignored.length >= 2
      ? { byPath: () => false, byStats: (path, stats) => ignored(path, stats) }
      : { byPath: (path) => ignored(path) };
  if (ignored instanceof RegExp)
    return {
      byPath: (path) => {
        // with the g or y flag, test() resumes from the last match, so a second path would not be tested from its start
        ignored.lastIndex = 0;
        return ignored.test(slashed(path));
      },
    };
  if (typeof ignored === "string") {
    const target = resolve(ignored);
    return { byPath: (path) => within(target, path) };
  }
  const all = ignored.map(matcher);
  const withStats = all.filter((m) => m.byStats);
  return {
    byPath: (path) => all.some((m) => m.byPath(path)),
    byStats: withStats.length
      ? (path, stats) => withStats.some((m) => m.byStats!(path, stats))
      : undefined,
  };
}

export const list = (paths: string | readonly string[]): string[] =>
  (typeof paths === "string" ? [paths] : [...paths]).map((p) => resolve(p));
