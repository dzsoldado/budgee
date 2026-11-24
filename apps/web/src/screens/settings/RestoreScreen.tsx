// Settings → Restore with recovery key: a new device joins a server that already has data,
// taking the vault key from the recovery key instead of a pairing link. It still signs in to the
// server with a pairing code from a paired device, or the setup secret on a fresh server. The key
// is checked against its checksum first, then against the server's data before anything is pushed;
// a server with no data can't confirm it, so the user is asked to double-check it first.
import {
  fromRecoveryKey,
  importKey,
  RecoveryKeyError,
  type RecoveryKeyProblem,
} from "@budgee/core";
import { useNavigate } from "@solidjs/router";
import { createSignal, createUniqueId, Match, onCleanup, Show, Switch } from "solid-js";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Segmented } from "../../components/Segmented";
import { useApp } from "../../context";
import { type MessageKey, t } from "../../i18n";
import { defaultDeviceName } from "../../lib/device-name";
import { Screen } from "../../shell/Screen";
import {
  canPair,
  createQuestion,
  PairingSaveError,
  pairingErrorText,
  pairWithCode,
  type StoredPairing,
  setUpServer,
  storePairing,
  unpair,
} from "../../sync/pairing";
import { announce, syncStatus } from "../../sync/status";
import { settingsBack } from "./common";
import { AlreadyPaired, checkDeviceName, createLivePairing, Field, hostOf } from "./pairing-common";

const KEY_PROBLEM: Record<RecoveryKeyProblem, MessageKey> = {
  length: "restore.keyLength",
  character: "restore.keyCharacter",
  checksum: "restore.keyChecksum",
};

type Mode = "code" | "secret";

