// The List: one month of entries with totals and filters. Phones get day groups
// (Main.dc.html); from 1024px a table (Desktop.dc.html) with Import and Export filtered (CSV).

import { totals } from "@budgee/core";
import { A, useHref } from "@solidjs/router";
import { createMemo, createSignal, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { MonthPicker } from "../../components/MonthPicker";
import { useApp } from "../../context";
import { createLiveQuery } from "../../db/live";
import { t } from "../../i18n";
import { createMediaQuery, WIDE_QUERY } from "../../lib/media";
import { sortByOrder } from "../../list/categories";
import { filterEntries, isFilterActive } from "../../list/filter";
import { loadMonthEntries, monthTitle, shiftMonth } from "../../list/month";
import { clearListFilter, listFilter, listMonth, setListMonth } from "../../list/store";
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from "../../shell/icons";
import { useDocumentTitle } from "../../shell/Screen";
import { SyncPill } from "../../sync/SyncPill";
import { ExportDialog } from "../settings/ExportDialog";
import { DayList, EntryTable } from "./Entries";
import { Filters } from "./Filters";

export function ListScreen() {
  const { db, settings, format } = useApp();
  const wide = createMediaQuery(WIDE_QUERY);
  const addHref = useHref(() => "/add");
  const [exporting, setExporting] = createSignal(false);
  useDocumentTitle(() => t("list.title"));

  const monthEntries = createLiveQuery(listMonth, (month) => loadMonthEntries(db, month));
  const categoryRows = createLiveQuery(() => db.categories.toArray());
  const categories = createMemo(() => sortByOrder(categoryRows() ?? []));

  const visible = createMemo(() => filterEntries(monthEntries() ?? [], listFilter()));
  const sums = createMemo(() => totals(visible()));
  const title = () => monthTitle(listMonth(), settings().locale);

  // The phone header is sticky: rows that focus scrolls into view stop below it.
  let list!: HTMLDivElement;
  let header!: HTMLElement;
  onMount(() => {
    const observer = new ResizeObserver(() =>
      list.style.setProperty("--list-header-size", `${header.offsetHeight}px`),
    );
    observer.observe(header);
    onCleanup(() => observer.disconnect());
  });

  return (
    <div class="list" ref={list}>
      <header class="list-header" ref={header}>
        <div class="list-top">
          <div class="month-nav">
            <button
              type="button"
              class="month-step"
              aria-label={t("list.previousMonth")}
              onClick={() => setListMonth((m) => shiftMonth(m, -1))}
            >
              <ChevronLeftIcon size={20} />
            </button>
            <h1 class="month-title">
              <MonthPicker
                value={listMonth()}
                unit="month"
                locale={settings().locale}
                sheet={!wide()}
                onChange={setListMonth}
              />
            </h1>
            <button
              type="button"
              class="month-step"
              aria-label={t("list.nextMonth")}
              onClick={() => setListMonth((m) => shiftMonth(m, 1))}
            >
              <ChevronRightIcon size={20} />
            </button>
          </div>
          <Show when={wide()} fallback={<SyncPill />}>
            <div class="list-actions">
              <A href="/settings/import?from=list" class="list-action">
                {t("list.import")}
              </A>
              <button
                type="button"
                class="list-action"
                aria-haspopup="dialog"
                onClick={() => setExporting(true)}
              >
                {t("list.exportFiltered")}
                <ChevronDownIcon size={14} />
              </button>
            </div>
          </Show>
        </div>

        <section class="totals" aria-label={t("list.totals")}>
          <div class="total">
            <span class="total-label">{t("list.income")}</span>
            <span class="total-value amount-income">
              {format.money(sums().income, { withCurrency: wide() })}
            </span>
          </div>
          <div class="total">
            <span class="total-label">{t("list.expenses")}</span>
            <span class="total-value total-expense">
              {format.money(sums().expenses, { withCurrency: wide() })}
            </span>
          </div>
          <div class="total">
            <span class="total-label">
              {wide()
                ? t("list.differenceSoFar")
                : t("list.difference", { currency: settings().currency })}
            </span>
            <span class="total-value">
              {format.money(sums().difference, { withCurrency: wide(), sign: "always" })}
            </span>
          </div>
        </section>

        <Filters wide={wide()} categories={categories()} monthEntries={monthEntries() ?? []} />
      </header>

      <p class="visually-hidden" role="status">
        <Show when={monthEntries()}>
          {visible().length === 1
            ? t("list.countOne")
            : t("list.countMany", { count: visible().length })}
        </Show>
      </p>

      <Show when={monthEntries()}>
        {(entries) => (
          <Switch>
            <Match when={entries().length === 0}>
              <div class="list-empty">
                <p class="list-empty-title">{t("list.emptyMonth", { month: title() })}</p>
                <p class="hint">{t("list.emptyMonthHint")}</p>
                <a class="btn btn-primary" href={addHref()}>
                  {t("list.addEntry")}
                </a>
              </div>
            </Match>
            <Match when={visible().length === 0}>
              <div class="list-empty">
                <p class="list-empty-title">{t("list.emptyFiltered")}</p>
                <p class="hint">{t("list.emptyFilteredHint")}</p>
                <Show when={isFilterActive(listFilter())}>
                  <button type="button" class="btn btn-secondary" onClick={clearListFilter}>
                    {t("list.clearFilters")}
                  </button>
                </Show>
              </div>
            </Match>
            <Match when={wide()}>
              <EntryTable entries={visible()} />
            </Match>
            <Match when={!wide()}>
              <DayList entries={visible()} />
            </Match>
          </Switch>
        )}
      </Show>

      <ExportDialog open={exporting()} what="list" onClose={() => setExporting(false)} />
    </div>
  );
}
