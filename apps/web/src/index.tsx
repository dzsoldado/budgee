import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/space-grotesk/700.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/shell.css";
import "./styles/list.css";
import "./styles/entry.css";
import "./styles/settings.css";
import "./styles/pairing.css";
import "./styles/dashboard.css";
import "./styles/chart-editor.css";
import "./styles/csv.css";
import { render } from "solid-js/web";
import { App } from "./App";
import { csvText, loadAllEntries } from "./csv/export";
import { createLiveFile, entryChanges, isLiveFileSupported } from "./csv/live-file";
import { BudgeeDb, deleteMeta, getMeta, setMeta } from "./db/db";
import { openRepository } from "./db/repository";
import { seedDefaults } from "./db/seed";
import { readSettings } from "./db/settings";
import { t } from "./i18n";
import { createWebPlatform } from "./platform/web";
import { createSyncController } from "./sync/controller";

async function start(root: HTMLElement) {
  const db = new BudgeeDb();
  const repo = await openRepository(db);
  await seedDefaults(db);
  const platform = createWebPlatform(db);
  void platform.storage.persist().catch(() => false);

  if (import.meta.env.DEV) {
    const { loadDemoFromUrl } = await import("./dev/demo");
    await loadDemoFromUrl(db, repo);
  }

  const initialSettings = await readSettings(db);
  const sync = createSyncController({ db, repo, platform });
  // Rewritten after every change to the entries, local or pulled by a sync.
  const liveFile = isLiveFileSupported()
    ? createLiveFile({
        store: {
          load: () => getMeta(db, "csvFile"),
          save: (handle) => setMeta(db, "csvFile", handle),
          clear: () => deleteMeta(db, "csvFile"),
        },
        content: async () => csvText(await loadAllEntries(db), "full"),
        subscribe: entryChanges(repo),
      })
    : undefined;
  // Leaving the page: write a change still waiting for its debounce.
  const flushLiveFile = () => void liveFile?.flush();
  window.addEventListener("pagehide", flushLiveFile);
  render(
    () => (
      <App
        db={db}
        repo={repo}
        platform={platform}
        sync={sync}
        liveFile={liveFile}
        initialSettings={initialSettings}
      />
    ),
    root,
  );
  const stopSync = sync.start();
  void liveFile?.start();
  // In dev, a hot update reruns this module: unhook the old triggers first.
  import.meta.hot?.dispose(() => {
    stopSync();
    liveFile?.dispose();
    window.removeEventListener("pagehide", flushLiveFile);
  });
}

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing from index.html");
// IndexedDB can be missing or blocked (some private windows): say so instead of a blank page.
start(root).catch((error: unknown) => {
  console.error("Budgee could not start", error);
  const message = document.createElement("p");
  message.className = "boot-error";
  message.setAttribute("role", "alert");
  message.textContent = t("app.storageUnavailable");
  root.replaceChildren(message);
});
