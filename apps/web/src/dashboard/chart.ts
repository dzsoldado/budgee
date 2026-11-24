// Chart.js setup for ChartView: only the pieces the dashboard draws are registered (tree-shaken),
// and one function turns a core SeriesChart into a Chart.js configuration. Colors come in as a
// palette read from the theme tokens, so a theme change only rebuilds the configuration.
import type { ChartConfig as BudgeeChart, SeriesChart } from "@budgee/core";
import {
  ArcElement,
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  type ChartConfiguration,
  type ChartTypeRegistry,
  DoughnutController,
  LinearScale,
  LineController,
  LineElement,
  type Plugin,
  PointElement,
  type ScriptableLineSegmentContext,
  Tooltip,
  type TooltipItem,
} from "chart.js";
import { partialIndex } from "./format";

Chart.register(
  BarController,
  LineController,
  DoughnutController,
  BarElement,
  LineElement,
  PointElement,
  ArcElement,
  CategoryScale,
  LinearScale,
  Tooltip,
);

export { Chart };

export interface Palette {
  income: string;
  expense: string;
  compare: string;
  ink: string;
  muted: string;
  surface: string;
  grid: string;
  axis: string;
  tipBg: string;
  tipInk: string;
}

/** The chart tokens as resolved under `el` (so a `data-theme` scope applies). */
export function readPalette(el: Element): Palette {
  const style = getComputedStyle(el);
  const token = (name: string) => style.getPropertyValue(`--${name}`).trim();
  return {
    income: token("income"),
    expense: token("expense"),
    compare: token("compare"),
    ink: token("ink"),
    muted: token("muted"),
    surface: token("surface"),
    grid: token("grid"),
    axis: token("axis"),
    tipBg: token("tip-bg"),
    tipInk: token("tip-ink"),
  };
}

/**
 * The current series' color: money out orange, money in teal (Foundations). Difference, kept
 * ratio and count are neither, and purple never means money, so they are drawn in neutral ink,
 * which stays apart from the comparison gray.
 */
export function metricColor(metric: BudgeeChart["metric"], palette: Palette): string {
  if (metric === "expenses") return palette.expense;
  if (metric === "income") return palette.income;
  return palette.ink;
}

/**
 * A token color at `alpha`, for doughnut slices and the "Other" bar. Tokens are `#rrggbb`
 * (canvas and Chart.js's color math read that, not color-mix); anything else is kept as is.
 */
export function fade(color: string, alpha: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return color;
  const byte = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
  return `${color}${byte.toString(16).padStart(2, "0")}`;
}

/** How the series are laid out. `rows`: horizontal bars, labels and values drawn in HTML. */
export type Layout = "line" | "columns" | "rows" | "doughnut";

export interface BuildInput {
  data: SeriesChart;
  config: BudgeeChart;
  layout: Layout;
  palette: Palette;
  /** Axis labels (short), one per data label. */
  axisLabels: string[];
  /** Tooltip titles (full), one per data label. */
  titles: string[];
  /** Series names for tooltips. */
  names: { current: string; compare: string };
  /** A value as tooltips show it. */
  formatValue: (value: number) => string;
  /** A value as the value axis shows it. */
  formatTick: (value: number) => string;
  /** The pace and compared labels drawn next to an unfinished bucket ("23k pace", "28k"). */
  marks: { pace: string; compare: string } | null;
  reducedMotion: boolean;
}

const FONT = "Inter, system-ui, sans-serif";

type Item = TooltipItem<keyof ChartTypeRegistry>;
/**
 * Chart.js's option types don't hold under exactOptionalPropertyTypes (and miss options it
 * reads, like a point's `rotation`), so configurations are built as plain objects, typed once.
 */
type Loose = Record<string, unknown>;
const typed = (config: Loose) => config as unknown as ChartConfiguration;

const roleOf = (data: SeriesChart, role: "current" | "compare") =>
  data.series.find((s) => s.role === role);

/**
 * Where an unfinished bucket's projection is drawn: a line shows the projected value at the
 * point; a column shows the counted value and a dashed outline up to the projection.
 */
