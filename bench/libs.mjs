// Compares zygiella with other file watchers that are installed next to it, each in a fresh process.
//   node bench/libs.mjs run <scenario> <lib> <libs dir> <dist/index.mjs> <work dir>   (one measurement, JSON)
//   node bench/libs.mjs all [--runs 5] [--libs <dir>] [--only a,b]                    (table of medians)
// <libs dir> holds one folder per library with its own node_modules (see LIBS below).
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tree, wide } from "./fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// folder, package name; `initial` says whether the library reports what exists when it starts, `mergesChange` whether
// it cannot tell an add from a change, so a bulk add arrives as either
const LIBS = {
  zygiella: { initial: true },
  chokidar: { dir: "chokidar", pkg: "chokidar", initial: true },
  watcher: { dir: "watcher", pkg: "watcher", initial: false, mergesChange: true },
  "@parcel/watcher": { dir: "_parcel_watcher", pkg: "@parcel/watcher", initial: false },
  "node-watch": { dir: "node-watch", pkg: "node-watch", initial: false, mergesChange: true },
};
const SCENARIOS = ["scan-tree", "idle-tree", "bulk-unlink", "bulk-add", "change-latency"];
const NOT_A_COST = new Set(["events"]);

const median = (v) => {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

async function adapter(name, libs, dist) {
  if (name === "zygiella") {
    const { watch } = await import(pathToFileURL(dist).href);
    return (root, { initial }) => {
      const w = watch(root, { ignoreInitial: !initial });
      return handle(
        w.ready,
        (f) =>
          w.on("all", (e, p) =>
            f(
              e === "unlink" ? "unlink" : e === "add" ? "add" : e === "change" ? "change" : "dir",
              p,
            ),
          ),
        () => w.close(),
      );
    };
  }
  const info = LIBS[name];
  const pkgDir = join(libs, info.dir, "node_modules", info.pkg);
  const meta = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const entry =
    typeof meta.exports === "object"
      ? (meta.exports["."]?.import ?? meta.exports["."]?.default ?? meta.exports["."])
      : (meta.main ?? "index.js");
  const mod = await import(
    pathToFileURL(
      resolve(
        pkgDir,
        (typeof entry === "string" ? entry : "index.js").replace(
          /^(\.\/lib\/watch|lib\/watch)$/,
          "lib/watch.js",
        ),
      ),
    ).href
  );
  const lib = mod.default ?? mod;
  if (name === "chokidar")
    return (root, { initial }) => {
      const w = (lib.watch ?? mod.watch)(root, { ignoreInitial: !initial });
      return handle(
        new Promise((r) => w.once("ready", r)),
        (f) => w.on("all", (e, p) => f(e === "addDir" || e === "unlinkDir" ? "dir" : e, p)),
        () => w.close(),
      );
    };
  if (name === "watcher") {
    const Watcher = lib.default ?? lib;
    return (root, { initial }) => {
      const w = new Watcher(root, { recursive: true, ignoreInitial: !initial });
      return handle(
        new Promise((r) => w.once("ready", r)),
        (f) => w.on("all", (e, p) => f(e === "addDir" || e === "unlinkDir" ? "dir" : e, p)),
        () => w.close(),
      );
    };
  }
  if (name === "@parcel/watcher")
    return (root) => {
      let cb = () => {};
      const sub = lib.subscribe(root, (err, events) => {
        if (!err)
          for (const e of events)
            cb(e.type === "create" ? "add" : e.type === "update" ? "change" : "unlink", e.path);
      });
      return handle(
        sub,
        (f) => (cb = f),
        async () => (await sub).unsubscribe(),
      );
    };
  if (name === "node-watch")
    return (root) => {
      const w = lib(root, { recursive: true });
      return handle(
        new Promise((r) => w.once("ready", r)),
        (f) => w.on("change", (e, p) => f(e === "remove" ? "unlink" : "change", p)),
        () => w.close(),
      );
    };
  throw new Error(`unknown library ${name}`);
}
const handle = (ready, on, close) => ({ ready, on, close });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, limit = 60000) {
  const start = performance.now();
  while (!cond()) {
    if (performance.now() - start > limit) throw new Error("timed out");
    await sleep(1);
  }
}
const MB = 1024 * 1024;

