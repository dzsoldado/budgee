// Settings → Connect to a server: the first device claims the server with its setup secret,
// creates the vault key and then shows the recovery key, once, until "I saved it" is ticked. If
// the server accepted this device but the pairing couldn't be kept here, what the server gave is
// held in memory to try saving again (setup can't run twice).
import { useNavigate } from "@solidjs/router";
import { createSignal, createUniqueId, Match, Switch } from "solid-js";
import { RecoveryKeyView } from "../../components/RecoveryKeyView";
import { useApp } from "../../context";
import { takeDevSetupSecret } from "../../dev/prefill";
import { t } from "../../i18n";
import { defaultDeviceName } from "../../lib/device-name";
import { Screen } from "../../shell/Screen";
import {
  PairingSaveError,
  pairingErrorText,
  recoveryKeyOf,
  type StoredPairing,
  setUpServer,
  storePairing,
} from "../../sync/pairing";
import { settingsBack } from "./common";
import { AlreadyPaired, checkDeviceName, createLivePairing, Field, hostOf } from "./pairing-common";

export function ConnectScreen() {
  const { db, platform, sync } = useApp();
  const navigate = useNavigate();
  const pairing = createLivePairing(db);
  const [serverUrl, setServerUrl] = createSignal(window.location.origin);
  const [secret, setSecret] = createSignal(import.meta.env.DEV ? takeDevSetupSecret() : "");
  const [name, setName] = createSignal(defaultDeviceName(navigator.userAgent));
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [nameError, setNameError] = createSignal<string>();
  /** Claimed on the server but not yet kept here. */
  const [pending, setPending] = createSignal<StoredPairing>();
  let retryButton: HTMLButtonElement | undefined;
  /** Set once the server is claimed: the key step replaces the form. */
  const [recoveryKey, setRecoveryKey] = createSignal<string>();
  const [saved, setSaved] = createSignal(false);
  const savedHint = createUniqueId();
  let keyTitle!: HTMLHeadingElement;

  const showKey = async (key: CryptoKey) => {
    setSecret("");
    setPending(undefined);
    setRecoveryKey(await recoveryKeyOf(key));
    void sync.syncNow({ manual: true });
    keyTitle.focus();
  };

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (busy()) return;
    const deviceName = checkDeviceName(name(), setNameError);
    if (!deviceName) return;
    setError(undefined);
    setBusy(true);
    try {
      await showKey(
        await setUpServer(
          { db, platform },
          { serverUrl: serverUrl(), secret: secret(), deviceName },
        ),
      );
    } catch (failure) {
      if (failure instanceof PairingSaveError) {
        console.error("Keeping the pairing failed", failure.cause);
        setSecret("");
        setPending(failure.pending);
        queueMicrotask(() => retryButton?.focus());
      } else setError(pairingErrorText(failure, hostOf(serverUrl())));
    } finally {
      setBusy(false);
    }
  };

  const retrySave = async () => {
    const claimed = pending();
    if (!claimed || busy()) return;
    setError(undefined);
    setBusy(true);
    try {
      await storePairing(db, claimed);
      await showKey(claimed.vaultKey);
    } catch (failure) {
      console.error("Keeping the pairing failed again", failure);
      setError(t("pairing.error.saveFailedAgain"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title={t("pairing.connectTitle")} back={settingsBack()} class="settings pairing">
      <Switch>
        <Match when={recoveryKey()}>
          {(key) => (
            <section class="stack" aria-labelledby="recovery-title">
              <h2 id="recovery-title" class="pair-title" tabindex="-1" ref={keyTitle}>
                {t("recovery.saveTitle")}
              </h2>
              <p class="pair-text">{t("recovery.saveText")}</p>
              <p class="pair-warning">{t("recovery.warning")}</p>
              <RecoveryKeyView recoveryKey={key()} />
              <label class="check">
                <input
                  type="checkbox"
                  checked={saved()}
                  onChange={(event) => setSaved(event.currentTarget.checked)}
                />
                <span>{t("recovery.savedCheck")}</span>
              </label>
              <button
                type="button"
                class="btn btn-primary pair-wide"
                aria-disabled={!saved()}
                aria-describedby={saved() ? undefined : savedHint}
                onClick={() => {
                  if (saved()) navigate("/settings");
                }}
              >
                {t("recovery.continue")}
              </button>
              <p id={savedHint} class="hint" hidden={saved()}>
                {t("recovery.continueHint")}
              </p>
            </section>
          )}
        </Match>
        <Match when={pending()}>
          <div class="card stack">
            <h2 class="pair-title">{t("pairing.saveFailedTitle")}</h2>
            <p class="pair-text">{t("pairing.error.saveFailed")}</p>
            <p class="field-error" role="alert">
              {error()}
            </p>
            <button
              type="button"
              class="btn btn-primary pair-wide"
              ref={retryButton}
              aria-busy={busy()}
              disabled={busy()}
              onClick={retrySave}
            >
              {t("pairing.saveAgain")}
            </button>
          </div>
        </Match>
        {/* While connecting, the pairing appears before the key step: keep the form until then. */}
        <Match when={!busy() && pairing()}>
          {(paired) => <AlreadyPaired serverUrl={paired().serverUrl} />}
        </Match>
        <Match when={pairing() === null || busy()}>
          <p class="settings-intro">{t("pairing.connectIntro")}</p>
          <form class="card stack" onSubmit={submit}>
            <Field
              label={t("pairing.serverUrl")}
              hint={t("pairing.serverUrlHint")}
              type="url"
              required
              autocomplete="url"
              value={serverUrl()}
              onInput={setServerUrl}
            />
            <Field
              label={t("pairing.setupSecret")}
              hint={t("pairing.setupSecretHint")}
              type="password"
              required
              autocomplete="off"
              value={secret()}
              onInput={setSecret}
            />
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
            <button
              type="submit"
              class="btn btn-primary pair-wide"
              aria-busy={busy()}
              disabled={busy()}
            >
              {busy() ? t("pairing.connecting") : t("pairing.connect")}
            </button>
          </form>
        </Match>
      </Switch>
    </Screen>
  );
}
