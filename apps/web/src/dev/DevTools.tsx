// Settings → Developer, in dev builds only.
import { A, useNavigate } from "@solidjs/router";
import { createSignal, Show } from "solid-js";
import { useApp } from "../context";
import { type MessageKey, t } from "../i18n";
import { type DemoResult, loadDemo } from "./demo";
import { setDevSetupSecret } from "./prefill";

const RESULT_TEXT: Record<DemoResult, MessageKey> = {
  loaded: "dev.demoLoaded",
  not_fresh: "dev.demoNotFresh",
  paired: "dev.demoPaired",
};

export default function DevTools() {
  const { db, repo } = useApp();
  const [result, setResult] = createSignal<DemoResult>();
  const [busy, setBusy] = createSignal(false);

  const load = async () => {
    setBusy(true);
    try {
      setResult(await loadDemo(db, repo));
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    await db.delete();
    window.location.reload();
  };

  const navigate = useNavigate();
  const [secret, setSecret] = createSignal("");

  // Hands the secret to the real Connect form (in memory), which then works as for anyone.
  const prefill = (event: SubmitEvent) => {
    event.preventDefault();
    setDevSetupSecret(secret());
    setSecret("");
    navigate("/settings/connect");
  };

  return (
    <section class="section" aria-labelledby="dev-title">
      <h2 id="dev-title" class="section-title">
        {t("dev.title")}
      </h2>
      <div class="card stack">
        <div class="row">
          <button type="button" class="btn btn-primary" disabled={busy()} onClick={load}>
            {t("dev.demoLoad")}
          </button>
          <button type="button" class="btn btn-danger" onClick={reset}>
            {t("dev.reset")}
          </button>
        </div>
        <p class="hint" role="status">
          <Show when={result()} fallback={t("dev.demoHint")}>
            {(r) => t(RESULT_TEXT[r()])}
          </Show>
        </p>
        <p class="hint">{t("dev.resetHint")}</p>
        <A href="/dev/components">{t("dev.gallery")}</A>
      </div>

      <form class="card stack" onSubmit={prefill}>
        <label class="field">
          <span class="field-label">{t("dev.setupSecret")}</span>
          <input
            class="input"
            type="password"
            autocomplete="off"
            required
            value={secret()}
            onInput={(e) => setSecret(e.currentTarget.value)}
          />
        </label>
        <button type="submit" class="btn btn-secondary">
          {t("dev.prefillConnect")}
        </button>
        <p class="hint">{t("dev.prefillHint")}</p>
      </form>
    </section>
  );
}
