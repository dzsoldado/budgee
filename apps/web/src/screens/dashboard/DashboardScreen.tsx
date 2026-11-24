// The Dashboard (Dashboard.dc.html): month or year with navigation, a comparison, the
// dashboard-wide exclusions, four KPI cards and the saved charts in their order. Everything is
// computed by core (computeKpis, computeChart) over one live query of the entries the widest
// chart needs; this screen only lays it out. Each chart's "⋯" menu edits, moves or removes it;
// Edit layout swaps the charts for a list with move up / move down buttons; Add chart opens the
// gallery.
import {
  type Compare,
  computeChart,
  computeKpis,
  type DashboardContext,
  type DashboardSettings,
  dataStart,
  type Exclusions,
  type Kpis,
  type LiveChartConfig,
  type TransactionRow,
} from "@budgee/core";
import { useHref } from "@solidjs/router";
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  on,
  onCleanup,
  Show,
} from "solid-js";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Segmented } from "../../components/Segmented";
import { useApp } from "../../context";
import { byChartOrder, moveAnnouncement, moveChart, removeChart } from "../../dashboard/charts";
import {
  COMPARE_OPTIONS,
  compareOptionLabel,
  compareRangeText,
  hasNextPeriod,
  kpiText,
  type Period,
  periodTitle,
  shiftPeriod,
} from "../../dashboard/format";
import { dashboardMonth, setDashboardMonth } from "../../dashboard/store";
import { createLiveQuery } from "../../db/live";
import { t } from "../../i18n";
import { todayIso } from "../../lib/date";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CloseIcon,
  PlusIcon,
  TagIcon,
} from "../../shell/icons";
import { useDocumentTitle } from "../../shell/Screen";
import { ChartMenu } from "./ChartMenu";
import { ChartView } from "./ChartView";
import { ExclusionsSheet } from "./ExclusionsSheet";

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

interface View {
  ctx: DashboardContext;
  rows: readonly TransactionRow[];
  kpis: Kpis;
  /** No entry in the viewed period. */
  empty: boolean;
}

const isExcluding = (e: Exclusions) => e.categories.length + e.tags.length > 0;

