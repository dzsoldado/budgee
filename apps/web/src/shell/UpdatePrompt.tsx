// Registers the service worker and, when a new build's worker is waiting, offers to reload into
// it. Until then the open app keeps running the version it started with. A long-open app also
// asks the server for a new worker every hour. In dev there is no service worker and this shows
// nothing.

import { useRegisterSW } from "virtual:pwa-register/solid";
import { onCleanup, onMount, Show } from "solid-js";
import { t } from "../i18n";

const UPDATE_CHECK_MS = 60 * 60 * 1000;

/** CSS variable with the card's height, so the content can keep clear of it (shell.css). */
const SPACE_VAR = "--update-prompt-space";

export function UpdatePrompt() {
  let timer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    clearInterval(timer);
  });

  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      if (!registration || disposed) return;
      clearInterval(timer);
      timer = setInterval(() => {
        if (navigator.onLine && !registration.installing) {
          registration.update().catch(() => {}); // offline or the server unreachable: next hour
        }
      }, UPDATE_CHECK_MS);
    },
    onRegisterError: (error) => console.error("Service worker registration failed", error),
  });

  const later = () => {
    setNeedRefresh(false);
    // The focused button goes away: continue from the screen instead of the page's start.
    document.getElementById("main")?.focus({ preventScroll: true });
  };

  // The live region stays in the page so the prompt is announced when it appears.
  return (
    <div class="update-prompt" role="status">
      <Show when={needRefresh()}>
        <PromptCard onLater={later} onReload={() => void updateServiceWorker()} />
      </Show>
    </div>
  );
}

function PromptCard(props: { onLater: () => void; onReload: () => void }) {
  let card!: HTMLDivElement;
  const root = document.documentElement;
  onMount(() => {
    const observer = new ResizeObserver(() => {
      root.style.setProperty(SPACE_VAR, `${card.offsetHeight}px`);
    });
    observer.observe(card);
    onCleanup(() => {
      observer.disconnect();
      root.style.removeProperty(SPACE_VAR);
    });
  });
  return (
    <div class="update-prompt-card card" ref={card}>
      <p class="update-prompt-text">{t("update.available")}</p>
      <div class="row row-tight">
        <button type="button" class="btn btn-secondary" onClick={() => props.onLater()}>
          {t("update.later")}
        </button>
        {/* Activates the waiting worker, which then reloads the page. */}
        <button type="button" class="btn btn-primary" onClick={() => props.onReload()}>
          {t("update.reload")}
        </button>
      </div>
    </div>
  );
}