export function plotted(data: SeriesChart, layout: Layout): (number | null)[] {
  const current = roleOf(data, "current");
  if (!current) return [];
  if (layout !== "line") return current.values;
  return current.values.map((v, i) =>
    current.partial[i] && current.projected[i] !== null ? (current.projected[i] ?? v) : v,
  );
}

interface Pt {
  x: number;
  y: number;
}
/** A label's box: top-left corner and size, in canvas pixels. */
export interface Box extends Pt {
  width: number;
  height: number;
}

/** The y of a polyline at `x` (between its points), or null outside it or across a gap. */
function lineYAt(points: readonly Pt[], x: number): number | null {
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1];
    const b = points[k];
    if (!a || !b || Number.isNaN(a.y) || Number.isNaN(b.y)) continue;
    if (x < Math.min(a.x, b.x) || x > Math.max(a.x, b.x)) continue;
    return b.x === a.x ? a.y : a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x);
  }
  return null;
}

/** Whether any line passes through the box (sampled across its width). */
function crosses(box: Box, lines: readonly (readonly Pt[])[]): boolean {
  for (let step = 0; step <= 8; step++) {
    const x = box.x + (box.width * step) / 8;
    for (const line of lines) {
      const y = lineYAt(line, x);
      if (y !== null && y >= box.y - 2 && y <= box.y + box.height + 2) return true;
    }
  }
  return false;
}

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Where a value label goes next to its point: the first spot (below, above, left, right, then
 * the diagonals) that stays inside `area`, keeps clear of every line and of labels already
 * placed. With none clear, the first spot inside the area.
 */
export function placeLabel(
  size: { width: number; height: number },
  point: Pt,
  lines: readonly (readonly Pt[])[],
  area: { left: number; right: number; top: number; bottom: number },
  taken: readonly Box[] = [],
): Box {
  const { width: w, height: h } = size;
  const gap = 8;
  const spots: Pt[] = [
    { x: point.x - w / 2, y: point.y + gap },
    { x: point.x - w / 2, y: point.y - gap - h },
    { x: point.x - gap - w, y: point.y - h / 2 },
    { x: point.x + gap, y: point.y - h / 2 },
    { x: point.x - gap - w, y: point.y + gap / 2 },
    { x: point.x - gap - w, y: point.y - gap / 2 - h },
    { x: point.x + gap, y: point.y + gap / 2 },
    { x: point.x + gap, y: point.y - gap / 2 - h },
  ];
  const boxes = spots.map((p) => ({ ...p, width: w, height: h }));
  const inside = (b: Box) =>
    b.x >= area.left && b.x + w <= area.right && b.y >= area.top && b.y + h <= area.bottom;
  const clear = boxes.find(
    (b) => inside(b) && !crosses(b, lines) && !taken.some((t) => overlaps(b, t)),
  );
  const fallback = boxes.find(inside) ?? boxes[0];
  return clear ?? fallback ?? { ...point, width: w, height: h };
}

/** Draws what Chart.js has no option for: dashed projection outlines and the pace labels. */
function marksPlugin(input: BuildInput): Plugin {
  return {
    id: "budgeeMarks",
    afterDatasetsDraw(chart) {
      const current = roleOf(input.data, "current");
      if (!current) return;
      const { ctx } = chart;
      const y = chart.scales.y;
      if (!y) return;
      const color = metricColor(input.config.metric, input.palette);
      ctx.save();
      if (input.layout === "columns") {
        const meta = chart.getDatasetMeta(0);
        current.projected.forEach((p, i) => {
          const bar = meta.data[i] as unknown as
            | { x: number; y: number; width: number; base: number }
            | undefined;
          if (p === null || !current.partial[i] || !bar) return;
          const top = y.getPixelForValue(p);
          ctx.setLineDash([3, 3]);
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = color;
          ctx.strokeRect(bar.x - bar.width / 2, top, bar.width, bar.y - top);
        });
      }
      const i = partialIndex(input.data);
      if (input.layout === "line" && i >= 0 && input.marks) {
        const lines = chart.data.datasets.map((_, d) =>
          chart.getDatasetMeta(d).data.map((p) => ({ x: p.x, y: p.y })),
        );
        const area = chart.chartArea;
        ctx.setLineDash([]);
        ctx.font = `600 11px ${FONT}`;
        ctx.fillStyle = input.palette.ink;
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        const taken: Box[] = [];
        const label = (text: string, point: Pt | undefined) => {
          if (!point || !text) return;
          const box = placeLabel(
            { width: ctx.measureText(text).width, height: 12 },
            point,
            lines,
            { left: area.left, right: chart.width - 2, top: 0, bottom: area.bottom },
            taken,
          );
          taken.push(box);
          ctx.fillText(text, box.x, box.y);
        };
        label(input.marks.pace, lines[0]?.[i]);
        label(input.marks.compare, lines[1]?.[i]);
      }
      ctx.restore();
    },
  };
}