export function RestoreScreen() {
  const { db, platform, sync } = useApp();
  const navigate = useNavigate();
  const pairing = createLivePairing(db);
  const [serverUrl, setServerUrl] = createSignal(window.location.origin);
  const [mode, setMode] = createSignal<Mode>("code");
  const [code, setCode] = createSignal("");
  const [secret, setSecret] = createSignal("");
  const [recovery, setRecovery] = createSignal("");
  const [name, setName] = createSignal(defaultDeviceName(navigator.userAgent));
  const [keyError, setKeyError] = createSignal<string>();
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const [nameError, setNameError] = createSignal<string>();
  /** Setup succeeded on the server but couldn't be kept here: held to try saving again. */
  const [pending, setPending] = createSignal<StoredPairing>();
  /** "Use a key the server can't check?" is showing. */
  const [asking, setAsking] = createSignal(false);
  const question = createQuestion(setAsking);
  const keyId = createUniqueId();
  // Leaving with the question open declines it, so the spent device is taken off the server.
  onCleanup(question.dismiss);

  /** After pairing: sync, and give up on a key the server's data turns out not to match. */
  const finish = async () => {
    setRecovery("");
    setSecret("");
    setPending(undefined);
    await sync.syncNow({ manual: true });
    // The check before pairing reads the server's first row; a later one may still disagree.
    const status = syncStatus();
    if (status.kind === "error" && status.error.kind === "decrypt") {
      await sync.exclusive(() => unpair({ db, platform }));
      void sync.syncNow();
      setError(t("pairing.error.keyMismatch"));
      return;
    }
    announce(t("restore.done", { host: hostOf(serverUrl()) }));
    navigate("/settings", { replace: true });
  };

  const retrySave = async () => {
    const claimed = pending();
    if (!claimed || busy()) return;
    setBusy(true);
    try {
      await storePairing(db, claimed);
      await finish();
    } catch (failure) {
      console.error("Keeping the pairing failed again", failure);
      setError(t("pairing.error.saveFailedAgain"));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    // A claimed pairing waits to be saved: pairing again would let a second device in.
    if (!canPair({ busy: busy(), pending: pending() })) return;
    setError(undefined);
    setKeyError(undefined);
    const deviceName = checkDeviceName(name(), setNameError);
    let vaultKey: CryptoKey;
    try {
      vaultKey = await importKey(await fromRecoveryKey(recovery()));
    } catch (failure) {
      const reason = failure instanceof RecoveryKeyError ? failure.reason : "character";
      setKeyError(t(KEY_PROBLEM[reason]));
      document.getElementById(keyId)?.focus();
      return;
    }
    if (!deviceName) return;

    setBusy(true);
    try {
      if (mode() === "code") {
        await pairWithCode(
          { db, platform },
          {
            serverUrl: serverUrl(),
            code: code().toUpperCase(),
            deviceName,
            vaultKey,
            checkKey: true,
            confirmUnverified: question.ask,
          },
        );
      } else {
        await setUpServer(
          { db, platform },
          { serverUrl: serverUrl(), secret: secret(), deviceName, vaultKey },
        );
      }
      await finish();
    } catch (failure) {
      if (failure instanceof PairingSaveError) {
        console.error("Keeping the pairing failed", failure.cause);
        setSecret("");
        setPending(failure.pending);
      }
      setError(pairingErrorText(failure, hostOf(serverUrl())));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title={t("restore.title")} back={settingsBack()} class="settings pairing">
      <Switch>
        <Match when={!busy() && !error() && pairing()}>
          {(paired) => <AlreadyPaired serverUrl={paired().serverUrl} />}
        </Match>
        <Match when={pairing() === null || busy() || error()}>
          <p class="settings-intro">{t("restore.intro")}</p>
          <form class="card stack" onSubmit={submit}>
            <Field
              label={t("pairing.serverUrl")}
              type="url"
              required
              autocomplete="url"
              value={serverUrl()}
              onInput={setServerUrl}
            />
            <div class="field">
              <span class="field-label" id={`${keyId}-mode`}>
                {t("restore.signInWith")}
              </span>
              <Segmented<Mode>
                label={t("restore.signInWith")}
                wide
                options={[
                  { value: "code", label: t("restore.withCode") },
                  { value: "secret", label: t("restore.withSecret") },
                ]}
                value={mode()}
                disabled={pending() !== undefined}
                onChange={(next) => {
                  if (!canPair({ busy: busy(), pending: pending() })) return;
                  setMode(next);
                  setError(undefined);
                }}
              />
            </div>
            <Show
              when={mode() === "code"}
              fallback={
                <Field
                  label={t("pairing.setupSecret")}
                  hint={t("restore.secretHint")}
                  type="password"
                  required
                  autocomplete="off"
                  value={secret()}
                  onInput={setSecret}
                />
              }
            >
              <Field
                label={t("restore.code")}
                hint={t("restore.codeHint")}
                required
                autocomplete="off"
                autocapitalize="characters"
                spellcheck={false}
                inputClass="input-code"
                value={code()}
                onInput={setCode}
              />
            </Show>
            <div class="field">
              <label class="field-label" for={keyId}>
                {t("restore.recoveryKey")}
              </label>
              <textarea
                id={keyId}
                class="input input-key"
                rows={3}
                required
                autocomplete="off"
                autocapitalize="characters"
                spellcheck={false}
                aria-invalid={keyError() ? "true" : undefined}
                aria-describedby={`${keyId}-hint ${keyId}-error`}
                value={recovery()}
                onInput={(event) => {
                  setRecovery(event.currentTarget.value);
                  setKeyError(undefined);
                }}
              />
              <p id={`${keyId}-hint`} class="hint">
                {t("restore.recoveryKeyHint")}
              </p>
              <p id={`${keyId}-error`} class="field-error">
                {keyError()}
              </p>
            </div>
            <Field
              label={t("pairing.deviceName")}
              hint={t("pairing.deviceNameHint")}
              required
              maxLength={100}
              error={nameError()}
              value={name()}
              onInput={(value) => {
                setName(value);
                setNameError(undefined);
              }}
            />
            <p class="field-error" role="alert">
              {error()}
            </p>
            <Show
              when={pending()}
              fallback={
                <button
                  type="submit"
                  class="btn btn-primary pair-wide"
                  aria-busy={busy()}
                  disabled={busy()}
                >
                  {busy() ? t("restore.restoring") : t("restore.restore")}
                </button>
              }
            >
              <button
                type="button"
                class="btn btn-primary pair-wide"
                aria-busy={busy()}
                disabled={busy()}
                onClick={retrySave}
              >
                {t("pairing.saveAgain")}
              </button>
            </Show>
          </form>
        </Match>
      </Switch>
      <ConfirmDialog
        open={asking()}
        title={t("restore.unverifiedTitle")}
        body={t("restore.unverifiedBody")}
        confirmLabel={t("restore.unverifiedConfirm")}
        cancelLabel={t("lists.cancel")}
        onConfirm={() => question.answer(true)}
        onCancel={question.dismiss}
      />
    </Screen>
  );
}
