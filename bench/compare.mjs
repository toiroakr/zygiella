// Prints two results of run.mjs side by side: node bench/compare.mjs before.json after.json
// Every metric is lower-is-better; a change under NOISE is not marked.
import { readFileSync } from "node:fs";

const [beforeFile, afterFile] = process.argv.slice(2);
if (!beforeFile || !afterFile)
  throw new Error("usage: node bench/compare.mjs before.json after.json");
const before = JSON.parse(readFileSync(beforeFile, "utf8"));
const after = JSON.parse(readFileSync(afterFile, "utf8"));
const NOISE = 0.05;

const rows = [];
const add = (group, metric, a, b) => {
  if (a === undefined || b === undefined) return;
  rows.push({ group, metric, a, b });
};
for (const key of ["totalBytes", "totalGzip", "totalBrotli", "tarballBytes", "unpackedBytes"])
  add("size", key, before.size[key], after.size[key]);
for (const key of Object.keys(before.load)) add("load", key, before.load[key], after.load[key]);
for (const [name, metrics] of Object.entries(before.scenarios))
  for (const [key, value] of Object.entries(metrics))
    add(name, key, value.median, after.scenarios[name]?.[key]?.median);

const fmt = (n) =>
  Math.abs(n) >= 1000 ? n.toFixed(0) : Math.abs(n) >= 10 ? n.toFixed(1) : n.toFixed(2);
const width = Math.max(...rows.map((r) => `${r.group}.${r.metric}`.length));
let worse = 0;
for (const { group, metric, a, b } of rows) {
  const change = a === 0 ? 0 : (b - a) / a;
  const mark = change > NOISE ? "  WORSE" : change < -NOISE ? "  better" : "";
  if (change > NOISE) worse++;
  console.log(
    `${`${group}.${metric}`.padEnd(width)}  ${fmt(a).padStart(10)} -> ${fmt(b).padStart(10)}  ${(change * 100).toFixed(1).padStart(7)}%${mark}`,
  );
}
if (worse) console.log(`\n${worse} metric(s) worse than ${NOISE * 100}%`);
