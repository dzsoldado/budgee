// #/pair: joins this device to a server another device already uses. Opened from a pairing link
// (the camera app, or a pasted link) it asks for a device name and pairs; opened from Settings
// it offers to scan the QR code or paste the link. The link's parts are read once and dropped
// from the address and history right away; the key stays in memory until pairing is done.
import { importKey } from "@budgee/core";
import { A, useNavigate, useSearchParams } from "@solidjs/router";
import { createEffect, createSignal, Match, onMount, Show, Switch } from "solid-js";
import { QrScanner } from "../../components/QrScanner";
import { useApp } from "../../context";
import { type MessageKey, t } from "../../i18n";
import { defaultDeviceName } from "../../lib/device-name";
import { QrIcon } from "../../shell/icons";
import { Screen } from "../../shell/Screen";
import {
  type PairingLink,
  type PairingLinkProblem,
  parsePairingLink,
  readPairingParams,
} from "../../sync/link";
import { pairingErrorText, pairWithCode } from "../../sync/pairing";
import { announce } from "../../sync/status";
import { settingsBack } from "./common";
import { AlreadyPaired, checkDeviceName, createLivePairing, Field, hostOf } from "./pairing-common";

const LINK_PROBLEM: Record<Exclude<PairingLinkProblem, "other_origin" | "insecure">, MessageKey> = {
  not_link: "pair.notLink",
  incomplete: "pair.incomplete",
  bad_key: "pair.badKey",
};

/** Why a link can't be used, naming the hosts involved where it is about where the link leads. */
function linkProblemText({ problem, host = "" }: { problem: PairingLinkProblem; host?: string }) {
  if (problem === "other_origin") {
    return t("pair.otherOrigin", { linkHost: host, appHost: window.location.host });
  }
  if (problem === "insecure") return t("pair.insecure", { host });
  return t(LINK_PROBLEM[problem]);
}

