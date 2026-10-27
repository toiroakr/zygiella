import { EDITOR_TEMP, matcher, type Matcher } from "./match.ts";
import type { WatchOptions } from "./types.ts";

const ATOMIC_MS = 100;
// setTimeout treats a delay above 2 ** 31 - 1 as 1 ms
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface Settings {
  ignored: Matcher;
  /** How long an unlink is held back, in ms; 0 holds nothing. */
  atomicMs: number;
  ignoreInitial: boolean;
  maxDepth: number;
  followSymlinks: boolean;
  ignorePermissionErrors: boolean;
  persistent: boolean;
  rescanInterval: number;
  settle: { stabilityThreshold: number; pollInterval: number } | undefined;
}

const settleOf = (awf: WatchOptions["awaitWriteFinish"]): Settings["settle"] =>
  awf
    ? {
        stabilityThreshold: (typeof awf === "object" && awf.stabilityThreshold) || 2000,
        pollInterval: (typeof awf === "object" && awf.pollInterval) || 100,
      }
    : undefined;

export function resolveOptions(options: WatchOptions): Settings {
  const atomic = options.atomic ?? true;
  const atomicMs = atomic === true ? ATOMIC_MS : atomic || 0;
  const userIgnored = matcher(options.ignored);
  const rescanInterval = options.rescanInterval ?? 0;
  // `false` and `""` would pass the range test by coercion, and setTimeout reads them as 1 ms
  if (
    typeof rescanInterval !== "number" ||
    !(rescanInterval >= 0 && rescanInterval <= MAX_TIMER_MS)
  )
    throw new RangeError(
      `rescanInterval must be a number from 0 to ${MAX_TIMER_MS} ms, got ${String(rescanInterval)}`,
    );
  return {
    atomicMs,
    ignored:
      atomicMs > 0
        ? { ...userIgnored, byPath: (path) => EDITOR_TEMP.test(path) || userIgnored.byPath(path) }
        : userIgnored,
    ignoreInitial: options.ignoreInitial ?? false,
    maxDepth: options.depth ?? Infinity,
    followSymlinks: options.followSymlinks ?? true,
    ignorePermissionErrors: options.ignorePermissionErrors ?? false,
    persistent: options.persistent ?? true,
    rescanInterval,
    settle: settleOf(options.awaitWriteFinish),
  };
}