export function DashboardScreen() {
  const { db, repo, settings, format } = useApp();
  const addHref = useHref(() => "/add");
  const addChartHref = useHref(() => "/dashboard/add");
  const chartHref = useHref(() => "/dashboard/chart");
  useDocumentTitle(() => t("dashboard.title"));

  // Today moves on when the tab comes back after midnight.
  const [today, setToday] = createSignal(todayIso());
  const onVisible = () => {
    if (document.visibilityState === "visible") setToday(todayIso());
  };
  document.addEventListener("visibilitychange", onVisible);
  onCleanup(() => document.removeEventListener("visibilitychange", onVisible));

  // Settings writes are queued, and until the live settings catch up the screen shows what was
  // asked last: two quick taps both count. The draft goes once the settings equal it, or once
  // every queued write has settled and the live settings have moved on since (a value stored
  // differently, or overwritten by a sync, would never equal it); a failed write drops it.
  const [draft, setDraft] = createSignal<DashboardSettings | null>(null);
  const dashboard = () => draft() ?? settings().dashboard;
  createEffect(() => {
    const asked = draft();
    if (asked && sameJson(settings().dashboard, asked)) setDraft(null);
  });
  let pending = 0;
  /** Every queued write has settled: the next live settings are what the store holds. */
  let settled = false;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  const dropDraft = () => {
    settled = false;
    clearTimeout(settleTimer);
    setDraft(null);
  };
  createEffect(
    on(
      settings,
      () => {
        if (settled) dropDraft();
      },
      { defer: true },
    ),
  );
  onCleanup(() => clearTimeout(settleTimer));
  let writes: Promise<unknown> = Promise.resolve();
  const save = (patch: Partial<DashboardSettings>): Promise<void> => {
    const next = { ...dashboard(), ...patch };
    setDraft(next);
    pending += 1;
    settled = false;
    const write = writes.then(() => repo.setSetting("dashboard", next));
    writes = write.catch(() => undefined);
    const settle = () => {
      pending -= 1;
      if (pending > 0 || draft() === null) return;
      settled = true;
      // The live query may already have delivered the write; then nothing more arrives.
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        if (settled) dropDraft();
      }, 300);
    };
    return write.then(settle, (error: unknown) => {
      settle();
      if (draft() === next) dropDraft();
      throw error;
    });
  };

  const ctx = createMemo<DashboardContext>(() => ({
    today: today(),
    dashboard: dashboard(),
    ref: `${dashboardMonth()}-01`,
  }));

  const configRows = createLiveQuery(() => db.chart_configs.toArray());
  const charts = createMemo(() =>
    (configRows() ?? [])
      .filter((row): row is LiveChartConfig & { dirty: 0 | 1 } => !row.deleted)
      .sort(byChartOrder),
  );
  // Charts are rendered by id, so a sync or a move re-renders only what changed.
  const chartIds = createMemo(() => charts().map((c) => c.id), [], { equals: sameJson });
  const chartById = createMemo(() => new Map(charts().map((c) => [c.id, c])));

  // The entries every card and chart reads: from the earliest day any of them needs, or all.
  const start = createMemo(() =>
    configRows() === undefined
      ? undefined
      : dataStart(
          charts().map((c) => c.config),
          ctx(),
        ),
  );
  const loaded = createLiveQuery(start, async (from) => ({
    from,
    rows:
      from === undefined
        ? []
        : from === null
          ? await db.transactions.toArray()
          : await db.transactions.where("date").aboveOrEqual(from).toArray(),
  }));
  /** Whether there is any live entry at all (tombstones have no date, so no index entry). */
  const anyEntry = createLiveQuery(() =>
    db.transactions
      .orderBy("date")
      .first()
      .then((row) => row !== undefined),
  );

  /**
   * What the cards and charts show: computed only from entries that cover what they need. While
   * the entries for a new period load, the last view stays (dimmed, aria-busy) rather than
   * blinking zeros; before the first load there is none.
   */
  const view = createMemo<View | undefined>((previous) => {
    const result = loaded();
    const need = start();
    if (!result || need === undefined || result.from === undefined) return previous;
    const covers = result.from === null || (need !== null && result.from <= need);
    if (!covers) return previous;
    const c = ctx();
    const rows: readonly TransactionRow[] = result.rows;
    const kpis = computeKpis(rows, c);
    const { start: from, end } = kpis.window;
    return {
      ctx: c,
      rows,
      kpis,
      empty: !rows.some((row) => !row.deleted && row.date >= from && row.date <= end),
    };
  });
  const busy = () => {
    const v = view();
    return v === undefined || v.ctx !== ctx();
  };

  const [excludeError, setExcludeError] = createSignal(false);
  const setExclude = (exclude: Exclusions) => {
    setExcludeError(false);
    save({ exclude }).catch((error: unknown) => {
      console.error("Saving the dashboard exclusions failed", error);
      setExcludeError(true);
    });
  };
  const saveSetting = (patch: Partial<DashboardSettings>) =>
    save(patch).catch((error: unknown) => console.error("Saving the dashboard failed", error));

  const compareRangeId = createUniqueId();
  const compareRange = () => compareRangeText(ctx(), settings().locale);

  const [sheetOpen, setSheetOpen] = createSignal(false);
  let excludeButton!: HTMLButtonElement;
  const closeSheet = () => {
    setSheetOpen(false);
    excludeButton.focus();
  };

  const period = () => dashboard().period;
  const title = () => periodTitle(dashboardMonth(), period(), settings().locale);
  const removeChip = (list: keyof Exclusions, name: string) =>
    setExclude({
      ...dashboard().exclude,
      [list]: dashboard().exclude[list].filter((x) => x !== name),
    });

  const money = (hundredths: number, signAlways = false) =>
    format.money(hundredths, { sign: signAlways ? "always" : "auto" });

  // ─── Layout: move, remove ─────────────────────────────────────────────────
  const [reordering, setReordering] = createSignal(false);
  const [announce, setAnnounce] = createSignal("");
  const [layoutError, setLayoutError] = createSignal<"move" | "remove" | null>(null);
  /** Focused once the charts re-render after a write (a moved element loses focus). */
  let focusAfter: string | null = null;
  createEffect(
    on(chartIds, () => {
      const selector = focusAfter;
      if (selector === null) return;
      focusAfter = null;
      queueMicrotask(() => document.querySelector<HTMLElement>(selector)?.focus());
    }),
  );
  const move = (id: string, delta: -1 | 1, refocus: string) => {
    setLayoutError(null);
    // Said from the order before the write: the live list catches up only afterwards.
    const message = moveAnnouncement(chartIds(), id, delta, chartById().get(id)?.name ?? "");
    focusAfter = refocus;
    moveChart(db, repo, id, delta).then(
      (moved) => {
        if (!moved) {
          // Nothing changes, so no re-render would use (and clear) it.
          focusAfter = null;
          return;
        }
        if (message) setAnnounce(message);
      },
      (error: unknown) => {
        focusAfter = null;
        console.error("Moving the chart failed", error);
        setLayoutError("move");
      },
    );
  };
  const [removing, setRemoving] = createSignal<LiveChartConfig | null>(null);
  let addChartLink: HTMLAnchorElement | undefined;
  const confirmRemove = () => {
    const chart = removing();
    setRemoving(null);
    if (!chart) return;
    setLayoutError(null);
    removeChart(repo, chart.id).then(
      () => addChartLink?.focus(),
      (error: unknown) => {
        console.error("Removing the chart failed", error);
        setLayoutError("remove");
      },
    );
  };
  const cancelRemove = () => {
    const chart = removing();
    setRemoving(null);
    if (chart) document.querySelector<HTMLElement>(`[data-chart-menu="${chart.id}"]`)?.focus();
  };

  /** Edit layout: the charts as a list, each with move up and move down (aria-disabled at the
   * ends, so focus stays on a button that just reached them). */
  const layoutId = createUniqueId();
  const layoutList = () => (
    <section class="layout" aria-labelledby={layoutId}>
      <h2 class="visually-hidden" id={layoutId}>
        {t("dashboard.layoutTitle")}
      </h2>
      <p class="hint">{t("dashboard.layoutHint")}</p>
      <ol class="layout-list">
        <For each={chartIds()}>
          {(id, i) => {
            const name = () => chartById().get(id)?.name ?? "";
            const first = () => i() === 0;
            const last = () => i() === chartIds().length - 1;
            return (
              <li class="layout-row">
                <span class="layout-name">{name()}</span>
                <button
                  type="button"
                  class="layout-move"
                  data-move={`${id}:up`}
                  aria-label={t("dashboard.moveUp", { name: name() })}
                  aria-disabled={first()}
                  onClick={() => {
                    if (!first()) move(id, -1, `[data-move="${id}:up"]`);
                  }}
                >
                  <ChevronUpIcon size={20} />
                </button>
                <button
                  type="button"
                  class="layout-move"
                  data-move={`${id}:down`}
                  aria-label={t("dashboard.moveDown", { name: name() })}
                  aria-disabled={last()}
                  onClick={() => {
                    if (!last()) move(id, 1, `[data-move="${id}:down"]`);
                  }}
                >
                  <ChevronDownIcon size={20} />
                </button>
              </li>
            );
          }}
        </For>
      </ol>
    </section>
  );

  return (
    <div class="dashboard">
      <header class="dashboard-header">
        <div class="dashboard-top">
          <h1 class="screen-title">{t("dashboard.title")}</h1>
          <button
            type="button"
            class="dashboard-layout-btn"
            onClick={() => {
              setLayoutError(null);
              setReordering((on) => !on);
            }}
          >
            {reordering() ? t("dashboard.layoutDone") : t("dashboard.editLayout")}
          </button>
        </div>

        <div class="dashboard-controls">
          <div class="dashboard-period-row">
            <Segmented<Period>
              label={t("dashboard.period")}
              class="segmented-period"
              options={[
                { value: "month", label: t("dashboard.month") },
                { value: "year", label: t("dashboard.year") },
              ]}
              value={period()}
              onChange={(value) => saveSetting({ period: value })}
            />
            <div class="period-nav">
              <button
                type="button"
                class="period-step"
                aria-label={t("dashboard.previousPeriod")}
                onClick={() => setDashboardMonth((m) => shiftPeriod(m, period(), -1))}
              >
                <ChevronLeftIcon size={18} />
              </button>
              <span class="period-title" aria-live="polite">
                {title()}
              </span>
              <button
                type="button"
                class="period-step"
                aria-label={t("dashboard.nextPeriod")}
                disabled={!hasNextPeriod(dashboardMonth(), period(), today())}
                onClick={() => setDashboardMonth((m) => shiftPeriod(m, period(), 1))}
              >
                <ChevronRightIcon size={18} />
              </button>
            </div>
          </div>

          <div class="compare">
            <label class="compare-field">
              {t("dashboard.compareWith")}
              <select
                class="compare-select"
                value={dashboard().compare}
                aria-describedby={compareRange() ? compareRangeId : undefined}
                onChange={(event) => saveSetting({ compare: event.currentTarget.value as Compare })}
              >
                <For each={COMPARE_OPTIONS}>
                  {(option) => (
                    <option value={option} selected={option === dashboard().compare}>
                      {compareOptionLabel(option, period())}
                    </option>
                  )}
                </For>
              </select>
            </label>
            <Show when={compareRange()}>
              <span class="compare-range" id={compareRangeId}>
                {compareRange()}
              </span>
            </Show>
          </div>
        </div>

        <div class="exclusions">
          <Show when={isExcluding(dashboard().exclude)}>
            <span class="exclusions-label">{t("dashboard.leavingOut")}</span>
          </Show>
          <div class="exclusions-chips">
            <For each={dashboard().exclude.categories}>
              {(name) => (
                <button
                  type="button"
                  class="exclusion-chip"
                  aria-label={t("dashboard.stopCategory", { name })}
                  onClick={() => removeChip("categories", name)}
                >
                  {name}
                  <CloseIcon size={14} />
                </button>
              )}
            </For>
            <For each={dashboard().exclude.tags}>
              {(name) => (
                <button
                  type="button"
                  class="exclusion-chip exclusion-chip-tag"
                  aria-label={t("dashboard.stopTag", { name })}
                  onClick={() => removeChip("tags", name)}
                >
                  <TagIcon size={12} />
                  {name}
                  <CloseIcon size={14} />
                </button>
              )}
            </For>
            <button
              type="button"
              class="exclusion-add"
              ref={excludeButton}
              aria-haspopup="dialog"
              aria-expanded={sheetOpen()}
              onClick={() => setSheetOpen(true)}
            >
              <PlusIcon size={14} strokeWidth={2.2} />
              {t("dashboard.excludeAdd")}
            </button>
          </div>
        </div>
      </header>

      <Show when={anyEntry() !== undefined && configRows() !== undefined}>
        <Show
          when={anyEntry()}
          fallback={
            <div class="dashboard-body">
              <div class="dashboard-empty">
                <p class="dashboard-empty-title">{t("dashboard.emptyTitle")}</p>
                <p class="hint">{t("dashboard.emptyHint")}</p>
                <a class="btn btn-primary" href={addHref()}>
                  {t("dashboard.addEntry")}
                </a>
              </div>
            </div>
          }
        >
          <Show
            when={view()}
            fallback={
              <div class="dashboard-body">
                <p class="dashboard-loading" role="status">
                  {t("dashboard.loading")}
                </p>
              </div>
            }
          >
            {(v) => (
              <div
                class="dashboard-body"
                classList={{ "dashboard-busy": busy() }}
                aria-busy={busy()}
              >
                <Show when={v().empty}>
                  <div class="dashboard-notice" role="status">
                    <p class="dashboard-notice-title">
                      {t("dashboard.emptyPeriod", {
                        period: periodTitle(
                          v().ctx.ref?.slice(0, 7) ?? dashboardMonth(),
                          v().ctx.dashboard.period,
                          settings().locale,
                        ),
                      })}
                    </p>
                    <p class="hint">{t("dashboard.emptyPeriodHint")}</p>
                  </div>
                </Show>

                <section class="kpis" aria-label={t("dashboard.keyFigures")}>
                  <For each={v().kpis.cards}>
                    {(kpi) => {
                      const text = () =>
                        kpiText(kpi, {
                          locale: settings().locale,
                          money,
                          excluding: isExcluding(v().ctx.dashboard.exclude),
                          comparing: v().ctx.dashboard.compare !== "none",
                        });
                      return (
                        <div class="kpi">
                          <span class="kpi-label">{text().label}</span>
                          <span class="kpi-value">{text().value}</span>
                          <Show when={text().vs}>
                            <span class="kpi-compare">
                              <Show when={text().delta}>
                                <span class="kpi-delta">{text().delta}</span>
                              </Show>
                              {text().vs}
                            </span>
                          </Show>
                        </div>
                      );
                    }}
                  </For>
                </section>

                <Show when={layoutError()}>
                  {(error) => (
                    <p class="dashboard-error" role="alert">
                      {error() === "move" ? t("dashboard.moveError") : t("dashboard.removeError")}
                    </p>
                  )}
                </Show>

                <Show when={!reordering()} fallback={layoutList()}>
                  <div class="charts">
                    <For each={chartIds()}>
                      {(id, i) => {
                        const row = () => chartById().get(id);
                        // An unchanged config keeps its object, so its chart isn't rebuilt.
                        const config = createMemo(() => row()?.config, undefined, {
                          equals: sameJson,
                        });
                        // Computed once per change, however often the view reads it.
                        const data = createMemo(() => {
                          const c = config();
                          return c && computeChart(c, v().rows, v().ctx);
                        });
                        const name = () => row()?.name ?? "";
                        return (
                          <Show when={config()}>
                            {(c) => (
                              <Show when={data()}>
                                {(d) => (
                                  <ChartView
                                    name={name()}
                                    config={c()}
                                    data={d()}
                                    actions={
                                      <ChartMenu
                                        name={name()}
                                        chartId={id}
                                        editHref={`${chartHref()}/${id}`}
                                        canMoveUp={i() > 0}
                                        canMoveDown={i() < chartIds().length - 1}
                                        onMove={(delta) =>
                                          move(id, delta, `[data-chart-menu="${id}"]`)
                                        }
                                        onRemove={() => setRemoving(row() ?? null)}
                                      />
                                    }
                                  />
                                )}
                              </Show>
                            )}
                          </Show>
                        );
                      }}
                    </For>
                    <div class="add-chart">
                      <Show when={chartIds().length === 0}>
                        <p class="hint add-chart-note">{t("dashboard.noCharts")}</p>
                      </Show>
                      <a class="add-chart-btn" href={addChartHref()} ref={addChartLink}>
                        <PlusIcon size={18} strokeWidth={2.2} />
                        {t("dashboard.addChart")}
                      </a>
                    </div>
                  </div>
                </Show>
              </div>
            )}
          </Show>
        </Show>
      </Show>

      <div class="visually-hidden" role="status">
        {announce()}
      </div>
      <ConfirmDialog
        open={removing() !== null}
        title={t("dashboard.removeTitle", { name: removing()?.name ?? "" })}
        body={t("dashboard.removeBody")}
        confirmLabel={t("dashboard.removeConfirm")}
        cancelLabel={t("dashboard.cancel")}
        destructive
        onConfirm={confirmRemove}
        onCancel={cancelRemove}
      />
      <ExclusionsSheet
        open={sheetOpen()}
        exclude={dashboard().exclude}
        onChange={setExclude}
        onClose={closeSheet}
        error={excludeError()}
      />
    </div>
  );
}
