// One scenario in one process: `node --expose-gc bench/scenario.mjs <name> <dist/index.mjs> <work dir>`.
// Prints one JSON object of numbers. Never imports anything from src, so it measures the built package.
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { tree, wide } from "./fixture.mjs";

const [name, distFile, work] = process.argv.slice(2);
const { watch } = await import(pathToFileURL(distFile).href);

const MB = 1024 * 1024;
const gc = () => {
  globalThis.gc();
  globalThis.gc();
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const until = async (condition, limit = 60000) => {
  const start = performance.now();
  while (!condition()) {
    if (performance.now() - start > limit) throw new Error(`timed out waiting in ${name}`);
    await sleep(1);
  }
};
const check = (actual, expected, what) => {
  if (actual !== expected) throw new Error(`${name}: ${what}: expected ${expected}, got ${actual}`);
};

// peak of the heap while something runs, sampled between turns of the event loop
function samplePeak() {
  let heap = process.memoryUsage().heapUsed;
  let rss = process.memoryUsage().rss;
  const timer = setInterval(() => {
    const usage = process.memoryUsage();
    heap = Math.max(heap, usage.heapUsed);
    rss = Math.max(rss, usage.rss);
  }, 2);
  return () => {
    clearInterval(timer);
    return { heap, rss };
  };
}

const TREE = { fanout: 10, depth: 3, perDir: 20 }; // 1110 directories, 20000 files
const SMALL_TREE = { fanout: 8, depth: 3, perDir: 10 }; // 584 directories, 5120 files

const scenarios = {
  // the first scan reports every entry; ready waits for it
  async "scan-tree"() {
    const shape = tree(join(work, "scan-tree"), TREE);
    return scan(join(work, "scan-tree"), shape, {});
  },
  async "scan-wide"() {
    const shape = wide(join(work, "scan-wide"), 20000);
    return scan(join(work, "scan-wide"), shape, {});
  },
  // nothing is reported, so what remains is what the watcher keeps
  async "scan-tree-quiet"() {
    const shape = tree(join(work, "scan-tree"), TREE);
    return scan(join(work, "scan-tree"), shape, { ignoreInitial: true });
  },
  async "scan-tree-ignored"() {
    const shape = tree(join(work, "scan-tree"), TREE);
    // d5 to d9 are skipped on every level, so only the directories below d0 to d4 are read
    const ignored = /\/d[5-9](\/|$)/;
    const root = join(work, "scan-tree");
    const kept = readdirSync(root, { recursive: true }).filter(
      (rel) => !ignored.test(`/${rel.replaceAll("\\", "/")}`),
    );
    return scan(root, { dirs: 0, files: kept.length }, { ignored });
  },
  // the case that the worker budget has to get right: a huge directory first, then many small ones that take every worker
  async "scan-big-then-small"() {
    const root = join(work, "scan-big-then-small");
    wide(join(root, "0big"), 20000);
    for (let i = 0; i < 300; i++) wide(join(root, `s${i}`), 3);
    return scan(root, { dirs: 301, files: 20000 + 900 }, {});
  },
  async rescan() {
    const root = join(work, "rescan");
    const shape = tree(root, SMALL_TREE);
    const watcher = watch(root, { ignoreInitial: true });
    await watcher.ready;
    gc();
    const unchanged = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      await watcher.rescan();
      unchanged.push(performance.now() - start);
    }
    // one change per directory of the first level, which rescan() has to find and report
    let changes = 0;
    watcher.on("change", () => changes++);
    for (let i = 0; i < 8; i++)
      writeFileSync(join(root, `d${i}`, "d0", "d0", "f0.txt"), "changed!");
    const start = performance.now();
    await watcher.rescan();
    await until(() => changes === 8);
    const changed = performance.now() - start;
    await watcher.close();
    return { rescanMs: median(unchanged), rescanChangedMs: changed, files: shape.files };
  },
  // a bulk removal in a directory of a big tree: every unlink has to forget one path
  async "bulk-unlink"() {
    const root = join(work, "bulk-unlink");
    tree(root, SMALL_TREE);
    const target = join(root, "bulk");
    wide(target, 3000);
    const watcher = watch(root, { ignoreInitial: true });
    await watcher.ready;
    let unlinks = 0;
    watcher.on("unlink", () => unlinks++);
    const start = performance.now();
    for (const file of readdirSync(target)) rmSync(join(target, file));
    await until(() => unlinks === 3000);
    const ms = performance.now() - start;
    await watcher.close();
    return { ms };
  },
  async "bulk-add"() {
    const root = join(work, "bulk-add");
    tree(root, SMALL_TREE);
    const target = join(root, "bulk");
    mkdirSync(target);
    const watcher = watch(root, { ignoreInitial: true });
    await watcher.ready;
    let adds = 0;
    watcher.on("add", () => adds++);
    const start = performance.now();
    for (let i = 0; i < 3000; i++) writeFileSync(join(target, `n${i}.txt`), String(i));
    await until(() => adds === 3000);
    const ms = performance.now() - start;
    await watcher.close();
    return { ms };
  },
  // remove a whole directory below the root: one native event, then every entry below it is forgotten
  async "remove-directory"() {
    const root = join(work, "remove-directory");
    tree(root, SMALL_TREE);
    const watcher = watch(root, { ignoreInitial: true });
    await watcher.ready;
    let unlinks = 0;
    let dirs = 0;
    watcher.on("unlink", () => unlinks++);
    watcher.on("unlinkDir", () => dirs++);
    const start = performance.now();
    rmSync(join(root, "d0"), { recursive: true });
    const expectedFiles = 8 * 8 * 10;
    await until(() => unlinks === expectedFiles && dirs === 1 + 8 + 64);
    const ms = performance.now() - start;
    await watcher.close();
    return { ms };
  },
  // a write to a watched file, until `change` is reported: the latency of one event
  async "change-latency"() {
    const root = join(work, "change-latency");
    tree(root, SMALL_TREE);
    const watcher = watch(root, { ignoreInitial: true });
    await watcher.ready;
    let seen = 0;
    watcher.on("change", () => seen++);
    const samples = [];
    for (let i = 0; i < 60; i++) {
      const file = join(root, `d${i % 8}`, `d${(i >> 3) % 8}`, "d0", `f${i % 10}.txt`);
      const before = seen;
      const start = performance.now();
      writeFileSync(file, `v${i}-${"x".repeat(i + 1)}`);
      await until(() => seen > before);
      samples.push(performance.now() - start);
      await sleep(60); // let the quiet period of that path pass
    }
    await watcher.close();
    samples.sort((a, b) => a - b);
    return { medianMs: median(samples), p95Ms: samples[Math.floor(samples.length * 0.95)] };
  },
  // the same in a directory just below the size at which names of events are trusted: every event reads it whole
  async "change-medium"() {
    const root = join(work, "change-medium");
    wide(root, 900);
    const watcher = watch(root, { ignoreInitial: true });
    await watcher.ready;
    let seen = 0;
    watcher.on("change", () => seen++);
    const samples = [];
    const cpuBefore = process.cpuUsage();
    for (let i = 0; i < 40; i++) {
      const before = seen;
      const start = performance.now();
      writeFileSync(join(root, `f${i * 7}.txt`), `v${i}-${"x".repeat(i + 1)}`);
      await until(() => seen > before);
      samples.push(performance.now() - start);
      await sleep(60);
    }
    const cpu = process.cpuUsage(cpuBefore);
    await watcher.close();
    samples.sort((a, b) => a - b);
    return {
      medianMs: median(samples),
      p95Ms: samples[Math.floor(samples.length * 0.95)],
      cpuPerEventMs: (cpu.user + cpu.system) / 1000 / 40,
    };
  },
  // a new file in a small directory, until `add`
  async "add-latency"() {
    const root = join(work, "add-latency");
    tree(root, SMALL_TREE);
    const watcher = watch(root, { ignoreInitial: true });
    await watcher.ready;
    let seen = 0;
    watcher.on("add", () => seen++);
    const samples = [];
    for (let i = 0; i < 60; i++) {
      const before = seen;
      const start = performance.now();
      writeFileSync(join(root, `d${i % 8}`, `d0`, "d1", `new${i}.txt`), "hello");
      await until(() => seen > before);
      samples.push(performance.now() - start);
      await sleep(10);
    }
    await watcher.close();
    samples.sort((a, b) => a - b);
    return { medianMs: median(samples), p95Ms: samples[Math.floor(samples.length * 0.95)] };
  },
  // a rename: the move is paired from the removal and the addition
  async "rename-burst"() {
    const root = join(work, "rename-burst");
    wide(root, 2000);
    const watcher = watch(root, { ignoreInitial: true });
    await watcher.ready;
    let paired = 0;
    let adds = 0;
    let unlinks = 0;
    watcher.on("add", (_path, details) => {
      adds++;
      if (details?.renamedFrom) paired++;
    });
    watcher.on("unlink", () => unlinks++);
    const start = performance.now();
    for (let i = 0; i < 2000; i++) renameSync(join(root, `f${i}.txt`), join(root, `g${i}.txt`));
    await until(() => adds === 2000 && unlinks === 2000);
    const ms = performance.now() - start;
    await watcher.close();
    return { ms, paired };
  },
  // watchers that are created and closed again: time per cycle and what stays behind
  async churn() {
    const root = join(work, "churn");
    wide(root, 200);
    gc();
    const before = process.memoryUsage().heapUsed;
    const start = performance.now();
    const cycles = 100;
    for (let i = 0; i < cycles; i++) {
      const watcher = watch(root, { ignoreInitial: i % 2 === 0 });
      await watcher.ready;
      await watcher.close();
    }
    const ms = (performance.now() - start) / cycles;
    gc();
    await sleep(50);
    gc();
    return { cycleMs: ms, retainedKB: (process.memoryUsage().heapUsed - before) / 1024 };
  },
  // many small watchers at the same time: the fixed cost of one
  async "many-watchers"() {
    const root = join(work, "many-watchers");
    wide(root, 5);
    gc();
    const before = process.memoryUsage().heapUsed;
    const count = 300;
    const watchers = [];
    const start = performance.now();
    for (let i = 0; i < count; i++) watchers.push(watch(root, { ignoreInitial: true }));
    await Promise.all(watchers.map((watcher) => watcher.ready));
    const ms = performance.now() - start;
    gc();
    const perWatcherKB = (process.memoryUsage().heapUsed - before) / count / 1024;
    await Promise.all(watchers.map((watcher) => watcher.close()));
    return { setupMs: ms, perWatcherKB };
  },
  async snapshot() {
    const root = join(work, "snapshot");
    const shape = tree(root, SMALL_TREE);
    const watcher = watch(root);
    await watcher.ready;
    const start = performance.now();
    let result;
    for (let i = 0; i < 10; i++) result = watcher.snapshot();
    const snapshotMs = (performance.now() - start) / 10;
    const watchedStart = performance.now();
    for (let i = 0; i < 10; i++) watcher.getWatched();
    const watchedMs = (performance.now() - watchedStart) / 10;
    await watcher.close();
    // start again from the snapshot: only the difference is read and reported
    let events = 0;
    const second = watch(root, { since: result });
    second.on("all", () => events++);
    const sinceStart = performance.now();
    await second.ready;
    const sinceMs = performance.now() - sinceStart;
    await second.close();
    check(events, 0, "events when nothing changed since the snapshot");
    return { snapshotMs, getWatchedMs: watchedMs, sinceReadyMs: sinceMs, entries: shape.files };
  },
};

