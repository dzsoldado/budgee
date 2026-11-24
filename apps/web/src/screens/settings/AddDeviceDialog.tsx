// Settings → Add device with QR code: a one-time pairing code from the server, shown with the
// vault key as a pairing link QR code for 10 minutes. The link exists only while this is open.
import { exportKey, PAIRING_CODE_TTL_MS } from "@budgee/core";
import {
  createEffect,
  createMemo,
  createSignal,
  Match,
  on,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import { Dialog } from "../../components/Dialog";
import { QrCode } from "../../components/QrCode";
import { useApp } from "../../context";
import { getMeta } from "../../db/db";
import { t } from "../../i18n";
import { readPairing } from "../../sync/controller";
import { buildPairingLink } from "../../sync/link";
import { pairingErrorText } from "../../sync/pairing";
import { hostOf } from "./pairing-common";

interface Invite {
  link: string;
  code: string;
  /** Local time the code expires (the server's 10 minutes, counted from the request). */
  deadline: number;
}

/** "ABCD1234" → "ABCD-1234", easier to read out and type. */
const groupCode = (code: string) => code.match(/.{1,4}/g)?.join("-") ?? code;

/** "9:41" */
const countdown = (ms: number) => {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

export function AddDeviceDialog(props: { open: boolean; onClose: () => void }) {
  const { db, platform } = useApp();
  const [invite, setInvite] = createSignal<Invite>();
  const [error, setError] = createSignal<string>();
  const [loading, setLoading] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());
  const [copied, setCopied] = createSignal<"yes" | "failed">();
  let request = 0;

  const remaining = () => (invite()?.deadline ?? 0) - now();
  const expired = createMemo(() => invite() !== undefined && remaining() <= 0);
  /** For screen readers, read on demand: changes once a minute, not every second. */
  const minutesLeft = createMemo(() => Math.ceil(remaining() / 60_000));
  let newCodeButton: HTMLButtonElement | undefined;

  // On expiry the code and anything copied are of no use: say so and offer a new code.
  createEffect(
    on(expired, (isExpired) => {
      if (!isExpired) return;
      setCopied(undefined);
      queueMicrotask(() => newCodeButton?.focus());
    }),
  );

  const load = async () => {
    const id = ++request;
    setInvite(undefined);
    setError(undefined);
    setCopied(undefined);
    setLoading(true);
    const started = Date.now();
    let host = "";
    try {
      const [pairing, serverId] = await Promise.all([readPairing(db), getMeta(db, "serverId")]);
      if (!pairing || !serverId) throw new Error("Not paired");
      const { serverUrl, deviceToken, vaultKey } = pairing;
      host = hostOf(serverUrl);
      const { code } = await platform.createDeviceApi({ serverUrl, deviceToken }).invite();
      const link = buildPairingLink({
        origin: serverUrl,
        code,
        key: await exportKey(vaultKey),
        serverId,
      });
      if (id === request) setInvite({ link, code, deadline: started + PAIRING_CODE_TTL_MS });
    } catch (failure) {
      if (id === request) setError(pairingErrorText(failure, host));
    } finally {
      if (id === request) setLoading(false);
    }
  };

  // A fresh code each time it opens; everything is dropped when it closes.
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (open) {
          void load();
          setNow(Date.now());
          const timer = setInterval(() => setNow(Date.now()), 1000);
          onCleanup(() => clearInterval(timer));
        } else {
          request++;
          setInvite(undefined);
          setError(undefined);
          setCopied(undefined);
        }
      },
    ),
  );

  const copy = async () => {
    const current = invite();
    if (!current) return;
    try {
      await navigator.clipboard.writeText(current.link);
      setCopied("yes");
    } catch {
      setCopied("failed");
    }
  };

  return (
    <Dialog
      open={props.open}
      title={t("addDevice.title")}
      view={invite() ? "ready" : "wait"}
      onClose={props.onClose}
    >
      <div class="add-device">
        <Switch>
          <Match when={error()}>
            {(text) => (
              <>
                <p class="field-error" role="alert">
                  {text()}
                </p>
                <button type="button" class="btn btn-secondary" onClick={load}>
                  {t("addDevice.retry")}
                </button>
              </>
            )}
          </Match>
          <Match when={loading()}>
            <p class="confirm-body" role="status">
              {t("addDevice.loading")}
            </p>
          </Match>
          <Match when={invite()}>
            {(current) => (
              <>
                <p class="confirm-body">{t("addDevice.scanHint")}</p>
                <div class="add-device-qr" classList={{ "add-device-expired": expired() }}>
                  <Show
                    when={!expired()}
                    fallback={<span class="add-device-expired-text">{t("addDevice.expired")}</span>}
                  >
                    <QrCode text={current().link} label={t("addDevice.qrLabel")} />
                  </Show>
                </div>
                <Show
                  when={!expired()}
                  fallback={<p class="add-device-timer">{t("addDevice.expiredHint")}</p>}
                >
                  <p class="add-device-code">
                    <span class="muted">{t("addDevice.code")}</span>{" "}
                    <span class="add-device-code-value">{groupCode(current().code)}</span>
                  </p>
                  <p class="add-device-timer num">
                    <span aria-hidden="true">
                      {t("addDevice.expiresIn", { time: countdown(remaining()) })}
                    </span>
                    <span class="visually-hidden">
                      {minutesLeft() > 1
                        ? t("addDevice.minutesLeft", { n: minutesLeft() })
                        : t("addDevice.underMinuteLeft")}
                    </span>
                  </p>
                  <p class="hint">{t("addDevice.codeHint")}</p>
                  <p class="pair-warning">{t("addDevice.linkWarning")}</p>
                </Show>
                <p class="visually-hidden" role="status">
                  {expired() ? t("addDevice.expired") : ""}
                </p>
              </>
            )}
          </Match>
        </Switch>
        <p class="hint" role="status">
          {copied() === "yes"
            ? t("addDevice.copied")
            : copied() === "failed"
              ? t("addDevice.copyFailed")
              : ""}
        </p>
        <div class="confirm-actions">
          <Show
            when={expired()}
            fallback={
              <button type="button" class="btn btn-secondary" disabled={!invite()} onClick={copy}>
                {t("addDevice.copyLink")}
              </button>
            }
          >
            <button
              type="button"
              class="btn btn-secondary"
              ref={newCodeButton}
              data-autofocus
              onClick={load}
            >
              {t("addDevice.newCode")}
            </button>
          </Show>
          <button type="button" class="btn btn-primary" onClick={props.onClose}>
            {t("addDevice.done")}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
