import { expect, test } from "vitest";
import { trackMoves } from "../src/moves.ts";
import type { Entry } from "../src/types.ts";

const file = (ino: number, over: Partial<Entry> = {}): Entry => ({
  dir: false,
  mtimeMs: 1000,
  size: 5,
  ino,
  dev: 1,
  ...over,
});

test("a removal and an addition of the same inode on the same device are one move, in either order", () => {
  const moves = trackMoves();
  expect(moves.removed("/w/a", file(7))).toBeUndefined();
  expect(moves.added("/w/b", file(7))).toBe("/w/a");
  expect(moves.added("/w/d", file(8))).toBeUndefined();
  expect(moves.removed("/w/c", file(8))).toBe("/w/d");
});

test("the same inode number on another device is another file", () => {
  const moves = trackMoves();
  moves.removed("/w/a", file(7, { dev: 1 }));
  expect(moves.added("/mnt/b", file(7, { dev: 2 }))).toBeUndefined();
});

test("records of the same inode number on two devices do not overwrite each other", () => {
  const moves = trackMoves();
  moves.removed("/w/a", file(7, { dev: 1 }));
  moves.removed("/mnt/x", file(7, { dev: 2 }));
  expect(moves.added("/w/b", file(7, { dev: 1 }))).toBe("/w/a");
  expect(moves.added("/mnt/y", file(7, { dev: 2 }))).toBe("/mnt/x");
});

test("a file whose device is not known is never paired", () => {
  const moves = trackMoves();
  moves.removed("/w/a", file(7, { dev: undefined }));
  expect(moves.added("/w/b", file(7, { dev: undefined }))).toBeUndefined();
});

test("a match leaves no older record of the inode, so a second move starts clean", () => {
  const moves = trackMoves();
  moves.removed("/w/a", file(7));
  moves.removed("/w/b", file(7));
  expect(moves.added("/w/c", file(7))).toBe("/w/b");
  moves.removed("/w/c", file(7));
  expect(moves.added("/w/d", file(7))).toBe("/w/c");
});

test("a record older than a second is not paired", () => {
  let now = 0;
  const moves = trackMoves(() => now);
  moves.removed("/w/a", file(7));
  now = 1001;
  expect(moves.added("/w/b", file(7))).toBeUndefined();
});

test("a file with another size or mtime, or a directory, is not paired", () => {
  const moves = trackMoves();
  moves.removed("/w/a", file(7));
  expect(moves.added("/w/b", file(7, { size: 6 }))).toBeUndefined();
  moves.removed("/w/c", file(9));
  expect(moves.added("/w/d", file(9, { mtimeMs: 2000 }))).toBeUndefined();
  moves.removed("/w/e", file(11, { dir: true }));
  expect(moves.added("/w/f", file(11, { dir: true }))).toBeUndefined();
});

test("many unmatched observations are expired in one pass, not once per observation", () => {
  let now = 0;
  const moves = trackMoves(() => now);
  const started = performance.now();
  for (let ino = 1; ino <= 100_000; ino++) moves.added(`/w/${ino}`, file(ino));
  expect(performance.now() - started).toBeLessThan(1000);
  now = 5000;
  expect(moves.removed("/w/x", file(1))).toBeUndefined();
});

test("a file that was added and then removed at the same path is not what a later removal pairs with", () => {
  const moves = trackMoves();
  moves.added("/w/d", file(7));
  moves.removed("/w/d", file(7));
  expect(moves.removed("/w/s", file(7))).toBeUndefined();
});

test("a file that was removed and then added at the same path is not what a later addition pairs with", () => {
  const moves = trackMoves();
  moves.removed("/w/d", file(7));
  moves.added("/w/d", file(7));
  expect(moves.added("/w/s", file(7))).toBeUndefined();
});
