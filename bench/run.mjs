// Measures the built package: install size, import cost, and the scenarios of scenario.mjs, each in a fresh process.
//   node bench/run.mjs [--dist dist] [--runs 5] [--only scan-tree,bulk-unlink] [--out bench/results/name.json]
// Every number is lower-is-better. Compare two results with `node bench/compare.mjs a.json b.json`.
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { brotliCompressSync, gunzipSync, gzipSync } from "node:zlib";
import { parseFlags, parseList } from "./args.mjs";
import { SCENARIOS } from "./scenarios.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = parseFlags(process.argv.slice(2), ["dist", "runs", "only", "out"]);
const dist = resolve(args.dist ?? join(here, "..", "dist"));
const runs = Number(args.runs ?? 5);
if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be an integer of 1 or more");
const work = mkdtempSync(join(tmpdir(), "zygiella-bench-"));
const entry = join(dist, "index.mjs");

const only = parseList(args.only, SCENARIOS, "--only");
// numbers that describe the fixture or check the result, not a cost
const NOT_A_COST = new Set(["files", "entries", "paired"]);

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const summarize = (values) => ({
  median: median(values),
  min: Math.min(...values),
  max: Math.max(...values),
});

// the sum of the file sizes in a .tgz, read from its tar headers (pnpm pack does not report it)
function unpackedSize(tgz) {
  const tar = gunzipSync(tgz);
  let total = 0;
  for (let at = 0; at + 512 <= tar.length && tar[at] !== 0;) {
    const size = parseInt(tar.toString("ascii", at + 124, at + 136).trim(), 8);
    total += size;
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return total;
}

function sizes() {
  const files = readdirSync(dist).filter((name) => statSync(join(dist, name)).isFile());
  const out = { files: {}, totalBytes: 0, totalGzip: 0, totalBrotli: 0 };
  for (const name of files) {
    const content = readFileSync(join(dist, name));
    const gzip = gzipSync(content, { level: 9 }).length;
    const brotli = brotliCompressSync(content).length;
    out.files[name] = { bytes: content.length, gzip, brotli };
    out.totalBytes += content.length;
    out.totalGzip += gzip;
    out.totalBrotli += brotli;
  }
  // what npm would publish, when the dist is the one of this package
  if (dist === resolve(here, "..", "dist")) {
    const root = resolve(here, "..");
    const target = mkdtempSync(join(tmpdir(), "zygiella-bench-pack-"));
    try {
      const output = execFileSync(
        "pnpm",
        [
          "pack",
          "--json",
          "--ignore-scripts",
          "--pack-destination",
          process.platform === "win32" ? `"${target}"` : target,
        ],
        {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          shell: process.platform === "win32",
        },
      );
      // lifecycle scripts such as `prepare` may print before the JSON
      const pack = JSON.parse(output.slice(output.indexOf("{")));
      out.tarballBytes = statSync(pack.filename).size;
      out.unpackedBytes = unpackedSize(readFileSync(pack.filename));
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  }
  return out;
}

// wall time of `node -e import(...)` above the time of an empty script, and the RSS the import adds
function importCost() {
  const time = (code) => {
    const start = process.hrtime.bigint();
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(result.stderr);
    return { ms: Number(process.hrtime.bigint() - start) / 1e6, out: result.stdout };
  };
  const empty = [];
  const loaded = [];
  const rss = [];
  const url = JSON.stringify(pathToFileURL(entry).href);
  for (let i = 0; i < Math.max(9, runs * 2); i++) {
    empty.push(time("0").ms);
    const run = time(
      `const before = process.memoryUsage().rss; await import(${url}); console.log(process.memoryUsage().rss - before)`,
    );
    loaded.push(run.ms);
    rss.push(Number(run.out) / 1024);
  }
  return { importMs: Math.max(0, median(loaded) - median(empty)), importRssKB: median(rss) };
}

function scenario(name) {
  const samples = {};
  for (let i = 0; i < runs; i++) {
    const result = spawnSync(
      process.execPath,
      ["--expose-gc", join(here, "scenario.mjs"), name, entry, work],
      { encoding: "utf8", maxBuffer: 1 << 24 },
    );
    if (result.status !== 0) throw new Error(`${name} failed:\n${result.stderr}`);
    for (const [key, value] of Object.entries(
      JSON.parse(result.stdout.trim().split("\n").at(-1)),
    )) {
      if (!NOT_A_COST.has(key)) (samples[key] ??= []).push(value);
    }
  }
  return Object.fromEntries(
    Object.entries(samples).map(([key, values]) => [key, summarize(values)]),
  );
}

function safeRead(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

// with --only and an existing --out, the scenarios that are not run again keep their numbers, so a long run can be split
const previous = args.out && only ? safeRead(resolve(args.out)) : undefined;
for (const key of ["node", "platform", "arch", "runs"])
  if (
    previous &&
    previous.meta?.[key] !==
      (key === "node" ? process.version : key === "runs" ? runs : process[key])
  )
    throw new Error(
      `${args.out} was measured with another ${key} (${previous.meta?.[key]}), so its numbers cannot be kept next to these`,
    );
const result = {
  meta: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    runs,
    date: new Date().toISOString(),
  },
  size: sizes(),
  load: importCost(),
  scenarios: { ...previous?.scenarios },
};
for (const name of SCENARIOS) {
  if (only && !only.includes(name)) continue;
  process.stderr.write(`${name} `);
  result.scenarios[name] = scenario(name);
  process.stderr.write("done\n");
}
rmSync(work, { recursive: true, force: true });
const text = JSON.stringify(result, null, 2) + "\n";
if (args.out) {
  mkdirSync(dirname(resolve(args.out)), { recursive: true });
  writeFileSync(args.out, text);
}
process.stdout.write(text);
