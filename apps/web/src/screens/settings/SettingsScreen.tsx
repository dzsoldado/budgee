// Settings (Settings.dc.html): General preferences, how entries are grouped, sync and devices,
// backups, encryption (the recovery key), and your data (CSV import, export and the live CSV
// file). The Developer section follows in dev builds.
import {
  type AmountDecimals,
  CURRENCIES,
  currencyName,
  formatAmount,
  listTags,
  type SettingKey,
  type SettingValues,
} from "@budgee/core";
import { A } from "@solidjs/router";
import { createMemo, createSignal, For, lazy, Show } from "solid-js";
import { version } from "../../../package.json";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Segmented } from "../../components/Segmented";
import { useApp } from "../../context";
import { createLiveQuery } from "../../db/live";
import { LANGUAGES, t } from "../../i18n";
import { sortByOrder } from "../../list/categories";
import { ChevronRightIcon, KeyIcon } from "../../shell/icons";
import { Screen } from "../../shell/Screen";
import { BackupsSection } from "./BackupsSection";
import { createLiveEntries } from "./common";
import { DataSection } from "./DataSection";
import { createLivePairing } from "./pairing-common";
import { RecoveryKeyDialog } from "./RecoveryKeyDialog";
import { SyncSection } from "./SyncSection";

const DevTools = import.meta.env.DEV ? lazy(() => import("../../dev/DevTools")) : () => null;

/** A sample amount for the currency confirmation: 1,500 in the main unit. */
const SAMPLE = 150_000;

