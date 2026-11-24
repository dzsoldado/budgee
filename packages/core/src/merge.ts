// Per-row last-writer-wins: the higher hlc wins, compared as plain text. Tombstones are
// ordinary rows (`deleted: true`) and win or lose by hlc like any edit. Equal hlcs are the
// same change, so nothing is applied, which makes merging idempotent.

export interface Versioned {
  hlc: string;
}

export function shouldApply(local: Versioned | undefined, incoming: Versioned): boolean {
  return local === undefined || incoming.hlc > local.hlc;
}

export function mergeRow<T extends Versioned>(local: T | undefined, incoming: T): T {
  return local === undefined || shouldApply(local, incoming) ? incoming : local;
}