async function scan(root, shape, options) {
  gc();
  const heapBefore = process.memoryUsage().heapUsed;
  const rssBefore = process.memoryUsage().rss;
  const stop = samplePeak();
  let events = 0;
  const start = performance.now();
  const watcher = watch(root, options);
  watcher.on("all", () => events++);
  await watcher.ready;
  const ms = performance.now() - start;
  const peak = stop();
  gc();
  const heapAfter = process.memoryUsage().heapUsed;
  const rssAfter = process.memoryUsage().rss;
  check(events, options.ignoreInitial ? 0 : shape.dirs + shape.files + 1, "events");
  const tracked = Object.values(watcher.getWatched()).reduce((n, names) => n + names.length, 0);
  await watcher.close();
  return {
    readyMs: ms,
    heapMB: (heapAfter - heapBefore) / MB,
    heapPeakMB: (peak.heap - heapBefore) / MB,
    rssPeakGrowthMB: (peak.rss - rssBefore) / MB,
    rssGrowthMB: (rssAfter - rssBefore) / MB,
    bytesPerEntry: tracked ? (heapAfter - heapBefore) / tracked : 0,
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const run = scenarios[name];
if (!run) throw new Error(`unknown scenario ${name}; known: ${Object.keys(scenarios).join(", ")}`);
mkdirSync(work, { recursive: true });
try {
  const result = await run();
  process.stdout.write(JSON.stringify(result) + "\n");
} finally {
  rmSync(join(work, name), { recursive: true, force: true });
}
process.exit(0);
