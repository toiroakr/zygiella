// Runs the scenarios against two builds, alternating A and B in every round so that drift of the machine hits both
// the same way, and prints the median of each metric:
//   node bench/ab.mjs <dist A> <dist B> [--runs 9] [--only scan-tree,bulk-unlink]
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [a, b, ...rest] = process.argv.slice(2);
if (!a || !b) throw new Error("usage: node bench/ab.mjs <dist A> <dist B> [--runs 9] [--only a,b]");
const flags = Object.fromEntries(
  rest.flatMap((arg, i) => (arg.startsWith("--") ? [[arg.slice(2), rest[i + 1]]] : [])),
);
const runs = Number(flags.runs ?? 9);
const names = (
  flags.only ??
  "scan-tree,scan-wide,scan-tree-quiet,scan-tree-ignored,rescan,bulk-unlink,bulk-add,remove-directory,rename-burst,change-latency,add-latency,snapshot,many-watchers"
).split(",");
const NOT_A_COST = new Set(["files", "entries", "paired"]);
const work = join(tmpdir(), "zygiella-bench-ab");
mkdirSync(work, { recursive: true });

const median = (values) => {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const once = (name, dist) => {
  const result = spawnSync(
    process.execPath,
    ["--expose-gc", join(here, "scenario.mjs"), name, join(resolve(dist), "index.mjs"), work],
    { encoding: "utf8", maxBuffer: 1 << 24 },
  );
  if (result.status !== 0) throw new Error(`${name} failed:\n${result.stderr}`);
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
};
const fmt = (n) =>
  Math.abs(n) >= 1000 ? n.toFixed(0) : Math.abs(n) >= 10 ? n.toFixed(1) : n.toFixed(2);

for (const name of names) {
  const samples = { A: {}, B: {} };
  for (let i = 0; i < runs; i++) {
    for (const [label, dist] of i % 2
      ? [
          ["B", b],
          ["A", a],
        ]
      : [
          ["A", a],
          ["B", b],
        ]) {
      for (const [key, value] of Object.entries(once(name, dist)))
        if (!NOT_A_COST.has(key)) (samples[label][key] ??= []).push(value);
    }
  }
  for (const key of Object.keys(samples.A)) {
    const x = median(samples.A[key]);
    const y = median(samples.B[key]);
    const change = x === 0 ? 0 : (y - x) / x;
    const mark = change > 0.05 ? "  WORSE" : change < -0.05 ? "  better" : "";
    console.log(
      `${`${name}.${key}`.padEnd(34)} ${fmt(x).padStart(9)} -> ${fmt(y).padStart(9)} ${(change * 100).toFixed(1).padStart(7)}%${mark}`,
    );
  }
}
rmSync(work, { recursive: true, force: true });
