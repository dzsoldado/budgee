// Category rows in their Settings order.

interface Ordered {
  id: string;
  deleted: false;
  name: string;
  sort: number;
}

/** Live rows by `sort`, then name. Archived rows stay: old entries still use them. */
export function sortByOrder<T extends { deleted: boolean }>(
  rows: readonly T[],
): Extract<T, Ordered>[] {
  return rows
    .filter((row): row is Extract<T, Ordered> => !row.deleted)
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
}
