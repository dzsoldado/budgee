import { describe, expect, test } from "bun:test";
import { formatHlc } from "../src/hlc";
import { mergeRow, shouldApply } from "../src/merge";

interface Row {
  id: string;
  hlc: string;
  deleted: boolean;
  device: string;
  amount?: number;
}

const ID = "6f1c2c1e-6b8a-4f57-9d0c-3f7f2a1d9e01";
const hlc = (wall: number, counter: number, device: string) => formatHlc({ wall, counter, device });

const edit = (wall: number, counter: number, device: string, amount: number): Row => ({
  id: ID,
  hlc: hlc(wall, counter, device),
  deleted: false,
  device,
  amount,
});

const tombstone = (wall: number, counter: number, device: string): Row => ({
  id: ID,
  hlc: hlc(wall, counter, device),
  deleted: true,
  device,
});

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

const fold = (rows: Row[], start?: Row) =>
  rows.reduce<Row | undefined>((local, incoming) => mergeRow(local, incoming), start);

describe("shouldApply", () => {
  test("applies when there is no local row", () => {
    expect(shouldApply(undefined, edit(1, 0, "a", 1))).toBe(true);
  });

  test("applies only a strictly higher hlc", () => {
    expect(shouldApply(edit(1, 0, "a", 1), edit(2, 0, "a", 2))).toBe(true);
    expect(shouldApply(edit(2, 0, "a", 2), edit(1, 0, "a", 1))).toBe(false);
    expect(shouldApply(edit(2, 0, "a", 2), edit(2, 0, "a", 2))).toBe(false);
  });
});

describe("higher hlc wins in any arrival order", () => {
  const rows = [
    edit(100, 0, "a", 1),
    edit(100, 1, "a", 2),
    edit(200, 0, "b", 3),
    edit(150, 9, "c", 4),
  ];

  test("every permutation converges on the highest hlc", () => {
    for (const order of permutations(rows)) {
      expect(fold(order)).toEqual(edit(200, 0, "b", 3));
    }
  });

  test("a local row with a higher hlc is kept", () => {
    const local = edit(300, 0, "z", 9);
    expect(fold(rows, local)).toBe(local);
  });
});

describe("applying a change twice is harmless", () => {
  test("merging the same row again changes nothing", () => {
    const row = edit(100, 0, "a", 1);
    const once = mergeRow(undefined, row);
    const twice = mergeRow(once, row);
    expect(twice).toEqual(once);
    expect(twice).toBe(once); // the local row stays, nothing is rewritten
  });

  test("replaying a whole history in any order gives the same result", () => {
    const history = [edit(1, 0, "a", 1), edit(2, 0, "b", 2), tombstone(3, 0, "a")];
    const expected = fold(history);
    for (const order of permutations([...history, ...history])) {
      expect(fold(order)).toEqual(expected);
    }
  });
});

describe("tombstones", () => {
  test("a tombstone beats an older edit in either arrival order", () => {
    const older = edit(100, 0, "a", 1);
    const del = tombstone(200, 0, "b");
    expect(fold([older, del])).toEqual(del);
    expect(fold([del, older])).toEqual(del);
  });

  test("a tombstone is an ordinary row: a newer edit beats it", () => {
    const del = tombstone(200, 0, "b");
    const newer = edit(300, 0, "a", 5);
    expect(fold([del, newer])).toEqual(newer);
    expect(fold([newer, del])).toEqual(newer);
  });
});

describe("ties are broken by device id", () => {
  test("same wall time and counter: the higher device id wins in either order", () => {
    const fromA = edit(500, 3, "device-a", 1);
    const fromB = edit(500, 3, "device-b", 2);
    expect(fold([fromA, fromB])).toEqual(fromB);
    expect(fold([fromB, fromA])).toEqual(fromB);
  });

  test("a tie between an edit and a tombstone is decided the same way", () => {
    const del = tombstone(500, 3, "device-a");
    const upd = edit(500, 3, "device-b", 2);
    expect(fold([del, upd])).toEqual(upd);
    expect(fold([upd, del])).toEqual(upd);
  });
});
