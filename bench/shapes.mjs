import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as sp from "node:path";
const [file, shape] = process.argv.slice(2);
const root = await mkdtemp(sp.join(tmpdir(), "shapes-"));
const dirOf = (d) =>
  shape === "wide"
    ? sp.join(root, `wide-${d}`)
    : shape === "deep"
      ? sp.join(root, ...Array.from({ length: Math.min(d + 1, 64) }, (_, p) => `deep-${p}`))
      : sp.join(root, `balanced-${d % 100}`, `leaf-${Math.floor(d / 100)}`);
for (let d = 0; d < 200; d++) {
  const dir = dirOf(d);
  await mkdir(dir, { recursive: true });
  await Promise.all(
    Array.from({ length: 100 }, (_, i) => writeFile(sp.join(dir, `f${i}.txt`), "seed")),
  );
}
const lib = await import(file);
global.gc();
const base = process.memoryUsage().rss;
const t = performance.now();
const cpu0 = process.cpuUsage();
const w = lib.watch(root, { atomic: false });
const counts = {};
w.on("all", (e) => (counts[e] = (counts[e] ?? 0) + 1));
await new Promise((r) => w.once("ready", r));
const ms = Math.round(performance.now() - t);
const c = process.cpuUsage(cpu0);
const cpuMs = Math.round((c.user + c.system) / 1000);
global.gc();
console.log(
  `${shape.padEnd(9)} ready=${String(ms).padStart(5)}ms cpu=${String(cpuMs).padStart(5)}ms rss=+${Math.round((process.memoryUsage().rss - base) / 1048576)}MB events=${JSON.stringify(counts)}`,
);
await w.close();
await rm(root, { recursive: true, force: true });
