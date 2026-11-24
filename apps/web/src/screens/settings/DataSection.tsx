// Settings → Your data (Settings.dc.html): Import CSV opens the import wizard, Export CSV the
// export dialog, and on desktop Chrome and Edge the live CSV file row picks, pauses or stops the
// file kept up to date. Where the browser can't keep a file, that row is not shown.
import { A, useSearchParams } from "@solidjs/router";
import { createEffect, createSignal, Match, Show, Switch } from "solid-js";
import { useApp } from "../../context";
import { type LiveFile, pickLiveFile } from "../../csv/live-file";
import { t } from "../../i18n";
import { DownloadIcon, FileIcon, UploadIcon } from "../../shell/icons";
import { announce, createNow, timeAgo } from "../../sync/status";
import { ExportDialog } from "./ExportDialog";

function LiveFileRow(props: { file: LiveFile }) {
  const { settings } = useApp();
  const now = createNow();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const state = () => props.file.state();
  const name = () => {
    const current = state();
    return "name" in current ? current.name : "";
  };

  const act = async (task: () => Promise<void>) => {
    if (busy()) return;
    setBusy(true);
    setError(undefined);
    try {
      await task();
    } finally {
      setBusy(false);
    }
  };

  const choose = () =>
    act(async () => {
      try {
        const handle = await pickLiveFile(t("liveFile.suggestedName"), t("liveFile.pickType"));
        if (!handle) return;
        await props.file.use(handle);
        announce(t("liveFile.started", { name: handle.name }));
      } catch (failure) {
        console.error("Choosing the CSV file failed", failure);
        setError(t("liveFile.pickFailed"));
      }
    });
  const allow = () =>
    act(async () => {
      if (!(await props.file.allow()) && state().kind === "paused") setError(t("liveFile.denied"));
    });
  const stop = () =>
    act(async () => {
      const stopped = name();
      try {
        await props.file.stop();
        announce(t("liveFile.stopped", { name: stopped }));
      } catch (failure) {
        // The choice may still be stored: show what is there now.
        console.error("Forgetting the CSV file failed", failure);
        setError(t("liveFile.stopFailed"));
        await props.file.start();
      }
    });

  const meta = () => {
    const current = state();
    switch (current.kind) {
      case "on":
        return current.writtenAt === undefined
          ? t("liveFile.writing", { name: current.name })
          : t("liveFile.on", {
              name: current.name,
              when: timeAgo(current.writtenAt, now(), settings().locale).long,
            });
      case "paused":
        return t("liveFile.paused", { name: current.name });
      case "failed":
        return t("liveFile.failed", { name: current.name });
      default:
        return t("settings.liveCsvOff");
    }
  };

  return (
    <div class="settings-action live-file" aria-busy={state().kind === "loading"}>
      <FileIcon size={18} />
      <span class="settings-item-text live-file-text">
        <span class="settings-item-name">{t("settings.liveCsv")}</span>
        <span
          class="settings-item-meta"
          classList={{ "live-file-problem": state().kind === "failed" }}
        >
          {meta()}
        </span>
        <Show when={error()}>
          <span class="field-error" role="alert">
            {error()}
          </span>
        </Show>
      </span>
      <span class="live-file-actions">
        <Switch>
          <Match when={state().kind === "off"}>
            <button
              type="button"
              class="btn btn-secondary settings-small-btn"
              aria-busy={busy()}
              disabled={busy()}
              onClick={choose}
            >
              {t("liveFile.choose")}
            </button>
          </Match>
          <Match when={state().kind === "paused"}>
            <button
              type="button"
              class="btn btn-primary settings-small-btn"
              aria-label={t("liveFile.allowLabel", { name: name() })}
              disabled={busy()}
              onClick={allow}
            >
              {t("liveFile.allow")}
            </button>
          </Match>
          <Match when={state().kind === "failed"}>
            <button
              type="button"
              class="btn btn-secondary settings-small-btn"
              disabled={busy()}
              onClick={() => act(() => props.file.retry())}
            >
              {t("liveFile.retry")}
            </button>
          </Match>
        </Switch>
        <Show when={state().kind !== "off" && state().kind !== "loading"}>
          <button
            type="button"
            class="settings-quiet-btn"
            aria-label={t("liveFile.stopLabel", { name: name() })}
            disabled={busy()}
            onClick={stop}
          >
            {t("liveFile.stop")}
          </button>
        </Show>
      </span>
    </div>
  );
}

export function DataSection() {
  const { liveFile } = useApp();
  const [exporting, setExporting] = createSignal(false);
  const [params, setParams] = useSearchParams();
  let section!: HTMLElement;

  // The Settings nav item points here (`?section=data`) while the live file needs attention.
  createEffect(() => {
    if (params.section !== "data") return;
    setParams({ section: undefined }, { replace: true });
    // After the router's own scroll to the top of the new screen.
    requestAnimationFrame(() => setTimeout(() => section.scrollIntoView({ block: "start" }), 0));
  });

  return (
    <section class="section" aria-labelledby="settings-data" ref={section}>
      <h2 id="settings-data" class="section-title">
        {t("settings.data")}
      </h2>

      <div class="settings-card">
        <A href="/settings/import" class="settings-action">
          <UploadIcon size={18} />
          <span class="settings-item-text">
            <span class="settings-item-name">{t("settings.importCsv")}</span>
            <span class="settings-item-meta">{t("settings.importCsvMeta")}</span>
          </span>
        </A>
        <button
          type="button"
          class="settings-action"
          aria-haspopup="dialog"
          onClick={() => setExporting(true)}
        >
          <DownloadIcon size={18} />
          <span class="settings-item-text">
            <span class="settings-item-name">{t("settings.exportCsv")}</span>
            <span class="settings-item-meta">{t("settings.exportCsvMeta")}</span>
          </span>
        </button>
        <Show when={liveFile}>{(file) => <LiveFileRow file={file()} />}</Show>
      </div>
      <Show when={liveFile}>
        <p class="settings-note">{t("liveFile.note")}</p>
      </Show>
      <ExportDialog open={exporting()} what="all" onClose={() => setExporting(false)} />
    </section>
  );
}
