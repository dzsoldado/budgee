// Dev-only component gallery: the shared component styles in both themes, as in
// Foundations.dc.html ("Components in both themes").
import { createSignal } from "solid-js";
import { Segmented } from "../components/Segmented";
import { useApp } from "../context";
import { t } from "../i18n";
import { CloseIcon, TagIcon } from "../shell/icons";
import { Screen } from "../shell/Screen";

function Panel(props: { theme: "light" | "dark" }) {
  const { format } = useApp();
  const [appearance, setAppearance] = createSignal<"system" | "light" | "dark">("system");
  const [type, setType] = createSignal<"expense" | "income">("expense");
  const [elsewhere, setElsewhere] = createSignal(true);

  return (
    <div class="gallery-panel" data-theme={props.theme}>
      <span class="gallery-label">
        {t(props.theme === "light" ? "gallery.light" : "gallery.dark")}
      </span>
      <div class="row">
        <button type="button" class="btn btn-primary">
          {t("gallery.save")}
        </button>
        <button type="button" class="btn btn-secondary">
          {t("gallery.restore")}
        </button>
        <button type="button" class="btn btn-danger">
          {t("gallery.revoke")}
        </button>
      </div>
      <div class="row row-tight">
        <button type="button" class="chip" aria-pressed="true">
          {t("gallery.groceries")}
        </button>
        <button type="button" class="chip" aria-pressed="false">
          {t("gallery.transport")}
        </button>
        <button
          type="button"
          class="chip chip-tag"
          aria-label={t("gallery.removeTag", { tag: t("gallery.tag") })}
        >
          <TagIcon size={12} />
          {t("gallery.tag")}
          <CloseIcon size={12} />
        </button>
      </div>
      <div class="card gallery-money">
        <span class="gallery-money-row">
          <span>{t("gallery.freelance")}</span>
          <span class="amount-income gallery-money-value">
            {format.money(2_500_000, { sign: "always" })}
          </span>
        </span>
        <span class="gallery-money-row">
          <span>{t("gallery.groceries")}</span>
          <span class="gallery-money-value">{format.money(-324_000)}</span>
        </span>
        <span class="gallery-bars" aria-hidden="true">
          <span style={{ height: "26px", background: "var(--income)" }} />
          <span style={{ height: "12px", background: "var(--expense)" }} />
          <span class="gallery-bars-gap" />
          <span style={{ height: "22px", background: "var(--income)" }} />
          <span style={{ height: "16px", background: "var(--expense)" }} />
          <span class="gallery-bars-gap" />
          <span style={{ height: "18px", background: "var(--compare)" }} />
        </span>
      </div>
      <div class="row row-between">
        <span>{t("gallery.appearance")}</span>
        <Segmented
          label={t("gallery.appearance")}
          value={appearance()}
          onChange={setAppearance}
          options={[
            { value: "system", label: t("gallery.system") },
            { value: "light", label: t("gallery.light") },
            { value: "dark", label: t("gallery.dark") },
          ]}
        />
      </div>
      <Segmented
        wide
        label={t("gallery.type")}
        value={type()}
        onChange={setType}
        options={[
          { value: "expense", label: t("gallery.expense"), class: "segment-expense" },
          { value: "income", label: t("gallery.income"), class: "segment-income" },
        ]}
      />
      <div class="row row-between">
        <span>{t("gallery.paidElsewhere")}</span>
        <button
          type="button"
          class="switch"
          role="switch"
          aria-checked={elsewhere()}
          aria-label={t("gallery.paidElsewhere")}
          onClick={() => setElsewhere(!elsewhere())}
        />
      </div>
      <label class="field">
        <span class="field-label">{t("gallery.originalAmount")}</span>
        <input class="input num" inputmode="decimal" value="720.00" />
      </label>
      <input
        class="input"
        type="search"
        aria-label={t("gallery.search")}
        placeholder={t("gallery.search")}
      />
    </div>
  );
}

export default function Gallery() {
  return (
    <Screen title={t("dev.gallery")}>
      <p class="muted">{t("dev.galleryHint")}</p>
      <div class="gallery">
        <Panel theme="light" />
        <Panel theme="dark" />
      </div>
    </Screen>
  );
}
