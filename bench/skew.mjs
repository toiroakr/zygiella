import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as sp from "node:path";
const [file, small] = process.argv.slice(2);
const root = await mkdtemp(sp.join(tmpdir(), "skew-"));
// the big directory sorts first, so a worker takes it while the 255 others hold the budget on the small ones
await mkdir(sp.join(root, "0big"));
for (let i = 0; i < 20000; i += 500)
  await Promise.all(
    Array.from({ length: 500 }, (_, j) => writeFile(sp.join(root, "0big", `f${i + j}`), "1")),
  );
for (let d = 0; d < +small; d++) {
  await mkdir(sp.join(root, `s${String(d).padStart(4, "0")}`));
  await writeFile(sp.join(root, `s${String(d).padStart(4, "0")}`, "a"), "1");
}
const lib = await import(file);
const t = performance.now();
const w = lib.watch(root, { atomic: false });
const counts = {};
w.on("all", (e) => (counts[e] = (counts[e] ?? 0) + 1));
await new Promise((r) => w.once("ready", r));
console.log(
  `small=${small} ready=${Math.round(performance.now() - t)}ms events=${JSON.stringify(counts)}`,
);
await w.close();
await rm(root, { recursive: true, force: true });
