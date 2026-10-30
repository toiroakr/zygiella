import type { Stats } from "node:fs";
import { readlink } from "node:fs/promises";
import { within } from "./match.ts";
import type { Entry, WatchEvent } from "./types.ts";

const QUIET_MS = 50;
/** An add or change that finds an empty file waits this long for the data, because Linux reports truncate before write. */
const EMPTY_HOLD_MS = 10;
/** How many times at most a file is read for its first report, when writes keep being announced during the reads. */
const MAX_FRESH_READS = 3;

interface Settling {
  event: "add" | "change";
  /** What was reported last, for a change that is still waiting: that is what `snapshot()` records. */
  before?: Entry;
  /** Where the file of an add that is still waiting was moved from. */
  renamedFrom?: string;
  /** Still waiting for the first read of the file, which reports at once unless the file is empty. */
  leading?: boolean;
  /** An announce came while the first read was in flight, so that read may be older than the write it announced. */
  dirty?: boolean;
  /** The entry that the last announce during the first read said was there before its write. */
  dirtyBefore?: Entry;
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
  /** The file settled at this size and mtime, which the entry may not know yet. Returns the entry as it is recorded now. */
  settled: (path: string, info: Stats, link: string | undefined) => Entry | undefined;
  /** What a first report of `path` waits for: the read of its directory, in which a move is paired from both halves. */
  after?: (path: string) => Promise<unknown> | undefined;
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
  after,
}: PendingOptions): Pending {
  const settling = new Map<string, Settling>();
  const unlinks = new Map<string, { timer: NodeJS.Timeout; entry: Entry }>();
  /** Paths that were reported a moment ago: a report for them waits for a quiet period again. */
  const reportedRecently = new Map<string, NodeJS.Timeout>();

  const takeHeld = (path: string): Entry | undefined => {
    const held = unlinks.get(path);
    if (!held) return undefined;
    clearTimeout(held.timer);
    unlinks.delete(path);
    return held.entry;
  };

  const api: Pending = {
    holdsUnlinks: atomic > 0,
    announce(event, path, before, renamedFrom) {
      const held = takeHeld(path);
      if (held) event = "change";
      const prior = settling.get(path);
      if (prior?.leading && !settle) {
        if (event === "add") prior.event = "add";
        prior.renamedFrom = undefined;
        prior.dirty = true;
        prior.dirtyBefore = before ?? prior.dirtyBefore;
        return;
      }
      clearTimeout(prior?.timer);
      const job: Settling = {
        event: prior?.event === "add" ? "add" : event,
        before: prior ? prior.before : (before ?? held),
        // a file that changes while its add waits is not the file that was paired
        renamedFrom: prior ? undefined : renamedFrom,
      };
      settling.set(path, job);
      if (!settle) {
        const report = (info: Stats | undefined, link: string | undefined, followed = false) => {
          settling.delete(path);
          // a native event for the write that finished meanwhile may arrive later and must not report it again
          const recorded = info ? settled(path, info, link) : undefined;
          clearTimeout(reportedRecently.get(path));
          reportedRecently.set(
            path,
            timeout(() => reportedRecently.delete(path), QUIET_MS),
          );
          // before the listeners run, so that a listener that stops watching the path or closes the watcher cancels it
          if (followed) api.announce("change", path, recorded ?? job.dirtyBefore);
          dispatch(job.event, path, job.event === "add" ? job.renamedFrom : undefined);
        };
        const read = async () => {
          const info = await stat(path).catch(() => undefined);
          const link =
            !followSymlinks && info?.isSymbolicLink()
              ? await readlink(path).catch(() => undefined)
              : undefined;
          return { info, link };
        };
        const afterHold = async () => {
          const { info, link } = await read();
          if (settling.get(path) === job) report(info, link);
        };
        if (reportedRecently.has(path)) {
          // Linux reports a write as truncate then write, and a new file as create then write: one report for the burst
          job.timer = timeout(afterHold, QUIET_MS);
          return;
        }
        job.leading = true;
        void (async () => {
          // only an add is paired with a removal, so a change has nothing to wait for
          const waited = job.event === "add" ? after?.(path) : undefined;
          // a read that does not come back (a slow or stuck directory) must not hold a report longer than the quiet period did
          if (waited) {
            await new Promise<void>((resolve) => {
              job.timer = timeout(resolve, QUIET_MS);
              void waited.then(
                () => resolve(),
                () => resolve(),
              );
            });
            clearTimeout(job.timer);
            job.timer = undefined;
          }
          if (settling.get(path) !== job) return;
          // a read that was in flight when another announce came may have seen the file before that write
          let result: Awaited<ReturnType<typeof read>>;
          let fresh = 0;
          do {
            job.dirty = false;
            result = await read();
            if (settling.get(path) !== job) return;
          } while (job.dirty && ++fresh < MAX_FRESH_READS);
          const { info, link } = result;
          job.leading = false;
          // writes that go on during every read must not postpone this report, so they follow as a change
          if (info && info.size > 0) report(info, link, job.dirty);
          // a file that is gone may be taken back by the removal that is being read, so it gets the longer wait
          else job.timer = timeout(afterHold, info ? EMPTY_HOLD_MS : QUIET_MS);
        })();
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
      clearTimeout(reportedRecently.get(path));
      reportedRecently.delete(path);
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
      for (const timer of reportedRecently.values()) clearTimeout(timer);
      reportedRecently.clear();
      for (const [path, { timer, entry }] of unlinks) {
        clearTimeout(timer);
        entries.set(path, entry);
      }
      unlinks.clear();
    },
  };
  return api;
}
