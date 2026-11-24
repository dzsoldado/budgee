import type { SettingValues } from "@budgee/core";
import { type Accessor, createContext, type ParentProps, useContext } from "solid-js";
import type { LiveFile } from "./csv/live-file";
import type { BudgeeDb } from "./db/db";
import type { Repository } from "./db/repository";
import type { Formatters } from "./i18n/format";
import type { Platform } from "./platform/types";
import type { SyncController } from "./sync/controller";

export interface AppContextValue {
  db: BudgeeDb;
  /** The only way to write synced rows. */
  repo: Repository;
  platform: Platform;
  /** Starts a sync ("sync now"); the status is in sync/status. */
  sync: SyncController;
  settings: Accessor<SettingValues>;
  format: Formatters;
  /** The local CSV file; undefined where the browser can't keep one (not desktop Chromium). */
  liveFile: LiveFile | undefined;
}

const AppContext = createContext<AppContextValue>();

export function AppProvider(props: ParentProps<{ value: AppContextValue }>) {
  return <AppContext.Provider value={props.value}>{props.children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const app = useContext(AppContext);
  if (!app) throw new Error("useApp outside AppProvider");
  return app;
}
