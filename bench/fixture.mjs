// Builds directory trees for the benchmarks. Synchronous on purpose: it is never timed.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** `dirs` directories (a tree with the given fan-out and depth) holding `perDir` files each, at every leaf. */
export function tree(root, { fanout, depth, perDir }) {
  let dirs = 0;
  let files = 0;
  const fill = (dir, level) => {
    if (level === depth) {
      for (let i = 0; i < perDir; i++) {
        writeFileSync(join(dir, `f${i}.txt`), `${level}:${i}`);
        files++;
      }
      return;
    }
    for (let i = 0; i < fanout; i++) {
      const sub = join(dir, `d${i}`);
      mkdirSync(sub);
      dirs++;
      fill(sub, level + 1);
    }
  };
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  fill(root, 0);
  return { dirs, files };
}

/** One directory with `count` files. */
export function wide(root, count, prefix = "f") {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  for (let i = 0; i < count; i++) writeFileSync(join(root, `${prefix}${i}.txt`), String(i));
  return { dirs: 0, files: count };
}
