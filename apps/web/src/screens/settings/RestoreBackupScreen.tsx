// Settings → Backups → Restore…: pick a backup downloaded from Drive, see what it holds and how
// much it would change, then merge it in. Paired devices decrypt with their vault key, restore
// while no sync runs, then sync; an unpaired device asks for the recovery key and keeps the
// result locally. Nothing is written until the whole file has decrypted.
import {
  fromRecoveryKey,
  importKey,
  RecoveryKeyError,
  type RecoveryKeyProblem,
  SYNCED_TABLES,
  type TableName,
} from "@budgee/core";
import { A } from "@solidjs/router";
import {
  createMemo,
  createSignal,
  createUniqueId,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import { useApp } from "../../context";
import { type MessageKey, t } from "../../i18n";
import { formatPlainDate } from "../../i18n/format";
import { ChevronRightIcon, FileIcon } from "../../shell/icons";
import { Screen } from "../../shell/Screen";
import {
  type BackupContents,
  checkBackupSize,
  countChanges,
  RestoreError,
  type RestoreProblem,
  readBackupFile,
  restoreBackup,
} from "../../sync/restore";
import { announce } from "../../sync/status";
import { settingsBack } from "./common";
import { createLivePairing, hostOf } from "./pairing-common";

const KEY_PROBLEM: Record<RecoveryKeyProblem, MessageKey> = {
  length: "restore.keyLength",
  character: "restore.keyCharacter",
  checksum: "restore.keyChecksum",
};

const TABLE_LABEL: Record<TableName, MessageKey> = {
  transactions: "restoreBackup.table.transactions",
  categories: "restoreBackup.table.categories",
  settings: "restoreBackup.table.settings",
  chart_configs: "restoreBackup.table.chartConfigs",
};

interface Preview {
  name: string;
  contents: BackupContents;
  changes: number;
  /** Tombstones that delete a live row here. */
  deletions: number;
}

type Step =
  | { kind: "pick" }
  | ({ kind: "preview" } & Preview)
  | { kind: "done"; applied: number; synced: boolean };

export function RestoreBackupScreen() {
  const { db, repo, sync, settings } = useApp();
  const pairing = createLivePairing(db);
  const [file, setFile] = createSignal<File>();
  const [recovery, setRecovery] = createSignal("");
  const [keyError, setKeyError] = createSignal<string>();
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const [step, setStep] = createSignal<Step>({ kind: "pick" });
  const id = createUniqueId();
  let fileInput!: HTMLInputElement;
  let readError!: HTMLParagraphElement;
  let heading: HTMLHeadingElement | undefined;

  const number = createMemo(() => new Intl.NumberFormat(settings().locale));
  const count = (n: number) => number().format(n);
  const host = () => {
    const paired = pairing();
    return paired ? hostOf(paired.serverUrl) : "";
  };
  const focusHeading = () => queueMicrotask(() => heading?.focus());

  const problemText = (problem: RestoreProblem): string => {
    if (problem === "not_backup") return t("restoreBackup.error.notBackup");
    if (problem === "damaged") return t("restoreBackup.error.damaged");
    if (problem === "too_large") return t("restoreBackup.error.tooLarge");
    return pairing()
      ? t("restoreBackup.error.wrongKey")
      : t("restoreBackup.error.wrongRecoveryKey");
  };

  /** The vault key when paired; otherwise the typed recovery key's, or undefined after an error. */
  const vaultKey = async (): Promise<CryptoKey | undefined> => {
    const paired = pairing();
    if (paired) return paired.vaultKey;
    try {
      return await importKey(await fromRecoveryKey(recovery()));
    } catch (failure) {
      const reason = failure instanceof RecoveryKeyError ? failure.reason : "character";
      setKeyError(t(KEY_PROBLEM[reason]));
      document.getElementById(`${id}-key`)?.focus();
      return undefined;
    }
  };

  const read = async (event: SubmitEvent) => {
    event.preventDefault();
    if (busy()) return;
    setError(undefined);
    setKeyError(undefined);
    const chosen = file();
    if (!chosen) {
      setError(t("restoreBackup.error.noFile"));
      fileInput.focus();
      return;
    }
    try {
      // Cheap, before anything is read into memory.
      checkBackupSize(chosen.size);
    } catch {
      setError(problemText("too_large"));
      readError.focus();
      return;
    }
    const key = await vaultKey();
    if (!key) return;
    setBusy(true);
    try {
      const contents = await readBackupFile(
        new Uint8Array(await chosen.arrayBuffer()),
        chosen.name,
        key,
      );
      const { changes, deletions } = await countChanges(db, contents.rows);
      setStep({ kind: "preview", name: chosen.name, contents, changes, deletions });
      focusHeading();
    } catch (failure) {
      if (!(failure instanceof RestoreError)) console.error("Reading the backup failed", failure);
      setError(
        failure instanceof RestoreError
          ? problemText(failure.reason)
          : t("restoreBackup.error.unknown"),
      );
      readError.focus();
    } finally {
      setBusy(false);
    }
  };

  const apply = async (preview: Preview) => {
    if (busy()) return;
    setBusy(true);
    setError(undefined);
    try {
      const paired = pairing() !== null;
      // No sync reads or writes rows halfway through the merge.
      const { applied } = await sync.exclusive(() => restoreBackup(repo, preview.contents));
      setRecovery("");
      setStep({ kind: "done", applied, synced: paired && applied > 0 });
      announce(doneText(applied));
      focusHeading();
      if (paired) void sync.syncNow({ manual: true });
    } catch (failure) {
      console.error("Restoring the backup failed", failure);
      setError(t("restoreBackup.error.saveFailed"));
    } finally {
      setBusy(false);
    }
  };

  const startOver = () => {
    setStep({ kind: "pick" });
    setFile(undefined);
    setRecovery("");
    setError(undefined);
  };

  // The typed recovery key is a secret: gone when the screen is.
  onCleanup(() => setRecovery(""));

  const doneText = (applied: number) =>
    applied === 0
      ? t("restoreBackup.doneNone")
      : applied === 1
        ? t("restoreBackup.doneOne")
        : t("restoreBackup.doneMany", { count: count(applied) });

  const changesText = (changes: number) =>
    changes === 0
      ? t("restoreBackup.changesNone")
      : changes === 1
        ? t("restoreBackup.changesOne")
        : t("restoreBackup.changesMany", { count: count(changes) });

  const previewTitle = (preview: Preview) =>
    preview.contents.date
      ? t("restoreBackup.previewTitle", {
          date: formatPlainDate(preview.contents.date, settings().locale, { dateStyle: "long" }),
        })
      : t("restoreBackup.previewUndated", { name: preview.name });

  return (
    <Screen title={t("restoreBackup.title")} back={settingsBack()} class="settings pairing">
      <Switch>
        <Match when={step().kind === "pick"}>
          <p class="settings-intro">{t("restoreBackup.intro")}</p>
          <form class="card stack" onSubmit={read} novalidate>
            <div class="field">
              <span class="field-label" id={`${id}-file-label`}>
                {t("restoreBackup.file")}
              </span>
              <label class="file-pick">
                <input
                  ref={fileInput}
                  type="file"
                  class="file-pick-input"
                  accept=".gz,application/gzip"
                  aria-labelledby={`${id}-file-label`}
                  aria-describedby={`${id}-file-hint`}
                  onChange={(event) => {
                    setFile(event.currentTarget.files?.[0]);
                    setError(undefined);
                  }}
                />
                <span class="file-pick-icon">
                  <FileIcon size={18} />
                </span>
                <span class="file-pick-name" classList={{ "file-pick-empty": !file() }}>
                  {file()?.name ?? t("restoreBackup.chooseFile")}
                </span>
                <ChevronRightIcon size={16} />
              </label>
              <p id={`${id}-file-hint`} class="hint">
                {t("restoreBackup.fileHint")}
              </p>
            </div>
            <Show when={pairing() === null}>
              <div class="field">
                <label class="field-label" for={`${id}-key`}>
                  {t("restore.recoveryKey")}
                </label>
                <textarea
                  id={`${id}-key`}
                  class="input input-key"
                  rows={3}
                  autocomplete="off"
                  autocapitalize="characters"
                  spellcheck={false}
                  aria-invalid={keyError() ? "true" : undefined}
                  aria-describedby={`${id}-key-hint ${id}-key-error`}
                  value={recovery()}
                  onInput={(event) => {
                    setRecovery(event.currentTarget.value);
                    setKeyError(undefined);
                    setError(undefined);
                  }}
                />
                <p id={`${id}-key-hint`} class="hint">
                  {t("restoreBackup.keyHint")}
                </p>
                <p id={`${id}-key-error`} class="field-error">
                  {keyError()}
                </p>
              </div>
            </Show>
            <p class="field-error" role="alert" tabindex="-1" ref={readError}>
              {error()}
            </p>
            <button
              type="submit"
              class="btn btn-primary pair-wide"
              aria-busy={busy()}
              disabled={busy() || pairing() === undefined}
            >
              {busy() ? t("restoreBackup.reading") : t("restoreBackup.read")}
            </button>
          </form>
        </Match>

        <Match when={step().kind === "preview" && (step() as Preview & { kind: "preview" })}>
          {(preview) => (
            <div class="card stack">
              <h2 class="pair-title" tabindex="-1" ref={heading}>
                {previewTitle(preview())}
              </h2>
              <Show when={preview().contents.rows.length === 0}>
                <p class="pair-text">{t("restoreBackup.empty")}</p>
              </Show>
              <Show when={preview().contents.rows.length > 0}>
                <dl
                  class="settings-facts restore-counts"
                  aria-label={t("restoreBackup.previewLabel")}
                >
                  {/* Only what the backup holds: a column of zeros says nothing. */}
                  <For each={SYNCED_TABLES.filter((table) => preview().contents.counts[table] > 0)}>
                    {(table) => (
                      <>
                        <dt>{t(TABLE_LABEL[table])}</dt>
                        <dd>{count(preview().contents.counts[table])}</dd>
                      </>
                    )}
                  </For>
                  <Show when={preview().deletions > 0}>
                    <dt>{t("restoreBackup.deleted")}</dt>
                    <dd>{count(preview().deletions)}</dd>
                  </Show>
                </dl>
                <p class="pair-text">
                  {changesText(preview().changes)}
                  <Show when={preview().changes > 0}> {t("restoreBackup.keepsNewer")}</Show>
                </p>
              </Show>
              <Show when={preview().changes > 0}>
                <p class="hint">
                  {pairing()
                    ? t("restoreBackup.willSync", { host: host() })
                    : t("restoreBackup.localOnly")}
                </p>
              </Show>
              <p class="field-error" role="alert">
                {error()}
              </p>
              <div class="pair-actions">
                <button type="button" class="btn btn-secondary" onClick={startOver}>
                  {t("restoreBackup.another")}
                </button>
                <Show when={preview().contents.rows.length > 0}>
                  <button
                    type="button"
                    class="btn btn-primary"
                    aria-busy={busy()}
                    disabled={busy() || preview().changes === 0}
                    onClick={() => apply(preview())}
                  >
                    {busy() ? t("restoreBackup.restoring") : t("restoreBackup.confirm")}
                  </button>
                </Show>
              </div>
            </div>
          )}
        </Match>

        <Match when={step().kind === "done" && (step() as Step & { kind: "done" })}>
          {(done) => (
            <div class="card stack">
              <h2 class="pair-title" tabindex="-1" ref={heading}>
                {t("restoreBackup.doneTitle")}
              </h2>
              <p class="pair-text">
                {doneText(done().applied)}{" "}
                <Show when={done().applied > 0}>
                  {done().synced
                    ? t("restoreBackup.doneSync", { host: host() })
                    : t("restoreBackup.doneLocal")}
                </Show>
              </p>
              <A href="/settings" class="btn btn-primary pair-wide">
                {t("restoreBackup.backToSettings")}
              </A>
            </div>
          )}
        </Match>
      </Switch>
    </Screen>
  );
}