function languageName(code: string): string {
  try {
    return new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** A settings row whose value opens a native select laid over the whole row. */
function SelectRow(props: {
  label: string;
  value: string;
  display: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string, select: HTMLSelectElement) => void;
}) {
  return (
    <div class="settings-row settings-select-row">
      <span>{props.label}</span>
      <span class="settings-value">
        <span class="settings-value-text">{props.display}</span>
        <ChevronRightIcon size={16} />
      </span>
      <select
        class="settings-select"
        aria-label={props.label}
        value={props.value}
        onChange={(event) => props.onChange(event.currentTarget.value, event.currentTarget)}
      >
        <For each={props.options}>
          {(option) => <option value={option.value}>{option.label}</option>}
        </For>
      </select>
    </div>
  );
}

function LinkRow(props: { href: string; title: string; meta: string }) {
  return (
    <A href={props.href} class="settings-link">
      <span class="settings-item-text">
        <span class="settings-item-name">{props.title}</span>
        <span class="settings-item-meta">{props.meta}</span>
      </span>
      <ChevronRightIcon size={16} />
    </A>
  );
}

export function SettingsScreen() {
  const { db, repo, settings } = useApp();
  const pairing = createLivePairing(db);
  const [thisDevice, setThisDevice] = createSignal<string>();
  const [showingKey, setShowingKey] = createSignal(false);
  const categoryRows = createLiveQuery(() => db.categories.toArray());
  const entries = createLiveEntries(db);
  const [saveFailed, setSaveFailed] = createSignal(false);
  const [pendingCurrency, setPendingCurrency] = createSignal<string>();

  const save = <K extends SettingKey>(key: K, value: SettingValues[K]) => {
    setSaveFailed(false);
    repo.setSetting(key, value).catch((error: unknown) => {
      console.error("Saving the setting failed", error);
      setSaveFailed(true);
    });
  };

  const locale = () => settings().locale;
  const currencyLabel = (code: string) =>
    t("settings.currencyOption", { code, name: currencyName(code, locale()) });
  const currencies = createMemo(() => {
    const current = settings().currency;
    const codes = CURRENCIES.includes(current) ? CURRENCIES : [current, ...CURRENCIES];
    return codes.map((code) => ({ value: code, label: currencyLabel(code) }));
  });
  const languages = createMemo(() => {
    const codes = LANGUAGES.includes(locale()) ? LANGUAGES : [locale(), ...LANGUAGES];
    return codes.map((code) => ({ value: code, label: languageName(code) }));
  });
  const sample = (currency: string) =>
    formatAmount(SAMPLE, { currency, decimals: settings().decimals, locale: locale() });

  const categoryCounts = createMemo(() => {
    const active = sortByOrder(categoryRows() ?? []).filter((c) => !c.archived);
    const of = (type: "income" | "expense") => active.filter((c) => c.type === type).length;
    return { expense: of("expense"), income: of("income") };
  });
  const tagCount = createMemo(() => listTags(entries() ?? []).length);

  return (
    <Screen title={t("settings.title")} class="settings">
      <section class="section" aria-labelledby="settings-general">
        <h2 id="settings-general" class="section-title">
          {t("settings.general")}
        </h2>
        <div class="settings-card">
          <div class="settings-row settings-row-tall">
            <span>{t("settings.appearance")}</span>
            <Segmented
              label={t("settings.appearance")}
              options={[
                { value: "system", label: t("settings.themeSystem") },
                { value: "light", label: t("settings.themeLight") },
                { value: "dark", label: t("settings.themeDark") },
              ]}
              value={settings().theme}
              onChange={(theme) => save("theme", theme)}
            />
          </div>
          <SelectRow
            label={t("settings.currency")}
            value={settings().currency}
            display={currencyLabel(settings().currency)}
            options={currencies()}
            onChange={(code, select) => {
              // The change waits for the confirmation; until then the row keeps the old value.
              select.value = settings().currency;
              if (code !== settings().currency) setPendingCurrency(code);
            }}
          />
          <div class="settings-row">
            <span>{t("settings.decimals")}</span>
            <Segmented
              label={t("settings.decimals")}
              class="segmented-decimals"
              options={(["0", "1", "2"] as const).map((d) => ({ value: d, label: d }))}
              value={String(settings().decimals) as "0" | "1" | "2"}
              onChange={(d) => save("decimals", Number(d) as AmountDecimals)}
            />
          </div>
          <SelectRow
            label={t("settings.language")}
            value={locale()}
            display={languageName(locale())}
            options={languages()}
            onChange={(code) => save("locale", code)}
          />
        </div>
        <Show when={saveFailed()}>
          <p class="field-error settings-error" role="alert">
            {t("settings.saveFailed")}
          </p>
        </Show>
      </section>

      <section class="section" aria-labelledby="settings-grouping">
        <h2 id="settings-grouping" class="section-title">
          {t("settings.grouping")}
        </h2>
        <div class="settings-card">
          <LinkRow
            href="/settings/categories"
            title={t("settings.categories")}
            meta={t("settings.categoriesMeta", {
              expense: categoryCounts().expense,
              income: categoryCounts().income,
            })}
          />
          <LinkRow
            href="/settings/tags"
            title={t("settings.tags")}
            meta={t("settings.tagsMeta", { count: tagCount() })}
          />
        </div>
      </section>

      <SyncSection onThisDevice={setThisDevice} />

      <BackupsSection />

      <section class="section" aria-labelledby="settings-encryption">
        <h2 id="settings-encryption" class="section-title">
          {t("settings.encryption")}
        </h2>
        <div class="settings-card settings-panel settings-panel-tight">
          <div class="settings-panel-head">
            <span class="settings-panel-icon">
              <KeyIcon size={18} />
            </span>
            <p class="settings-encryption-text">
              {t("settings.encryptionText")}{" "}
              <span class="muted">{t("settings.encryptionWarning")}</span>
            </p>
          </div>
          <button
            type="button"
            class="btn btn-secondary settings-wide-btn"
            aria-haspopup="dialog"
            disabled={!pairing()}
            onClick={() => setShowingKey(true)}
          >
            {t("settings.showRecoveryKey")}
          </button>
        </div>
        <Show when={pairing() === null}>
          <p class="settings-note">{t("settings.serverLater")}</p>
        </Show>
      </section>

      <DataSection />

      <p class="settings-version">
        {thisDevice()
          ? t("settings.versionDevice", { version, device: thisDevice() ?? "" })
          : t("settings.version", { version })}
      </p>

      <DevTools />

      <RecoveryKeyDialog open={showingKey()} onClose={() => setShowingKey(false)} />

      <ConfirmDialog
        open={pendingCurrency() !== undefined}
        title={t("settings.currencyConfirmTitle", {
          name: currencyLabel(pendingCurrency() ?? settings().currency),
        })}
        body={t("settings.currencyConfirmBody", {
          before: sample(settings().currency),
          after: sample(pendingCurrency() ?? settings().currency),
        })}
        confirmLabel={t("settings.currencyConfirm")}
        cancelLabel={t("lists.cancel")}
        onConfirm={() => {
          const code = pendingCurrency();
          setPendingCurrency(undefined);
          if (code) save("currency", code);
        }}
        onCancel={() => setPendingCurrency(undefined)}
      />
    </Screen>
  );
}
