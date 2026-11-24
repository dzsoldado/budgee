// Settings → Backups (Settings.dc.html): the destination (Google Drive), the last backup and its
// result, the next run, the files in Drive, "Back up now", connecting or disconnecting Drive,
// and "Restore…". The server makes the backups, so all but Restore need a pairing. Google's
// sign-in returns to `/#/settings?drive=connected|error&reason=…`, said here once (a success
// only when the status confirms it), then removed. Failures are explained from the server's
// error codes; its messages never reach the screen.
import { type BackupStatusResponse, backupFileDate } from "@budgee/core";
import { A, useSearchParams } from "@solidjs/router";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useApp } from "../../context";
import { t } from "../../i18n";
import { formatPlainDate } from "../../i18n/format";
import { CheckIcon, ChevronDownIcon, CloseIcon, CloudIcon } from "../../shell/icons";
import {
  backupErrorText,
  backupFailureText,
  backupState,
  DRIVE_PARAMS,
  driveReturn,
  formatWhen,
} from "../../sync/backups";
import { announce, createNow, syncStatus } from "../../sync/status";
import { createLivePairing, hostOf } from "./pairing-common";

/** Files listed under "Recent backups"; the rest are counted. */
const RECENT_FILES = 5;

type Notice = { ok: boolean; text: string };
type DriveParams = { drive?: string; reason?: string };

