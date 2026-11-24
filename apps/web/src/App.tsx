import type { SettingValues } from "@budgee/core";
import { HashRouter, Navigate, Route } from "@solidjs/router";
import { createEffect, lazy } from "solid-js";
import { AppProvider } from "./context";
import type { LiveFile } from "./csv/live-file";
import type { BudgeeDb } from "./db/db";
import type { Repository } from "./db/repository";
import { createSettings } from "./db/settings";
import { createFormatters } from "./i18n/format";
import type { Platform } from "./platform/types";
import { AddScreen, EditScreen } from "./screens/entry/EntryScreen";
import { ListScreen } from "./screens/list/ListScreen";
import { ConnectScreen } from "./screens/settings/ConnectScreen";
import { ImportScreen } from "./screens/settings/import/ImportScreen";
import { CategoriesScreen } from "./screens/settings/ListScreens";
import { PairScreen } from "./screens/settings/PairScreen";
import { RestoreBackupScreen } from "./screens/settings/RestoreBackupScreen";
import { RestoreScreen } from "./screens/settings/RestoreScreen";
import { SettingsScreen } from "./screens/settings/SettingsScreen";
import { TagsScreen } from "./screens/settings/TagsScreen";
import { Shell } from "./shell/Shell";
import type { SyncController } from "./sync/controller";
import { applyTheme, createSystemDark, resolveTheme } from "./theme";

const Gallery = import.meta.env.DEV ? lazy(() => import("./dev/Gallery")) : undefined;
// Its own chunk, with Chart.js.
const DashboardScreen = lazy(() =>
  import("./screens/dashboard/DashboardScreen").then((m) => ({ default: m.DashboardScreen })),
);
const AddChartScreen = lazy(() =>
  import("./screens/dashboard/AddChartScreen").then((m) => ({ default: m.AddChartScreen })),
);
const ChartEditScreen = lazy(() =>
  import("./screens/dashboard/ChartEditScreen").then((m) => ({ default: m.ChartEditScreen })),
);

export interface AppProps {
  db: BudgeeDb;
  repo: Repository;
  platform: Platform;
  sync: SyncController;
  liveFile: LiveFile | undefined;
  /** Settings read before the first render, so the first frame has the right theme. */
  initialSettings: SettingValues;
}

export function App(props: AppProps) {
  const settings = createSettings(props.db, props.initialSettings);
  const systemDark = createSystemDark();
  createEffect(() => applyTheme(resolveTheme(settings().theme, systemDark())));
  createEffect(() => {
    document.documentElement.lang = settings().locale;
  });

  const app = {
    db: props.db,
    repo: props.repo,
    platform: props.platform,
    sync: props.sync,
    settings,
    format: createFormatters(settings),
    liveFile: props.liveFile,
  };

  // Hash routes (`#/settings`): the server's Google callback returns to `/#/settings?drive=…`.
  return (
    <AppProvider value={app}>
      <HashRouter root={Shell}>
        <Route path="/" component={ListScreen} />
        <Route path="/add" component={AddScreen} />
        <Route path="/edit/:id" component={EditScreen} />
        <Route path="/dashboard" component={DashboardScreen} />
        <Route path="/dashboard/add" component={AddChartScreen} />
        {/* `new?template=<key>` (or `blank`) starts a chart from the gallery. */}
        <Route path="/dashboard/chart/:id" component={ChartEditScreen} />
        <Route path="/settings" component={SettingsScreen} />
        <Route path="/settings/categories" component={CategoriesScreen} />
        <Route path="/settings/tags" component={TagsScreen} />
        <Route path="/settings/connect" component={ConnectScreen} />
        <Route path="/settings/restore" component={RestoreScreen} />
        <Route path="/settings/restore-backup" component={RestoreBackupScreen} />
        {/* `?from=list` when opened from the List, which Back then returns to. */}
        <Route path="/settings/import" component={ImportScreen} />
        {/* Pairing links open here: <origin>/#/pair?c=…&k=…&s=… */}
        <Route path="/pair" component={PairScreen} />
        {Gallery && <Route path="/dev/components" component={Gallery} />}
        <Route path="*" component={() => <Navigate href="/" />} />
      </HashRouter>
    </AppProvider>
  );
}
