// The recovery key as shown at setup and in Settings → Encryption: the Crockford groups in a
// monospace block, the same text as a QR code, and a copy button.
import { createSignal, For, onCleanup } from "solid-js";
import { t } from "../i18n";
import { QrCode } from "./QrCode";

export function RecoveryKeyView(props: { recoveryKey: string }) {
  const groups = () => props.recoveryKey.split("-");
  const [copied, setCopied] = createSignal<"yes" | "failed">();
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));

  const copy = async () => {
    clearTimeout(timer);
    try {
      await navigator.clipboard.writeText(props.recoveryKey);
      setCopied("yes");
    } catch {
      setCopied("failed");
    }
    timer = setTimeout(() => setCopied(undefined), 4000);
  };

  return (
    <div class="recovery">
      {/* Groups wrap only between each other; the dashes stay in the text for copy and paste. */}
      <p class="recovery-key">
        <For each={groups()}>
          {(group, i) => (
            <span class="recovery-group">
              {group}
              {i() < groups().length - 1 ? "-" : ""}
            </span>
          )}
        </For>
      </p>
      <QrCode text={props.recoveryKey} label={t("recovery.qrLabel")} />
      <button type="button" class="btn btn-secondary recovery-copy" onClick={copy}>
        {t("recovery.copy")}
      </button>
      <p class="hint recovery-copied" role="status">
        {copied() === "yes"
          ? t("recovery.copied")
          : copied() === "failed"
            ? t("recovery.copyFailed")
            : ""}
      </p>
    </div>
  );
}