export function BackupsSection() {
  const { db, platform, settings } = useApp();
  const pairing = createLivePairing(db);
  const now = createNow(60_000);
  const [params, setParams] = useSearchParams<DriveParams>();
  const [status, setStatus] = createSignal<BackupStatusResponse>();
  const [loadError, setLoadError] = createSignal<string>();
  const [running, setRunning] = createSignal(false);
  const [connecting, setConnecting] = createSignal(false);
  const [disconnecting, setDisconnecting] = createSignal(false);
  const [notice, setNotice] = createSignal<Notice>();
  /** Google's return, waiting for the status to confirm it. */
  let returned: DriveParams | undefined;
  let section!: HTMLElement;
  let title!: HTMLHeadingElement;

  const locale = () => settings().locale;
  const host = () => {
    const paired = pairing();
    return paired ? hostOf(paired.serverUrl) : "";
  };
  const revoked = () => syncStatus().kind === "revoked";
  const api = () => {
    const paired = pairing();
    if (!paired) throw new Error("Not paired");
    return platform.createBackupApi(paired);
  };
  const state = () => {
    const current = status();
    return current ? backupState(current.destination) : undefined;
  };
  /** Paired, and the status is still on its way. */
  const loading = () => Boolean(pairing() && !revoked() && !status() && !loadError());
  const show = (next: Notice) => {
    setNotice(next);
    announce(next.text);
  };

  /** Says how Google's return went, once the status read after it can confirm a connection. */
  const settleReturn = () => {
    const back = returned;
    returned = undefined;
    if (!back) return;
    // The status could not be read: its error says so; don't guess at the connection.
    if (back.drive === "connected" && !status()) return;
    const message = driveReturn(back, state() === "connected");
    if (message) show(message);
  };

  /** Numbers the reads: when two overlap (mount, coming back), only the latest one counts. */
  let reads = 0;
  const load = async () => {
    if (!pairing() || revoked()) return;
    const read = ++reads;
    setLoadError(undefined);
    try {
      const next = await api().status();
      if (read !== reads) return;
      setStatus(next);
    } catch (error) {
      if (read !== reads) return;
      setStatus(undefined);
      setLoadError(backupErrorText(error, host()));
    }
    settleReturn();
  };

  // A memo, so only a new token (or a revoke) reloads: every sync status change would rerun it,
  // and offline each failed load starts a sync whose status change would load again.
  const activeToken = createMemo(() => (revoked() ? undefined : pairing()?.deviceToken));
  createEffect(
    on(activeToken, (token) => {
      // A read still on its way for the previous token (or a revoked device) no longer counts.
      reads++;
      setStatus(undefined);
      setLoadError(revoked() ? t("sync.revokedHint") : undefined);
      if (token) void load();
    }),
  );

  // Back from Google's consent page: drop the params from the address at once, and say how it
  // went once the status is in (settleReturn).
  onMount(() => {
    const drive = typeof params.drive === "string" ? params.drive : undefined;
    if (!drive) return;
    returned = { drive, ...(typeof params.reason === "string" ? { reason: params.reason } : {}) };
    setParams(Object.fromEntries(DRIVE_PARAMS.map((key) => [key, undefined])), { replace: true });
    section.scrollIntoView({ block: "start" });
    if (status() || loadError()) settleReturn();
  });
  // Not paired: no status will come to confirm anything.
  createEffect(() => {
    if (pairing() === null) settleReturn();
  });

  // Coming back to the app (another tab, the Drive app, or Back from Google's page, which may
  // restore this page from the back-forward cache): read the status again, and a connect that
  // never left is no longer "Opening Google…".
  const onPageShow = () => {
    setConnecting(false);
    void load();
  };
  const onVisible = () => {
    if (document.visibilityState === "visible" && !running()) void load();
  };
  window.addEventListener("pageshow", onPageShow);
  document.addEventListener("visibilitychange", onVisible);
  onCleanup(() => {
    window.removeEventListener("pageshow", onPageShow);
    document.removeEventListener("visibilitychange", onVisible);
  });

  const connect = async () => {
    if (connecting()) return;
    setConnecting(true);
    setNotice(undefined);
    try {
      // The whole window goes to Google and comes back: installed apps handle that best. The
      // URL is checked to be Google's https consent page (core checkConsentUrl).
      window.location.assign(await api().connect());
    } catch (error) {
      setConnecting(false);
      show({ ok: false, text: backupErrorText(error, host()) });
    }
  };

  const backUpNow = async () => {
    if (running()) return;
    setRunning(true);
    setNotice(undefined);
    announce(t("backups.backingUp"));
    try {
      const run = await api().run();
      if (run.status === "ok") {
        show({ ok: true, text: t("backups.backedUp", { file: run.file ?? "" }) });
      } else if (run.status === "error") {
        // The card says why once the status is read again; a notice would repeat it.
        announce(t("backups.backupFailed", { reason: backupFailureText(run.errorCode) }));
      }
    } catch (error) {
      show({ ok: false, text: backupErrorText(error, host()) });
    } finally {
      setRunning(false);
    }
    await load();
  };

  const disconnect = async () => {
    setDisconnecting(false);
    setNotice(undefined);
    try {
      await api().disconnect();
      title.focus();
      show({ ok: true, text: t("backups.disconnected") });
    } catch (error) {
      show({ ok: false, text: backupErrorText(error, host()) });
    }
    await load();
  };

  const headline = () => {
    if (pairing() === null) return t("backups.notPaired");
    switch (state()) {
      case "connected":
        return t("backups.driveConnected");
      case "reconnect":
        return t("backups.driveReconnect");
      case "not_configured":
        return t("backups.driveNotConfigured");
      case "not_connected":
        return t("settings.driveNotConnected");
      default:
        // Loading, or the status could not be read: nothing to claim yet.
        return t("backups.drive");
    }
  };
  const subline = () => {
    if (loading()) return t("backups.loading");
    return state() === "connected" || state() === "reconnect"
      ? t("backups.folder")
      : t("settings.driveHint");
  };

  const lastRun = () => status()?.lastRun ?? null;
  const lastText = () => {
    const run = lastRun();
    if (!run) return t("settings.never");
    const when = formatWhen(run.at, now(), locale());
    if (run.status === "ok") return t("backups.lastOk", { when });
    if (run.status === "error") return t("backups.lastFailed", { when });
    return t("backups.lastSkipped", { when });
  };
  /** The next run's time when connected; "Daily" otherwise; undefined from an older server. */
  const nextText = () => {
    if (state() !== "connected") return t("backups.daily");
    const next = status()?.nextRunAt;
    return next === undefined ? undefined : formatWhen(next, now(), locale());
  };
  const files = () => status()?.files.filter((name) => backupFileDate(name)) ?? [];
  /** The last run's file, or after a failed run the newest one in Drive (the last good one). */
  const fileText = () => lastRun()?.file ?? files()[0] ?? t("list.none");
  const fileDate = (name: string) =>
    formatPlainDate(backupFileDate(name) ?? "", locale(), {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  const filesText = () =>
    files().length === 1
      ? t("backups.filesOne")
      : t("backups.filesMany", { count: files().length });

  const canBackUp = () => state() === "connected" && !running();

  return (
    <section class="section" aria-labelledby="settings-backups" ref={section}>
      <h2 id="settings-backups" class="section-title" tabindex="-1" ref={title}>
        {t("settings.backups")}
      </h2>

      <Show when={notice()}>
        {(current) => (
          <div
            class="backup-notice"
            classList={{ "backup-notice-error": !current().ok }}
            role={current().ok ? "status" : "alert"}
          >
            <p>{current().text}</p>
            <button
              type="button"
              class="icon-btn backup-notice-close"
              aria-label={t("backups.dismiss")}
              onClick={() => setNotice(undefined)}
            >
              <CloseIcon size={16} />
            </button>
          </div>
        )}
      </Show>

      <div class="settings-card settings-panel" aria-busy={loading()}>
        <div class="settings-panel-head">
          <span
            class="settings-panel-icon"
            classList={{
              "settings-panel-icon-primary": state() !== "reconnect",
              "settings-panel-icon-warning": state() === "reconnect",
            }}
          >
            <CloudIcon size={18} />
          </span>
          <span class="settings-item-text">
            <span class="settings-item-name">{headline()}</span>
            <span class="settings-item-meta" role={loading() ? "status" : undefined}>
              {subline()}
            </span>
          </span>
        </div>

        <Switch>
          <Match when={loadError()}>
            {(text) => (
              <div class="backup-load-error">
                <p class="field-error">{text()}</p>
                <Show when={!revoked()}>
                  <button type="button" class="btn btn-secondary settings-small-btn" onClick={load}>
                    {t("backups.retry")}
                  </button>
                </Show>
              </div>
            )}
          </Match>
          <Match when={state() === "not_configured"}>
            <p class="backup-warning">{t("backups.notConfiguredHint")}</p>
          </Match>
          <Match when={state() === "reconnect"}>
            <p class="backup-warning">{t("backups.reconnectHint")}</p>
          </Match>
        </Switch>

        {/* The Drive facts only once there is a status to show; never guessed. */}
        <Show when={status()}>
          <dl class="settings-facts">
            <dt>{t("settings.lastBackup")}</dt>
            <dd class="backup-last" aria-live="polite">
              <Show
                when={!running()}
                fallback={<span class="muted">{t("backups.backingUp")}</span>}
              >
                <Show when={lastRun()?.status === "ok"}>
                  <span class="backup-ok">
                    <CheckIcon size={16} />
                  </span>
                </Show>
                <Show when={lastRun()?.status === "error"}>
                  <span class="status-dot status-dot-error" />
                </Show>
                {lastText()}
              </Show>
            </dd>
            <dt>{t("settings.file")}</dt>
            <dd class="backup-file">{fileText()}</dd>
            <Show when={nextText()}>
              {(next) => (
                <>
                  <dt>{t("backups.next")}</dt>
                  <dd>{next()}</dd>
                </>
              )}
            </Show>
            <dt>{t("settings.keeps")}</dt>
            <dd>{t("settings.retention")}</dd>
            <Show when={files().length > 0}>
              <dt>{t("backups.inDrive")}</dt>
              <dd>{filesText()}</dd>
            </Show>
          </dl>

          {/* Reconnecting is the whole story then: the warning above says it. */}
          <Show when={state() !== "reconnect" && lastRun()?.status === "error"}>
            <p class="field-error">
              {t("backups.lastError", { reason: backupFailureText(lastRun()?.errorCode) })}
            </p>
          </Show>
          <Show when={lastRun()?.retentionError}>
            <p class="backup-warning">
              {t("backups.retentionError", {
                reason: backupFailureText(lastRun()?.retentionErrorCode),
              })}
            </p>
          </Show>
          <Show when={state() !== "reconnect" && status()?.filesError}>
            <p class="hint">
              {t("backups.filesError", { reason: backupFailureText(status()?.filesErrorCode) })}
            </p>
          </Show>

          <Show when={files().length > 0}>
            <details class="backup-files">
              <summary>
                {t("backups.recent")}
                <ChevronDownIcon size={16} />
              </summary>
              <ul aria-label={t("backups.recentLabel")}>
                <For each={files().slice(0, RECENT_FILES)}>
                  {(name) => (
                    <li>
                      <span>{fileDate(name)}</span>
                      <span class="backup-file">{name}</span>
                    </li>
                  )}
                </For>
              </ul>
            </details>
          </Show>
        </Show>

        <div class="settings-pair">
          <Switch
            fallback={
              <button
                type="button"
                class="btn btn-primary settings-wide-btn"
                aria-busy={running()}
                aria-disabled={running() || undefined}
                disabled={state() !== "connected"}
                onClick={() => canBackUp() && backUpNow()}
              >
                {running() ? t("backups.backingUp") : t("settings.backUpNow")}
              </button>
            }
          >
            <Match when={state() === "not_connected" || state() === "reconnect"}>
              <button
                type="button"
                class="btn btn-primary settings-wide-btn"
                aria-busy={connecting()}
                disabled={connecting()}
                onClick={connect}
              >
                {connecting()
                  ? t("backups.connecting")
                  : state() === "reconnect"
                    ? t("backups.reconnect")
                    : t("backups.connect")}
              </button>
            </Match>
          </Switch>
          <A href="/settings/restore-backup" class="btn btn-secondary settings-wide-btn">
            {t("settings.restore")}
          </A>
        </div>
      </div>

      <Show when={pairing()} fallback={<p class="settings-note">{t("backups.unpairedNote")}</p>}>
        <Show when={state() === "connected" || files().length > 0}>
          <p class="settings-note">{t("backups.downloadHint")}</p>
        </Show>
        {/* Below the card, like Forget pairing: the head keeps the destination on one line. */}
        <Show when={state() === "connected" || state() === "reconnect"}>
          <button
            type="button"
            class="settings-text-btn"
            aria-haspopup="dialog"
            onClick={() => setDisconnecting(true)}
          >
            {t("backups.disconnect")}
          </button>
        </Show>
      </Show>

      <ConfirmDialog
        open={disconnecting()}
        title={t("backups.disconnectTitle")}
        body={t("backups.disconnectBody")}
        confirmLabel={t("backups.disconnect")}
        cancelLabel={t("lists.cancel")}
        destructive
        onConfirm={disconnect}
        onCancel={() => setDisconnecting(false)}
      />
    </section>
  );
}
