import type { Stats } from "node:fs";
import { readlink } from "node:fs/promises";
import { within } from "./match.ts";
import type { Entry, WatchEvent } from "./types.ts";

const QUIET_MS = 50;

interface Settling {
  event: "add" | "change";
  /** What was reported last, for a change that is still waiting: that is what `snapshot()` records. */
  before?: Entry;
  /** Where the file of an add that is still waiting was moved from. */
  renamedFrom?: string;
  timer?: NodeJS.Timeout;
}

export interface PendingOptions {
  /** How long an unlink is held back for `atomic`, in ms; 0 holds nothing. */
  atomic: number;
  /** Set with `awaitWriteFinish`: wait for a stable size and mtime instead of a quiet period. */
  settle: { stabilityThreshold: number; pollInterval: number } | undefined;
  followSymlinks: boolean;
  timeout: (fn: () => void, ms: number) => NodeJS.Timeout;
  dispatch: (event: WatchEvent, path: string, renamedFrom?: string) => void;
  stat: (path: string) => Promise<Stats>;
  /** The file settled at this size and mtime, which the entry may not know yet. */
  settled: (path: string, info: Stats, link: string | undefined) => void;
}

/** Reports that are not made yet: an add / change waiting to settle, and an unlink held back for `atomic`. */
export interface Pending {
  readonly holdsUnlinks: boolean;
  announce(event: "add" | "change", path: string, before?: Entry, renamedFrom?: string): void;
  /** The add waiting for `path` is the file that was at `from`. False when no add is waiting. */
  renamed(path: string, from: string): boolean;
  /** An unlink held back: it is not reported yet, so `entry` is still what was last reported. */
  hold(path: string, entry: Entry): void;
  isHeld(path: string): boolean;
  /** Reports the held unlink of `path` now. */
  flush(path: string): void;
  /** Takes back the held unlinks below `path` that `only` accepts, reporting them unless `report` is false. */
  dropHeld(path: string, only: (key: string) => boolean, report: boolean): void;
  /** Stops the add / change waiting for `path`, and returns it. */
  cancel(path: string): Settling | undefined;
  /** What to record for `path`: the entry as last reported. Undefined while its add is still waiting. */
  baseline(path: string, current: Entry): Entry | undefined;
  heldEntries(): [path: string, entry: Entry][];
  /** Stops every timer and puts back into `entries` what was last reported. */
  close(entries: Map<string, Entry>): void;
}

export function pendingEvents({
  atomic,
  settle,
  followSymlinks,
  timeout,
  dispatch,
  stat,
  settled,
}: PendingOptions): Pending {
  const settling = new Map<string, Settling>();
  const unlinks = new Map<string, { timer: NodeJS.Timeout; entry: Entry }>();

  const takeHeld = (path: string): Entry | undefined => {
    const held = unlinks.get(path);
    if (!held) return undefined;
    clearTimeout(held.timer);
    unlinks.delete(path);
    return held.entry;
  };

  return {
    holdsUnlinks: atomic > 0,
    announce(event, path, before, renamedFrom) {
      const held = takeHeld(path);
      if (held) event = "change";
      const prior = settling.get(path);
      clearTimeout(prior?.timer);
      const job: Settling = {
        event: prior?.event === "add" ? "add" : event,
        before: prior ? prior.before : (before ?? held),
        // a file that changes while its add waits is not the file that was paired
        renamedFrom: prior ? undefined : renamedFrom,
      };
      settling.set(path, job);
      if (!settle) {
        // Linux reports a write as truncate then write, and a new file as create then write: one report for the burst
        job.timer = timeout(async () => {
          const info = await stat(path).catch(() => undefined);
          const link =
            !followSymlinks && info?.isSymbolicLink()
              ? await readlink(path).catch(() => undefined)
              : undefined;
          if (settling.get(path) !== job) return;
          settling.delete(path);
          // a native event for the write that finished meanwhile may arrive later and must not report it again
          if (info) settled(path, info, link);
          dispatch(job.event, path, job.event === "add" ? job.renamedFrom : undefined);
        }, QUIET_MS);
        return;
      }
      let last: string | undefined;
      let since = Date.now();
      const poll = async (): Promise<void> => {
        const info = await stat(path).catch(() => undefined);
        const link =
          !followSymlinks && info?.isSymbolicLink()
            ? await readlink(path).catch(() => undefined)
            : undefined;
        if (settling.get(path) !== job) return;
        // gone: the directory diff reports the unlink, and needs this job to know whether the add was ever announced
        if (!info) return;
        const key = `${info.size}:${info.mtimeMs}`;
        if (key !== last) {
          last = key;
          since = Date.now();
        } else if (Date.now() - since >= settle.stabilityThreshold) {
          settling.delete(path);
          settled(path, info, link);
          dispatch(job.event, path, job.event === "add" ? job.renamedFrom : undefined);
          return;
        }
        job.timer = timeout(poll, settle.pollInterval);
      };
      job.timer = timeout(poll, settle.pollInterval);
    },
    renamed(path, from) {
      const job = settling.get(path);
      if (job?.event !== "add") return false;
      job.renamedFrom = from;
      return true;
    },
    hold(path, entry) {
      const timer = timeout(() => {
        unlinks.delete(path);
        dispatch("unlink", path);
      }, atomic);
      unlinks.set(path, { timer, entry });
    },
    isHeld: (path) => unlinks.has(path),
    flush(path) {
      if (takeHeld(path)) dispatch("unlink", path);
    },
    dropHeld(path, only, report) {
      for (const [key, { timer }] of unlinks) {
        if (!within(path, key) || !only(key) || (report && key === path)) continue;
        clearTimeout(timer);
        unlinks.delete(key);
        // what is below a directory that goes away is reported before the directory is
        if (report) dispatch("unlink", key);
      }
    },
    cancel(path) {
      const job = settling.get(path);
      clearTimeout(job?.timer);
      settling.delete(path);
      return job;
    },
    baseline(path, current) {
      const job = settling.get(path);
      if (job && !job.before) return undefined;
      return job?.before ?? current;
    },
    heldEntries: () => [...unlinks].map(([path, { entry }]) => [path, entry]),
    close(entries) {
      // what was never reported is not what the snapshot should say the watcher saw
      for (const [path, job] of settling) {
        clearTimeout(job.timer);
        if (job.before) entries.set(path, job.before);
        else entries.delete(path);
      }
      settling.clear();
      for (const [path, { timer, entry }] of unlinks) {
        clearTimeout(timer);
        entries.set(path, entry);
      }
      unlinks.clear();
    },
  };
}