async function run(scenario, name, libs, dist, work) {
  const make = await adapter(name, libs, dist);
  const gc = () => (globalThis.gc(), globalThis.gc());
  mkdirSync(work, { recursive: true });
  const root = join(work, scenario);
  const mem = async (initial, shape) => {
    gc();
    const heap0 = process.memoryUsage().heapUsed;
    const rss0 = process.memoryUsage().rss;
    let events = 0;
    let peak = rss0;
    const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage.rss())), 2);
    const start = performance.now();
    const w = make(root, { initial });
    w.on(() => events++);
    await w.ready;
    const ms = performance.now() - start;
    await sleep(150); // late events and native threads settle
    clearInterval(timer);
    gc();
    const m = process.memoryUsage();
    await w.close();
    return {
      readyMs: ms,
      heapMB: (m.heapUsed - heap0) / MB,
      rssGrowthMB: (m.rss - rss0) / MB,
      rssPeakGrowthMB: (peak - rss0) / MB,
      events: events - shape,
    };
  };
  if (scenario === "scan-tree") {
    if (!LIBS[name].initial) return null;
    const shape = tree(root, { fanout: 10, depth: 3, perDir: 20 });
    return mem(true, shape.dirs + shape.files + 1);
  }
  if (scenario === "idle-tree") {
    tree(root, { fanout: 10, depth: 3, perDir: 20 });
    return mem(false, 0);
  }
  tree(root, { fanout: 8, depth: 3, perDir: 10 });
  const w = make(root, { initial: false });
  const counts = { add: 0, change: 0, unlink: 0 };
  w.on((e) => (counts[e] = (counts[e] ?? 0) + 1));
  await w.ready;
  await sleep(100);
  try {
    if (scenario === "bulk-unlink") {
      const target = join(root, "bulk");
      wide(target, 3000);
      await sleep(400);
      counts.unlink = 0;
      const start = performance.now();
      for (const f of readdirSync(target)) rmSync(join(target, f));
      await until(() => counts.unlink >= 3000);
      return { ms: performance.now() - start };
    }
    if (scenario === "bulk-add") {
      const target = join(root, "bulk");
      mkdirSync(target);
      await sleep(200);
      const start = performance.now();
      for (let i = 0; i < 3000; i++) writeFileSync(join(target, `n${i}.txt`), String(i));
      await until(() => counts.add + (LIBS[name].mergesChange ? counts.change : 0) >= 3000);
      return { ms: performance.now() - start };
    }
    if (scenario === "change-latency") {
      const samples = [];
      for (let i = 0; i < 40; i++) {
        const file = join(root, `d${i % 8}`, `d${(i >> 3) % 8}`, "d0", `f${i % 10}.txt`);
        const before = counts.change;
        const start = performance.now();
        writeFileSync(file, `v${i}-${"x".repeat(i + 1)}`);
        await until(() => counts.change > before);
        samples.push(performance.now() - start);
        await sleep(120);
      }
      samples.sort((a, b) => a - b);
      return { medianMs: median(samples), p95Ms: samples[Math.floor(samples.length * 0.95)] };
    }
    throw new Error(`unknown scenario ${scenario}`);
  } finally {
    await w.close();
  }
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "run") {
  const [scenario, name, libs, dist, work] = rest;
  const result = await run(scenario, name, libs, dist, work);
  process.stdout.write(JSON.stringify(result) + "\n");
  rmSync(work, { recursive: true, force: true });
  process.exit(0);
} else if (mode === "all") {
  const flags = Object.fromEntries(
    rest.flatMap((a, i) => (a.startsWith("--") ? [[a.slice(2), rest[i + 1]]] : [])),
  );
  const runs = Number(flags.runs ?? 5);
  if (!Number.isInteger(runs) || runs < 1)
    throw new Error("--runs must be an integer of 1 or more");
  if (!flags.libs)
    throw new Error(
      "pass --libs <dir> with one folder per library, each holding its own node_modules: chokidar, watcher, _parcel_watcher (@parcel/watcher), node-watch",
    );
  const libs = resolve(flags.libs);
  const dist = join(here, "..", "dist", "index.mjs");
  const work = join(tmpdir(), "zygiella-bench-libs");
  const scenarios = flags.only?.split(",") ?? SCENARIOS;
  const names = flags.libnames?.split(",") ?? Object.keys(LIBS);
  for (const scenario of scenarios) {
    console.log(`\n## ${scenario}`);
    for (const name of names) {
      const samples = {};
      let skipped = false;
      for (let i = 0; i < runs; i++) {
        const r = spawnSync(
          process.execPath,
          ["--expose-gc", fileURLToPath(import.meta.url), "run", scenario, name, libs, dist, work],
          { encoding: "utf8", maxBuffer: 1 << 24 },
        );
        if (r.status !== 0) {
          console.log(`${name.padEnd(18)} FAILED: ${r.stderr.trim().split("\n").at(-1)}`);
          skipped = true;
          break;
        }
        const out = JSON.parse(r.stdout.trim().split("\n").at(-1));
        if (!out) {
          console.log(`${name.padEnd(18)} n/a (no initial scan)`);
          skipped = true;
          break;
        }
        for (const [k, v] of Object.entries(out)) (samples[k] ??= []).push(v);
      }
      if (skipped) continue;
      console.log(
        `${name.padEnd(18)} ` +
          Object.entries(samples)
            .map(([k, v]) => `${k}=${median(v).toFixed(NOT_A_COST.has(k) ? 0 : 1)}`)
            .join("  "),
      );
    }
  }
}
