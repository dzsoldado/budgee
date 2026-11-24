// One generic chart: draws whatever core `computeChart` returned for a saved chart config.
// Series charts go to Chart.js (lines, columns, horizontal bars with a tick for the compared
// value, doughnuts); a table config is an HTML table. Colors are the theme tokens, read again
// when the theme changes. Every chart has a heading and its values in a table for screen
// readers; the canvas itself is hidden from them.
import type { ChartConfig, ChartData, SeriesChart, TableChart } from "@budgee/core";
import type { ChartConfiguration } from "chart.js";
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  type JSX,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";
import { useApp } from "../../context";
import {
  buildChartConfig,
  Chart,
  fade,
  type Layout,
  metricColor,
  type Palette,
  readPalette,
} from "../../dashboard/chart";
import {
  formatInteger,
  formatPercent,
  formatThousands,
  groupLabel,
  isListGroup,
  partialIndex,
  seriesNames,
  seriesSubtitle,
  tableSubtitle,
  toThousands,
  usesThousands,
} from "../../dashboard/format";
import { t } from "../../i18n";
import { createMediaQuery } from "../../lib/media";

export interface ChartViewProps {
  name: string;
  config: ChartConfig;
  data: ChartData;
  /** Drawn at the end of the heading: the dashboard's chart menu (none in the editor preview). */
  actions?: JSX.Element;
}

/** Bumps whenever `data-theme` on <html> or the system color scheme changes. */
function createThemeVersion() {
  const [version, setVersion] = createSignal(0);
  const bump = () => setVersion((v) => v + 1);
  const observer = new MutationObserver(bump);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const scheme = window.matchMedia("(prefers-color-scheme: dark)");
  scheme.addEventListener("change", bump);
  onCleanup(() => {
    observer.disconnect();
    scheme.removeEventListener("change", bump);
  });
  return version;
}

const layoutOf = (config: ChartConfig): Layout =>
  config.kind === "line"
    ? "line"
    : config.kind === "doughnut"
      ? "doughnut"
      : isListGroup(config.groupBy)
        ? "rows"
        : "columns";

const isEmpty = (data: SeriesChart) =>
  data.labels.length === 0 ||
  data.series.every((s) => s.values.every((v) => v === null || v === 0));

export function ChartView(props: ChartViewProps) {
  const id = createUniqueId();
  const { settings } = useApp();

  const subtitle = createMemo(() => {
    const { locale, currency } = settings();
    if (props.data.shape === "table") return tableSubtitle(props.data, props.config, locale);
    const thousands = isMoney(props.config) && usesThousands(allValues(props.data));
    return seriesSubtitle(props.data, props.config, { locale, currency, thousands });
  });

  return (
    <section class="chart-card" aria-labelledby={`${id}-title`}>
      <div class="chart-head">
        <div class="chart-titles">
          <h2 class="chart-title" id={`${id}-title`}>
            {props.name}
          </h2>
          <span class="chart-subtitle">{subtitle()}</span>
        </div>
        {props.actions}
      </div>
      <Switch>
        <Match when={props.data.shape === "table" && props.data}>
          {(data) => (
            <ChartTable data={data() as TableChart} config={props.config} name={props.name} />
          )}
        </Match>
        <Match when={props.data.shape === "series" && isEmpty(props.data) && props.data}>
          <p class="chart-empty">{t("dashboard.chartEmpty")}</p>
        </Match>
        <Match when={props.data.shape === "series" && props.data}>
          {(data) => (
            // A new layout (the config was edited) needs a new canvas.
            <Show when={layoutOf(props.config)} keyed>
              {(layout) => (
                <SeriesView
                  data={data() as SeriesChart}
                  config={props.config}
                  name={props.name}
                  layout={layout}
                />
              )}
            </Show>
          )}
        </Match>
      </Switch>
    </section>
  );
}

const isMoney = (config: ChartConfig) =>
  config.metric !== "kept_ratio" && config.metric !== "count";

function allValues(data: SeriesChart): (number | null)[] {
  return data.series.flatMap((s) => [...s.values, ...s.projected]);
}

/** Formatting for one chart's values: money (maybe in thousands), percentages or counts. */
function createValueFormat(config: () => ChartConfig, data: () => SeriesChart) {
  const { settings, format } = useApp();
  const thousands = createMemo(() => isMoney(config()) && usesThousands(allValues(data())));
  const value = (v: number) => {
    const { locale } = settings();
    if (config().metric === "kept_ratio") return formatPercent(v, locale);
    if (config().metric === "count") return formatInteger(v, locale);
    return format.money(v);
  };
  const tick = (v: number) => {
    const { locale } = settings();
    if (config().metric === "kept_ratio") return formatPercent(v, locale);
    if (config().metric === "count") return formatInteger(v, locale);
    return thousands() ? formatInteger(toThousands(v), locale) : format.money(v);
  };
  const short = (v: number) =>
    thousands() && isMoney(config()) ? formatThousands(v, settings().locale) : value(v);
  /** cur − cmp: "+3,300", or "+9 pts" for a ratio. */
  const delta = (cur: number, cmp: number) => {
    const { locale } = settings();
    if (config().metric === "kept_ratio")
      return t("dashboard.points", {
        n: formatInteger(Math.round((cur - cmp) * 100), locale, true),
      });
    if (config().metric === "count") return formatInteger(cur - cmp, locale, true);
    return format.money(cur - cmp, { sign: "always" });
  };
  return { value, tick, short, delta };
}

