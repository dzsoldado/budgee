// Settings → Encryption → Show recovery key: a warning to confirm first, then the key as at
// setup. The key text is dropped when the dialog closes.
import { createEffect, createSignal, on, Show } from "solid-js";
import { Dialog } from "../../components/Dialog";
import { RecoveryKeyView } from "../../components/RecoveryKeyView";
import { useApp } from "../../context";
import { getMeta } from "../../db/db";
import { t } from "../../i18n";
import { recoveryKeyOf } from "../../sync/pairing";

export function RecoveryKeyDialog(props: { open: boolean; onClose: () => void }) {
  const { db } = useApp();
  const [recoveryKey, setRecoveryKey] = createSignal<string>();
  const [failed, setFailed] = createSignal(false);

  createEffect(
    on(
      () => props.open,
      () => {
        setRecoveryKey(undefined);
        setFailed(false);
      },
    ),
  );

  const reveal = async () => {
    try {
      const key = await getMeta(db, "vaultKey");
      if (!key) throw new Error("No vault key on this device");
      setRecoveryKey(await recoveryKeyOf(key));
    } catch {
      setFailed(true);
    }
  };

  return (
    <Dialog
      open={props.open}
      title={recoveryKey() ? t("recovery.title") : t("recovery.confirmTitle")}
      view={recoveryKey() ? "key" : "confirm"}
      onClose={props.onClose}
    >
      <Show
        when={recoveryKey()}
        fallback={
          <>
            <p class="confirm-body">{t("recovery.confirmBody")}</p>
            <Show when={failed()}>
              <p class="field-error" role="alert">
                {t("recovery.failed")}
              </p>
            </Show>
            <div class="confirm-actions">
              <button type="button" class="btn btn-secondary" onClick={props.onClose}>
                {t("lists.cancel")}
              </button>
              <button type="button" class="btn btn-primary" onClick={reveal}>
                {t("recovery.show")}
              </button>
            </div>
          </>
        }
      >
        {(key) => (
          <div class="recovery-dialog">
            <p class="confirm-body">{t("recovery.dialogText")}</p>
            <RecoveryKeyView recoveryKey={key()} />
            <div class="confirm-actions">
              <button type="button" class="btn btn-primary" data-autofocus onClick={props.onClose}>
                {t("addDevice.done")}
              </button>
            </div>
          </div>
        )}
      </Show>
    </Dialog>
  );
}
