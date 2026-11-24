// Settings → Sync and devices (Settings.dc.html): the sync status with the server's host, then
// either the ways to join a server (not paired) or the server's device list with rename and
// revoke, "Add device with QR code" and "Forget pairing on this device".
import { type Device, SyncError } from "@budgee/core";
import { A } from "@solidjs/router";
import { createEffect, createMemo, createSignal, createUniqueId, For, on, Show } from "solid-js";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Dialog } from "../../components/Dialog";
import { useApp } from "../../context";
import { t } from "../../i18n";
import { createMediaQuery, WIDE_QUERY } from "../../lib/media";
import {
  ChevronRightIcon,
  CloudIcon,
  DesktopIcon,
  KeyIcon,
  PhoneIcon,
  QrIcon,
} from "../../shell/icons";
import { canRevoke, forgetPairing, pairingErrorText } from "../../sync/pairing";
import { useSyncView } from "../../sync/SyncPill";
import { announce, createNow, dotClass, syncStatus, timeAgo } from "../../sync/status";
import { AddDeviceDialog } from "./AddDeviceDialog";
import { createLivePairing, Field, hostOf } from "./pairing-common";

const looksLikePhone = (name: string) => /android|iphone|ipad|phone|mobile|pixel/i.test(name);

function JoinLink(props: {
  href: string;
  icon: "cloud" | "qr" | "key";
  title: string;
  meta: string;
}) {
  return (
    <A href={props.href} class="settings-link settings-join">
      <span class="settings-join-icon">
        {props.icon === "cloud" ? (
          <CloudIcon size={18} />
        ) : props.icon === "qr" ? (
          <QrIcon size={18} />
        ) : (
          <KeyIcon size={18} />
        )}
      </span>
      <span class="settings-item-text">
        <span class="settings-item-name">{props.title}</span>
        <span class="settings-item-meta">{props.meta}</span>
      </span>
      <ChevronRightIcon size={16} />
    </A>
  );
}

type Revoking = { device: Device; step: 1 | 2 };

