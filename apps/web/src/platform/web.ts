import {
  createBackupApi,
  createDeviceApi,
  createHttpTransport,
  type HttpFetch,
} from "@budgee/core";
import { type BudgeeDb, deleteMeta, getMeta, setMeta } from "../db/db";
import type { OutgoingFile, Platform, SyncTransport } from "./types";

const toBlob = ({ data, type }: OutgoingFile) =>
  data instanceof Blob ? data : new Blob([data], { type });

/** Never answered from the HTTP cache. */
const noStore: HttpFetch = (url, init) => fetch(url, { ...init, cache: "no-store" });

export function createWebPlatform(db: BudgeeDb): Platform {
  return {
    storage: {
      get: (key) => getMeta(db, key),
      set: (key, value) => setMeta(db, key, value),
      delete: (key) => deleteMeta(db, key),
      async persist() {
        if (!navigator.storage?.persist) return false;
        return (await navigator.storage.persisted()) || navigator.storage.persist();
      },
    },

    fileExport: {
      async save(file) {
        const url = URL.createObjectURL(toBlob(file));
        const link = document.createElement("a");
        link.href = url;
        link.download = file.name;
        link.click();
        // Give the download a moment to start before the URL goes away.
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      },
    },

    share: {
      canShareFiles() {
        const probe = new File([""], "probe.txt", { type: "text/plain" });
        return typeof navigator.canShare === "function" && navigator.canShare({ files: [probe] });
      },
      async shareFile(file, title) {
        const shared = new File([toBlob(file)], file.name, { type: file.type });
        try {
          await navigator.share({ files: [shared], ...(title ? { title } : {}) });
          return true;
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") return false;
          throw error;
        }
      },
    },

    createSyncTransport({ serverUrl, deviceToken }): SyncTransport {
      return createHttpTransport({ serverUrl, token: deviceToken, fetch: noStore });
    },

    createDeviceApi({ serverUrl, deviceToken }) {
      return createDeviceApi({ serverUrl, token: deviceToken, fetch: noStore });
    },

    createBackupApi({ serverUrl, deviceToken }) {
      return createBackupApi({ serverUrl, token: deviceToken, fetch: noStore });
    },
  };
}