function SeriesView(props: {
  data: SeriesChart;
  config: ChartConfig;
  name: string;
  layout: Layout;
}) {
  const { settings } = useApp();
  const fmt = createValueFormat(
    () => props.config,
    () => props.data,
  );
  const layout = () => props.layout;
  const names = createMemo(() => seriesNames(props.data, settings().locale));
  const current = () => props.data.series.find((s) => s.role === "current");
  const compare = () => props.data.series.find((s) => s.role === "compare");
  const label = (key: string, i: number, axis: boolean, narrow = false) =>
    groupLabel(key, props.config.groupBy, settings().locale, {
      axis,
      narrow,
      other: props.data.hasOther && i === props.data.labels.length - 1,
    });

  const themeVersion = createThemeVersion();
  const reducedMotion = createMediaQuery("(prefers-reduced-motion: reduce)");
  const [narrow, setNarrow] = createSignal(true);
  let box!: HTMLDivElement;

  const buildConfig = (palette: Palette, animate: boolean): ChartConfiguration => {
    const data = props.data;
    const i = partialIndex(data);
    const pace = i >= 0 ? current()?.projected[i] : null;
    const cmp = i >= 0 ? compare()?.values[i] : null;
    return buildChartConfig({
      data,
      config: props.config,
      layout: layout(),
      palette,
      axisLabels: data.labels.map((k, j) => label(k, j, true, narrow())),
      titles: data.labels.map((k, j) => label(k, j, false)),
      names: names(),
      formatValue: fmt.value,
      formatTick: fmt.tick,
      marks:
        pace !== null && pace !== undefined
          ? {
              pace: t("dashboard.pace", { value: fmt.short(pace) }),
              compare: cmp !== null && cmp !== undefined ? fmt.short(cmp) : "",
            }
          : null,
      reducedMotion: reducedMotion() || !animate,
    });
  };

  // Tokens are read again whenever the theme changes.
  const [palette, setPalette] = createSignal<Palette>();
  const color = () => {
    const p = palette();
    return p && metricColor(props.config.metric, p);
  };

  // Chart.js keeps plugins from creation, so a change builds a new chart (animated only once).
  onMount(() => {
    const canvas = box.querySelector("canvas");
    if (!canvas) return;
    let chart: Chart | undefined;
    let first = true;
    // Known before the first build, so it isn't thrown away when the observer first reports.
    const isNarrow = () => box.clientWidth < 560;
    setNarrow(isNarrow());
    const resize = new ResizeObserver(() => setNarrow(isNarrow()));
    resize.observe(box);
    createEffect(() => {
      themeVersion();
      setPalette(readPalette(box));
    });
    createEffect(() => {
      const p = palette();
      if (!p) return;
      const config = buildConfig(p, first);
      first = false;
      chart?.destroy();
      chart = new Chart(canvas, config);
    });
    onCleanup(() => {
      resize.disconnect();
      chart?.destroy();
    });
  });

  return (
    <>
      <Show when={compare() && (layout() === "line" || layout() === "columns")}>
        <div class="chart-legend" aria-hidden="true">
          <span class="chart-legend-item">
            <span
              class="chart-swatch"
              classList={{ "chart-swatch-box": layout() === "columns" }}
              style={{ background: color() }}
            />
            {names().current}
          </span>
          <span class="chart-legend-item">
            <span
              class="chart-swatch chart-swatch-compare"
              classList={{ "chart-swatch-box": layout() === "columns" }}
            />
            {names().compare}
          </span>
        </div>
      </Show>
      <Switch>
        <Match when={layout() === "rows"}>
          <div class="chart-rows" style={{ "--rows": props.data.labels.length }} aria-hidden="true">
            <ul class="chart-row-labels">
              <For each={props.data.labels}>
                {(key, i) => <li title={label(key, i(), false)}>{label(key, i(), false)}</li>}
              </For>
            </ul>
            <div class="chart-canvas chart-canvas-rows" ref={box}>
              <canvas />
            </div>
            <ul class="chart-row-values">
              <For each={props.data.labels}>
                {(_, i) => {
                  const cur = () => current()?.values[i()] ?? null;
                  const cmp = () => compare()?.values[i()] ?? null;
                  return (
                    <li>
                      <span class="chart-row-value">
                        {cur() === null ? "—" : fmt.value(cur() ?? 0)}
                      </span>
                      <Show when={compare()}>
                        <span class="chart-row-delta">
                          {cur() !== null && cmp() !== null
                            ? t("dashboard.deltaVs", {
                                delta: fmt.delta(cur() ?? 0, cmp() ?? 0),
                                value: fmt.value(cmp() ?? 0),
                              })
                            : "—"}
                        </span>
                      </Show>
                    </li>
                  );
                }}
              </For>
            </ul>
          </div>
        </Match>
        <Match when={layout() === "doughnut"}>
          <div class="chart-doughnut">
            <div class="chart-canvas chart-canvas-doughnut" ref={box} aria-hidden="true">
              <canvas />
            </div>
            <DoughnutLegend
              labels={props.data.labels.map((k, i) => label(k, i, false))}
              values={current()?.values ?? []}
              color={color()}
              other={props.data.hasOther}
              format={fmt.value}
            />
          </div>
        </Match>
        <Match when={true}>
          <div class="chart-canvas" ref={box} aria-hidden="true">
            <canvas />
          </div>
        </Match>
      </Switch>
      <div class="visually-hidden">
        <table>
          <caption>{t("dashboard.chartLabel", { name: props.name })}</caption>
          <thead>
            <tr>
              <th scope="col">{t("dashboard.tableGroup")}</th>
              <th scope="col">{names().current || props.name}</th>
              <Show when={compare()}>
                <th scope="col">{names().compare}</th>
              </Show>
            </tr>
          </thead>
          <tbody>
            <For each={props.data.labels}>
              {(key, i) => {
                const cur = () => current()?.values[i()] ?? null;
                const projected = () =>
                  current()?.partial[i()] ? (current()?.projected[i()] ?? null) : null;
                const cmp = () => compare()?.values[i()] ?? null;
                const cell = (v: number | null): JSX.Element => (v === null ? "—" : fmt.value(v));
                return (
                  <tr>
                    <th scope="row">{label(key, i(), false)}</th>
                    <td>
                      {projected() !== null && cur() !== null
                        ? t("dashboard.projectedNote", {
                            value: fmt.value(cur() ?? 0),
                            pace: fmt.value(projected() ?? 0),
                          })
                        : cell(cur())}
                    </td>
                    <Show when={compare()}>
                      <td>{cell(cmp())}</td>
                    </Show>
                  </tr>
                );
              }}
            </For>
          </tbody>
        </table>
      </div>
    </>
  );
}

