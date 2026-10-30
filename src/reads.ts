/**
 * The directory reads that are going on. A directory can be read by two queues at once, so every read is kept until
 * it settles, and a newer read that finishes first does not make an older one that is still running be forgotten.
 */
export interface ReadsInFlight {
  track(dir: string, read: Promise<unknown>): void;
  /** Settles when every read that is in flight now has; undefined when none is. */
  all(): Promise<unknown> | undefined;
}

export function readsInFlight(): ReadsInFlight {
  const reads = new Map<string, Set<Promise<unknown>>>();
  // one aggregate for everything that waits on the same set of reads, instead of one per waiter
  let aggregate: Promise<unknown> | undefined;
  return {
    track(dir, read) {
      let own = reads.get(dir);
      if (!own) reads.set(dir, (own = new Set()));
      own.add(read);
      aggregate = undefined;
      const forget = () => {
        aggregate = undefined;
        own.delete(read);
        if (!own.size && reads.get(dir) === own) reads.delete(dir);
      };
      read.then(forget, forget);
    },
    all() {
      if (aggregate) return aggregate;
      const all = [...reads.values()].flatMap((own) => [...own]);
      return all.length > 0 ? (aggregate = Promise.all(all)) : undefined;
    },
  };
}
