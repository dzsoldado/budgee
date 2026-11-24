// The List header's sync indicator (Main.dc.html): a "sync now" button once paired, and a link
// to Settings, where pairing starts, while not paired (or after this device was removed).
import { useHref } from "@solidjs/router";
import { createMemo, Show } from "solid-js";
import { useApp } from "../context";
import { RefreshIcon } from "../shell/icons";
import { createNow, describeSync, dotClass, syncStatus } from "./status";

export function SyncPill() {
  const settings = useHref(() => "/settings");
  const { view, syncNow } = useSyncView();

  return (
    <Show
      when={view().canSync}
      fallback={
        <a class="sync-pill" href={settings()} aria-label={view().action} title={view().note}>
          <span class={dotClass(view())} />
          <span class="sync-pill-text">{view().short}</span>
        </a>
      }
    >
      <button
        type="button"
        class="sync-pill"
        aria-label={view().action}
        aria-busy={view().syncing}
        title={view().note ?? view().label}
        onClick={syncNow}
      >
        <span class={dotClass(view())} />
        <span class="sync-pill-text">{view().short}</span>
        <span class="sync-icon" classList={{ "sync-icon-spinning": view().syncing }}>
          <RefreshIcon size={14} />
        </span>
      </button>
    </Show>
  );
}

/** The status line, note and "Sync now" button of the sidebar card and Settings. */
export function useSyncView() {
  const { sync, settings } = useApp();
  const now = createNow();
  const view = createMemo(() => describeSync(syncStatus(), now(), settings().locale));
  const syncNow = () => {
    if (!view().syncing) void sync.syncNow({ manual: true });
  };
  return { view, syncNow };
}