function DoughnutLegend(props: {
  labels: string[];
  values: (number | null)[];
  color: string | undefined;
  other: boolean;
  format: (v: number) => string;
}) {
  const { settings } = useApp();
  const total = () => props.values.reduce<number>((s, v) => s + Math.max(0, v ?? 0), 0);
  const n = () => props.labels.length;
  return (
    <ul class="chart-doughnut-legend" aria-hidden="true">
      <For each={props.labels}>
        {(name, i) => {
          const v = () => Math.max(0, props.values[i()] ?? 0);
          const isOther = () => props.other && i() === n() - 1;
          const swatch = () =>
            isOther() || !props.color
              ? "var(--compare)"
              : fade(props.color, 1 - (0.7 * i()) / Math.max(1, n() - 1));
          return (
            <li>
              <span class="chart-swatch chart-swatch-box" style={{ background: swatch() }} />
              <span class="chart-doughnut-name">{name}</span>
              <span class="chart-doughnut-value">{props.format(v())}</span>
              <span class="chart-doughnut-share">
                {total() > 0 ? formatPercent(v() / total(), settings().locale) : "—"}
              </span>
            </li>
          );
        }}
      </For>
    </ul>
  );
}

/** A table config: income, expenses and kept ratio per row (Year by year), as drawn. */
function ChartTable(props: { data: TableChart; config: ChartConfig; name: string }) {
  const { settings, format } = useApp();
  const thousands = () => props.data.rows.some((r) => usesThousands([r.income, r.expenses]));
  const money = (v: number) =>
    thousands() ? formatThousands(v, settings().locale) : format.money(v);
  const label = (row: TableChart["rows"][number], i: number) =>
    groupLabel(row.label, props.config.groupBy, settings().locale, {
      other: props.data.hasOther && i === props.data.rows.length - 1,
    });
  return (
    <table class="chart-table">
      <caption class="visually-hidden">{props.name}</caption>
      <thead>
        <tr>
          <th scope="col">
            {props.config.groupBy === "year" ? t("dashboard.tableYear") : t("dashboard.tableGroup")}
          </th>
          <th scope="col">{t("dashboard.tableIncome")}</th>
          <th scope="col">{t("dashboard.tableExpenses")}</th>
          <th scope="col">{t("dashboard.tableKept")}</th>
        </tr>
      </thead>
      <tbody>
        <For each={props.data.rows}>
          {(row, i) => (
            <tr classList={{ "chart-table-current": row.current }}>
              <th scope="row">{label(row, i())}</th>
              <td>{money(row.income)}</td>
              <td>{money(row.expenses)}</td>
              <td>
                {row.keptRatio === null
                  ? t("dashboard.none")
                  : formatPercent(row.keptRatio, settings().locale)}
              </td>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  );
}
