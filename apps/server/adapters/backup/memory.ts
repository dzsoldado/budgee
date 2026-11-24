import type { BackupDestination } from "../../src/ports";

export interface MemoryBackup extends BackupDestination {
  /** The stored files by name, for tests to inspect. */
  readonly files: Map<string, Uint8Array>;
}

/** A BackupDestination held in memory: the fake for tests. */
export function memoryBackup(names: Iterable<string> = []): MemoryBackup {
  const files = new Map<string, Uint8Array>();
  for (const name of names) files.set(name, new Uint8Array());
  return {
    kind: "memory",
    files,
    async put(name, bytes) {
      files.set(name, bytes.slice());
    },
    async list() {
      return [...files.keys()];
    },
    async remove(name) {
      files.delete(name);
    },
  };
}