/** A Chart.js configuration for one series chart. */
export function buildChartConfig(input: BuildInput): ChartConfiguration {
  const { data, config, layout, palette } = input;
  const current = roleOf(data, "current");
  const compare = roleOf(data, "compare");
  const color = metricColor(config.metric, palette);
  const hi = partialIndex(data);
  const other = data.hasOther ? data.labels.length - 1 : -1;
  const values = plotted(data, layout);

  const tooltip = {
    backgroundColor: palette.tipBg,
    titleColor: palette.tipInk,
    bodyColor: palette.tipInk,
    titleFont: { family: FONT, size: 12, weight: 600 as const },
    bodyFont: { family: FONT, size: 12 },
    padding: 8,
    cornerRadius: 8,
    displayColors: false,
    callbacks: {
      title: (items: Item[]) => input.titles[items[0]?.dataIndex ?? 0] ?? "",
      label: (item: Item) => {
        const isCompare = item.datasetIndex === 1 && layout !== "doughnut";
        const series = isCompare ? compare : current;
        const raw = series?.values[item.dataIndex] ?? null;
        const name = isCompare ? input.names.compare : input.names.current;
        if (raw === null) return `${name}: —`;
        const projected = !isCompare ? series?.projected[item.dataIndex] : null;
        const text =
          projected !== null && projected !== undefined && series?.partial[item.dataIndex]
            ? `${input.formatValue(raw)} → ${input.formatValue(projected)}`
            : input.formatValue(raw);
        return name ? `${name}: ${text}` : text;
      },
    },
  };

  const common = {
    responsive: true,
    maintainAspectRatio: false,
    animation: input.reducedMotion ? (false as const) : { duration: 300 },
    font: { family: FONT },
    interaction: { mode: "index" as const, intersect: false },
  };

  if (layout === "doughnut") {
    const n = data.labels.length;
    const shades = data.labels.map((_, i) =>
      i === other ? palette.compare : fade(color, 1 - (0.7 * i) / Math.max(1, n - 1)),
    );
    return typed({
      type: "doughnut",
      data: {
        labels: input.axisLabels,
        datasets: [
          {
            data: (current?.values ?? []).map((v) => Math.max(0, v ?? 0)),
            backgroundColor: shades,
            borderColor: palette.surface,
            borderWidth: 2,
            hoverOffset: 4,
          },
        ],
      },
      options: {
        ...common,
        interaction: { mode: "nearest", intersect: true },
        cutout: "62%",
        plugins: { tooltip, legend: { display: false } },
      },
    });
  }

  const tickFont = (index: number) => ({
    family: FONT,
    size: 10,
    weight: index === hi ? (700 as const) : (400 as const),
  });
  const valueAxis = {
    beginAtZero: true,
    border: { display: false },
    grid: { color: palette.grid, drawTicks: false },
    ticks: {
      color: palette.muted,
      font: { family: FONT, size: 10 },
      maxTicksLimit: 5,
      padding: 6,
      callback: (v: string | number) => input.formatTick(Number(v)),
    },
  };
  const categoryAxis = {
    grid: { display: false },
    border: { color: palette.axis },
    ticks: {
      color: (c: { index: number }) => (c.index === hi ? palette.ink : palette.muted),
      font: (c: { index: number }) => tickFont(c.index),
      maxRotation: 0,
      autoSkipPadding: 6,
    },
  };

  if (layout === "rows") {
    const datasets: Loose[] = [
      {
        type: "bar",
        data: values,
        backgroundColor: data.labels.map((_, i) => (i === other ? fade(color, 0.55) : color)),
        borderRadius: { topRight: 4, bottomRight: 4, topLeft: 0, bottomLeft: 0 },
        borderSkipped: false,
        barThickness: 12,
        order: 2,
      },
    ];
    if (compare) {
      // The compared value is a tick across the bar's row.
      datasets.push({
        type: "line",
        data: compare.values,
        showLine: false,
        pointStyle: "line",
        rotation: 90,
        pointRadius: 9,
        pointHoverRadius: 9,
        pointBorderWidth: 3,
        pointHoverBorderWidth: 3,
        borderColor: palette.compare,
        backgroundColor: palette.compare,
        clip: false,
        order: 1,
      });
    }
    return typed({
      type: "bar",
      data: { labels: input.axisLabels, datasets },
      options: {
        ...common,
        indexAxis: "y",
        interaction: { mode: "index", intersect: false, axis: "y" },
        // No room for the ticks' radius: the bands must line up with the 40px HTML rows.
        layout: { autoPadding: false, padding: 0 },
        scales: {
          x: { display: false, beginAtZero: true, grace: "4%" },
          y: { display: false, offset: true },
        },
        plugins: { tooltip, legend: { display: false } },
      },
    });
  }

  if (layout === "columns") {
    const datasets: Loose[] = [];
    if (compare) {
      datasets.push({
        data: compare.values,
        backgroundColor: palette.compare,
        borderRadius: 3,
        borderSkipped: "start",
        order: 2,
      });
    }
    datasets.unshift({
      data: values,
      backgroundColor: data.labels.map((_, i) =>
        current?.partial[i] ? fade(color, 0.7) : i === other ? fade(color, 0.55) : color,
      ),
      borderRadius: 3,
      borderSkipped: "start",
      order: 1,
    });
    return typed({
      type: "bar",
      data: { labels: input.axisLabels, datasets },
      options: {
        ...common,
        datasets: { bar: { categoryPercentage: 0.7, barPercentage: 0.9 } },
        scales: {
          x: categoryAxis,
          y: {
            ...valueAxis,
            suggestedMax: Math.max(0, ...(current?.projected ?? []).map((p) => p ?? 0)),
          },
        },
        plugins: { tooltip, legend: { display: false } },
      },
      plugins: [marksPlugin(input)],
    });
  }

  // Line: past and compared periods solid, the unfinished bucket dashed and hollow.
  const dashed = (c: ScriptableLineSegmentContext) =>
    current?.partial[c.p1DataIndex] ? [3, 3] : undefined;
  const radius = (marked: number) => (c: { dataIndex: number }) =>
    c.dataIndex === marked ? 4.5 : 0;
  const datasets: Loose[] = [
    {
      data: values,
      borderColor: color,
      backgroundColor: palette.surface,
      borderWidth: 2,
      borderCapStyle: "round",
      borderJoinStyle: "round",
      tension: 0,
      segment: { borderDash: dashed },
      pointRadius: radius(hi),
      pointHoverRadius: 4.5,
      pointBorderWidth: 2,
      pointBackgroundColor: palette.surface,
      pointBorderColor: color,
      order: 1,
    },
  ];
  if (compare) {
    datasets.push({
      data: compare.values,
      borderColor: palette.compare,
      backgroundColor: palette.compare,
      borderWidth: 2,
      borderCapStyle: "round",
      borderJoinStyle: "round",
      tension: 0,
      pointRadius: (c: { dataIndex: number }) => (c.dataIndex === hi ? 4 : 0),
      pointHoverRadius: 4,
      pointBorderWidth: 2,
      pointBackgroundColor: palette.compare,
      pointBorderColor: palette.surface,
      order: 2,
    });
  }
  return typed({
    type: "line",
    data: { labels: input.axisLabels, datasets },
    options: {
      ...common,
      layout: { padding: { top: 16, right: 4 } },
      scales: { x: categoryAxis, y: valueAxis },
      plugins: { tooltip, legend: { display: false } },
    },
    plugins: [marksPlugin(input)],
  });
}