export function PairScreen() {
  const { db, platform, sync } = useApp();
  const navigate = useNavigate();
  const [params] = useSearchParams<{ c: string; k: string; s: string }>();
  const pairing = createLivePairing(db);
  const [link, setLink] = createSignal<PairingLink>();
  const [linkProblem, setLinkProblem] = createSignal<string>();
  const [scanning, setScanning] = createSignal(false);
  const [pasted, setPasted] = createSignal("");
  const [name, setName] = createSignal(defaultDeviceName(navigator.userAgent));
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [nameError, setNameError] = createSignal<string>();
  let confirmTitle: HTMLHeadingElement | undefined;

  const show = (next: PairingLink) => {
    setLink(next);
    setLinkProblem(undefined);
    setError(undefined);
    queueMicrotask(() => confirmTitle?.focus());
  };

  onMount(() => {
    const parsed = readPairingParams(
      { c: params.c, k: params.k, s: params.s },
      window.location.origin,
    );
    if (!parsed) return;
    // Replaces this history entry, so the key leaves the address bar and the history.
    navigate("/pair", { replace: true });
    if (parsed.ok) show(parsed.link);
    else setLinkProblem(linkProblemText(parsed));
  });

  // An already paired device refuses the link: let go of its key at once.
  createEffect(() => {
    if (pairing() && !busy()) setLink(undefined);
  });

  const usePasted = (event: SubmitEvent) => {
    event.preventDefault();
    const parsed = parsePairingLink(pasted(), window.location.origin);
    if (parsed.ok) {
      setPasted("");
      show(parsed.link);
    } else setLinkProblem(linkProblemText(parsed));
  };

  const onScanned = (text: string): true | string => {
    const parsed = parsePairingLink(text, window.location.origin);
    if (!parsed.ok) {
      return parsed.problem === "not_link" ? t("scan.notPairing") : linkProblemText(parsed);
    }
    setScanning(false);
    show(parsed.link);
    return true;
  };

  const pair = async (event: SubmitEvent) => {
    event.preventDefault();
    const current = link();
    if (!current || busy()) return;
    const deviceName = checkDeviceName(name(), setNameError);
    if (!deviceName) return;
    setError(undefined);
    setBusy(true);
    try {
      await pairWithCode(
        { db, platform },
        {
          serverUrl: current.origin,
          code: current.code,
          deviceName,
          vaultKey: await importKey(current.key),
          serverId: current.serverId,
        },
      );
      setLink(undefined);
      void sync.syncNow({ manual: true });
      announce(t("pair.done", { host: hostOf(current.origin) }));
      navigate("/settings", { replace: true });
    } catch (failure) {
      setError(pairingErrorText(failure, hostOf(current.origin)));
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    setLink(undefined);
    setError(undefined);
  };

  return (
    <Screen title={t("pair.title")} back={settingsBack()} class="settings pairing">
      <Switch>
        <Match when={!busy() && pairing()}>
          {(paired) => <AlreadyPaired serverUrl={paired().serverUrl} />}
        </Match>
        <Match when={link()}>
          {(current) => (
            <form class="card stack" onSubmit={pair} aria-labelledby="pair-confirm-title">
              <h2 id="pair-confirm-title" class="pair-title" tabindex="-1" ref={confirmTitle}>
                {t("pair.confirmTitle")}
              </h2>
              <p class="pair-text">{t("pair.confirmText", { host: hostOf(current().origin) })}</p>
              <Field
                label={t("pairing.deviceName")}
                hint={t("pairing.deviceNameHint")}
                required
                maxLength={100}
                value={name()}
                error={nameError()}
                onInput={(value) => {
                  setName(value);
                  setNameError(undefined);
                }}
              />
              <p class="field-error" role="alert">
                {error()}
              </p>
              <div class="pair-actions">
                <button type="button" class="btn btn-secondary" onClick={cancel}>
                  {t("lists.cancel")}
                </button>
                <button type="submit" class="btn btn-primary" aria-busy={busy()} disabled={busy()}>
                  {busy() ? t("pair.pairing") : t("pair.pair")}
                </button>
              </div>
            </form>
          )}
        </Match>
        <Match when={pairing() === null}>
          <p class="settings-intro">{t("pair.intro")}</p>
          <Show when={linkProblem()}>
            {(problem) => (
              <p class="field-error pair-problem" role="alert">
                {problem()}
              </p>
            )}
          </Show>
          <section class="card stack" aria-labelledby="pair-scan-title">
            <h2 id="pair-scan-title" class="pair-subtitle">
              {t("pair.scanTitle")}
            </h2>
            <Show
              when={scanning()}
              fallback={
                <>
                  <p class="hint">{t("pair.scanHint")}</p>
                  <button
                    type="button"
                    class="btn btn-primary pair-wide"
                    onClick={() => setScanning(true)}
                  >
                    <QrIcon size={18} />
                    {t("pair.scan")}
                  </button>
                </>
              }
            >
              <QrScanner onCode={onScanned} onClose={() => setScanning(false)} />
            </Show>
          </section>
          <form class="card stack" onSubmit={usePasted} aria-labelledby="pair-paste-title">
            <h2 id="pair-paste-title" class="pair-subtitle">
              {t("pair.pasteTitle")}
            </h2>
            <Field
              label={t("pair.pasteLabel")}
              hint={t("pair.pasteHint")}
              type="url"
              required
              autocomplete="off"
              spellcheck={false}
              value={pasted()}
              onInput={(value) => {
                setPasted(value);
                setLinkProblem(undefined);
              }}
            />
            <button type="submit" class="btn btn-secondary pair-wide">
              {t("pair.continue")}
            </button>
          </form>
          <p class="settings-note">
            {t("pair.restoreNote")} <A href="/settings/restore">{t("pair.restoreLink")}</A>
          </p>
        </Match>
      </Switch>
    </Screen>
  );
}