export function SyncSection(props: { onThisDevice: (name: string | undefined) => void }) {
  const { db, platform, sync, settings } = useApp();
  const wide = createMediaQuery(WIDE_QUERY);
  const syncView = useSyncView();
  const pairing = createLivePairing(db);
  const now = createNow();
  const [devices, setDevices] = createSignal<Device[]>();
  const [listError, setListError] = createSignal<string>();
  const [adding, setAdding] = createSignal(false);
  const [editing, setEditing] = createSignal<Device>();
  const [newName, setNewName] = createSignal("");
  const [renameError, setRenameError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const [revoking, setRevoking] = createSignal<Revoking>();
  const [forgetting, setForgetting] = createSignal(false);
  const [actionError, setActionError] = createSignal<string>();
  let title!: HTMLHeadingElement;

  const host = () => {
    const paired = pairing();
    return paired ? hostOf(paired.serverUrl) : "";
  };
  const revoked = () => syncStatus().kind === "revoked";
  const api = () => {
    const paired = pairing();
    if (!paired) throw new Error("Not paired");
    return platform.createDeviceApi({
      serverUrl: paired.serverUrl,
      deviceToken: paired.deviceToken,
    });
  };

  const loadDevices = async () => {
    setListError(undefined);
    try {
      setDevices(await api().list());
    } catch (error) {
      setDevices(undefined);
      setListError(pairingErrorText(error, host()));
      // The server may have removed this device: let the sync status say so.
      void sync.syncNow();
    }
  };

  // A memo, so only a new token (or a revoke) reloads: every sync status change would rerun it,
  // and offline each failed load starts a sync whose status change would load again.
  const activeToken = createMemo(() => (revoked() ? undefined : pairing()?.deviceToken));
  createEffect(
    on(activeToken, (token) => {
      setDevices(undefined);
      setListError(undefined);
      if (token) void loadDevices();
    }),
  );
  createEffect(() => props.onThisDevice(devices()?.find((d) => d.current)?.name));

  const dateFormat = createMemo(
    () => new Intl.DateTimeFormat(settings().locale, { dateStyle: "medium" }),
  );
  const deviceMeta = (device: Device) => {
    const added = dateFormat().format(device.createdAt);
    if (device.revoked) return t("devices.metaRevoked", { added });
    if (device.lastSeen === null) return t("devices.metaAdded", { added });
    const seen = timeAgo(device.lastSeen, now(), settings().locale).short;
    return t("devices.meta", { seen, added });
  };

  /** The device being edited can be revoked: it is not the last one the server has. */
  const revocable = () => {
    const device = editing();
    return device !== undefined && canRevoke(devices() ?? [], device);
  };
  const onlyDeviceId = createUniqueId();

  const replaceDevice = (next: Device) =>
    setDevices((list) => list?.map((d) => (d.id === next.id ? next : d)));

  const openEdit = (device: Device) => {
    setNewName(device.name);
    setRenameError(undefined);
    setEditing(device);
  };

  const rename = async (event: SubmitEvent) => {
    event.preventDefault();
    const device = editing();
    const name = newName().trim();
    if (!device || busy()) return;
    if (name === device.name) return setEditing(undefined);
    setBusy(true);
    try {
      replaceDevice(await api().rename(device.id, name));
      setEditing(undefined);
      announce(t("devices.renamed", { name }));
    } catch (error) {
      setRenameError(pairingErrorText(error, host()));
    } finally {
      setBusy(false);
    }
  };

  const startRevoke = (device: Device) => {
    setEditing(undefined);
    setActionError(undefined);
    setRevoking({ device, step: 1 });
  };

  const confirmRevoke = async () => {
    const current = revoking();
    if (!current) return;
    const { device, step } = current;
    if (device.current && step === 1) return setRevoking({ device, step: 2 });
    setRevoking(undefined);
    try {
      if (device.current) {
        // No sync runs between the revoke and clearing the pairing it would trip over.
        const self = api();
        await sync.exclusive(async () => {
          await self.revoke(device.id, { confirmSelf: true });
          await forgetPairing(db);
        });
        await sync.syncNow();
        title.focus();
        announce(t("devices.revokedSelf"));
      } else {
        replaceDevice(await api().revoke(device.id));
        announce(t("devices.revokedOther", { name: device.name }));
      }
    } catch (error) {
      setActionError(pairingErrorText(error, host()));
      // Refused as the last device: another one was revoked meanwhile, so show the list as it is.
      if (error instanceof SyncError && error.code === "last_device") void loadDevices();
    }
  };

  const forget = async () => {
    setForgetting(false);
    try {
      await sync.exclusive(() => forgetPairing(db));
      await sync.syncNow();
      title.focus();
      announce(t("devices.forgotten"));
    } catch (error) {
      console.error("Forgetting the pairing failed", error);
      setActionError(t("pairing.error.unknown"));
    }
  };

  const revokeText = () => {
    const current = revoking();
    if (!current) return { title: "", body: "", confirm: "" };
    const { device, step } = current;
    if (!device.current) {
      return {
        title: t("devices.revokeTitle", { name: device.name }),
        body: t("devices.revokeBody"),
        confirm: t("devices.revoke"),
      };
    }
    return step === 1
      ? {
          title: t("devices.revokeSelfTitle"),
          body: t("devices.revokeSelfBody", { host: host() }),
          confirm: t("devices.continue"),
        }
      : {
          title: t("devices.revokeSelfConfirmTitle", { name: device.name }),
          body: t("devices.revokeSelfConfirmBody", { name: device.name }),
          confirm: t("devices.revokeSelf"),
        };
  };

  const ThisDeviceRow = (rowProps: { meta: string }) => (
    <div class="settings-device">
      <span class="settings-device-icon">
        <Show when={wide()} fallback={<PhoneIcon size={18} />}>
          <DesktopIcon size={18} />
        </Show>
      </span>
      <span class="settings-item-text">
        <span class="settings-item-name">{t("settings.thisDevice")}</span>
        <span class="settings-item-meta">{rowProps.meta}</span>
      </span>
    </div>
  );

  return (
    <section class="section" aria-labelledby="settings-sync">
      <h2 id="settings-sync" class="section-title" tabindex="-1" ref={title}>
        {t("settings.sync")}
      </h2>
      <div class="settings-card">
        <div class="settings-status">
          <span class="settings-item-text">
            <span class="settings-status-line">
              <span class={dotClass(syncView.view())} />
              {syncView.view().label}
            </span>
            <span class="settings-item-meta">
              {pairing() ? host() : t("settings.syncLocalOnly")}
            </span>
            {/* Removed: the note under the card says what to do, once. */}
            <Show when={pairing() && !revoked() && syncView.view().note}>
              {(note) => <span class="settings-item-meta">{note()}</span>}
            </Show>
          </span>
          <Show when={pairing()}>
            <button
              type="button"
              class="btn btn-secondary settings-small-btn"
              disabled={!syncView.view().canSync}
              aria-busy={syncView.view().syncing}
              aria-disabled={syncView.view().syncing}
              onClick={syncView.syncNow}
            >
              {t("settings.syncNow")}
            </button>
          </Show>
        </div>

        <Show when={pairing() === null}>
          <ThisDeviceRow meta={t("settings.thisDeviceMeta")} />
          <JoinLink
            href="/settings/connect"
            icon="cloud"
            title={t("settings.connect")}
            meta={t("settings.connectMeta")}
          />
          <JoinLink
            href="/pair"
            icon="qr"
            title={t("settings.pairDevice")}
            meta={t("settings.pairDeviceMeta")}
          />
          <JoinLink
            href="/settings/restore"
            icon="key"
            title={t("settings.restoreKey")}
            meta={t("settings.restoreKeyMeta")}
          />
        </Show>

        <Show when={pairing() && revoked()}>
          <ThisDeviceRow meta={t("settings.thisDeviceRemoved")} />
        </Show>

        <Show when={pairing() && !revoked()}>
          <Show
            when={devices()}
            fallback={
              <div class="settings-device settings-device-status">
                <Show
                  when={listError()}
                  fallback={<span class="hint">{t("devices.loading")}</span>}
                >
                  {(text) => (
                    <>
                      <span class="field-error settings-device-error">{text()}</span>
                      <button
                        type="button"
                        class="btn btn-secondary settings-small-btn"
                        onClick={loadDevices}
                      >
                        {t("devices.retry")}
                      </button>
                    </>
                  )}
                </Show>
              </div>
            }
          >
            {(list) => (
              <ul class="settings-list" aria-label={t("devices.listLabel")}>
                <For each={list()}>
                  {(device) => (
                    <li
                      class="settings-device"
                      classList={{ "settings-device-revoked": device.revoked }}
                    >
                      <span class="settings-device-icon">
                        <Show
                          when={looksLikePhone(device.name)}
                          fallback={<DesktopIcon size={18} />}
                        >
                          <PhoneIcon size={18} />
                        </Show>
                      </span>
                      <Show
                        when={!device.revoked}
                        fallback={
                          <span class="settings-item-text settings-device-main">
                            <span class="settings-item-name">{device.name}</span>
                            <span class="settings-item-meta">{deviceMeta(device)}</span>
                          </span>
                        }
                      >
                        <button
                          type="button"
                          class="settings-device-main settings-device-open"
                          aria-haspopup="dialog"
                          onClick={() => openEdit(device)}
                        >
                          <span class="settings-item-text">
                            <span class="settings-item-name">
                              {device.name}
                              <Show when={device.current}>
                                {" "}
                                <span class="device-badge">{t("devices.thisDevice")}</span>
                              </Show>
                            </span>
                            <span class="settings-item-meta">{deviceMeta(device)}</span>
                          </span>
                          <ChevronRightIcon size={16} />
                        </button>
                      </Show>
                      <Show when={!device.current && canRevoke(list(), device)}>
                        <button
                          type="button"
                          class="btn btn-danger settings-revoke"
                          aria-label={t("devices.revokeNamed", { name: device.name })}
                          aria-haspopup="dialog"
                          onClick={() => startRevoke(device)}
                        >
                          {t("devices.revoke")}
                        </button>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            )}
          </Show>
          <button
            type="button"
            class="settings-add"
            aria-haspopup="dialog"
            onClick={() => setAdding(true)}
          >
            <QrIcon size={18} />
            {t("settings.addDevice")}
          </button>
        </Show>
      </div>

      <Show when={actionError()}>
        {(text) => (
          <p class="field-error settings-error" role="alert">
            {text()}
          </p>
        )}
      </Show>
      <Show
        when={pairing()}
        fallback={<p class="settings-note">{t("settings.syncUnpairedNote")}</p>}
      >
        <Show when={revoked()}>
          <p class="settings-note">{t("settings.revokedNote")}</p>
        </Show>
        <button
          type="button"
          class="settings-text-btn"
          aria-haspopup="dialog"
          onClick={() => setForgetting(true)}
        >
          {t("devices.forget")}
        </button>
      </Show>

      <AddDeviceDialog open={adding()} onClose={() => setAdding(false)} />

      <Dialog
        open={editing() !== undefined}
        title={t("devices.renameTitle")}
        onClose={() => setEditing(undefined)}
      >
        <form class="dialog-form" onSubmit={rename}>
          <Field
            label={t("devices.name")}
            required
            maxLength={100}
            autofocus
            invalid={renameError() !== undefined}
            value={newName()}
            onInput={(value) => {
              setNewName(value);
              setRenameError(undefined);
            }}
          />
          <p class="field-error" role="alert">
            {renameError()}
          </p>
          <div class="confirm-actions">
            <button type="button" class="btn btn-secondary" onClick={() => setEditing(undefined)}>
              {t("lists.cancel")}
            </button>
            <button type="submit" class="btn btn-primary" disabled={busy()}>
              {t("lists.save")}
            </button>
          </div>
          <div class="dialog-more">
            <button
              type="button"
              class="btn btn-danger"
              disabled={!revocable()}
              aria-describedby={revocable() ? undefined : onlyDeviceId}
              onClick={() => {
                const device = editing();
                if (device) startRevoke(device);
              }}
            >
              {editing()?.current ? t("devices.revokeSelfMore") : t("devices.revokeMore")}
            </button>
            <Show when={!revocable()}>
              <p id={onlyDeviceId} class="hint dialog-more-note">
                {t("devices.onlyDevice")}
              </p>
            </Show>
          </div>
        </form>
      </Dialog>

      <ConfirmDialog
        open={revoking() !== undefined}
        title={revokeText().title}
        body={revokeText().body}
        confirmLabel={revokeText().confirm}
        cancelLabel={t("lists.cancel")}
        destructive
        view={String(revoking()?.step ?? "")}
        onConfirm={confirmRevoke}
        onCancel={() => setRevoking(undefined)}
      />

      <ConfirmDialog
        open={forgetting()}
        title={t("devices.forgetTitle")}
        body={t("devices.forgetBody", { host: host() })}
        confirmLabel={t("devices.forgetConfirm")}
        cancelLabel={t("lists.cancel")}
        destructive
        onConfirm={forget}
        onCancel={() => setForgetting(false)}
      />
    </section>
  );
}
