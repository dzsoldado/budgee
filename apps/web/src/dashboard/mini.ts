// The Add chart gallery's small previews (AddChart.dc.html: a 140×56 sketch per suggestion),
// drawn from the user's own data as plain SVG shapes: cheap, static, no Chart.js. The layouts
// follow the full chart's: lines, columns for time and weekdays, horizontal bars for the other
// groupings (with the compared value as a tick), a ring for doughnuts.
import type { ChartConfig, ChartData, SeriesChart } from "@budgee/core";
import { isListGroup } from "./format";

export type MiniRole = "current" | "compare" | "other";

export type MiniShape =
  | { type: "polyline"; points: string; role: MiniRole }
  | { type: "rect"; x: number; y: number; width: number; height: number; role: MiniRole }
  | { type: "tick"; x: number; y1: number; y2: number }
  | { type: "arc"; dash: string; offset: number; role: MiniRole; opacity: number };

export const MINI_WIDTH = 140;
export const MINI_HEIGHT = 56;
const LEFT = 6;
const RIGHT = 134;
const TOP = 6;
const BOTTOM = 50;
/** The ring's radius; its circumference is what the arcs' dashes are measured against. */
export const RING_RADIUS = 19;
const RING = 2 * Math.PI * RING_RADIUS;

const round = (n: number) => Math.round(n * 10) / 10;

/** A line's unfinished bucket sits at its projection, as on the dashboard. */
function plotted(data: SeriesChart, line: boolean): (number | null)[] {
  const current = data.series.find((s) => s.role === "current");
  if (!current) return [];
  return current.values.map((v, i) =>
    line && current.partial[i] ? (current.projected[i] ?? v) : v,
  );
}

/** Shapes for one chart; none when there is nothing to draw (the card then shows a baseline). */
export function miniShapes(data: ChartData, config: ChartConfig): MiniShape[] {
  if (data.shape === "table") return [];
  const kind = config.kind;
  const current = plotted(data, kind === "line");
  const compare = data.series.find((s) => s.role === "compare")?.values ?? null;
  const all = [...current, ...(compare ?? [])].filter((v): v is number => v !== null);
  if (data.labels.length === 0 || all.every((v) => v === 0)) return [];
  const other = data.hasOther ? data.labels.length - 1 : -1;

  if (kind === "doughnut") {
    const values = current.map((v) => Math.max(0, v ?? 0));
    const total = values.reduce((s, v) => s + v, 0);
    if (total === 0) return [];
    const n = values.length;
    let at = 0;
    return values.map((v, i) => {
      const length = (v / total) * RING;
      const arc: MiniShape = {
        type: "arc",
        dash: `${round(length)} ${round(RING)}`,
        offset: round(-at),
        role: i === other ? "other" : "current",
        opacity: i === other ? 1 : round(1 - (0.7 * i) / Math.max(1, n - 1)),
      };
      at += length;
      return arc;
    });
  }

  const lo = Math.min(0, ...all);
  const hi = Math.max(0, ...all);
  const span = hi - lo || 1;
  const y = (v: number) => round(BOTTOM - ((v - lo) / span) * (BOTTOM - TOP));

  if (kind === "line") {
    const n = current.length;
    const x = (i: number) =>
      round(n === 1 ? (LEFT + RIGHT) / 2 : LEFT + (i * (RIGHT - LEFT)) / (n - 1));
    const lines = (values: readonly (number | null)[], role: MiniRole) => {
      const shapes: MiniShape[] = [];
      let run: string[] = [];
      const flush = () => {
        if (run.length > 1) shapes.push({ type: "polyline", points: run.join(" "), role });
        run = [];
      };
      values.forEach((v, i) => {
        if (v === null) flush();
        else run.push(`${x(i)},${y(v)}`);
      });
      flush();
      return shapes;
    };
    return [...(compare ? lines(compare, "compare") : []), ...lines(current, "current")];
  }

  if (isListGroup(config.groupBy)) {
    // The first four groups as horizontal bars from the start, the compared value a tick.
    const max = Math.max(...all.map((v) => Math.max(0, v))) || 1;
    const width = (v: number | null) => round((Math.max(0, v ?? 0) / max) * 120);
    const shapes: MiniShape[] = [];
    for (let i = 0; i < Math.min(4, current.length); i++) {
      const top = 7 + i * 11;
      shapes.push({
        type: "rect",
        x: 8,
        y: top,
        width: width(current[i] ?? null),
        height: 7,
        role: i === other ? "other" : "current",
      });
      const cmp = compare?.[i];
      if (cmp !== undefined && cmp !== null)
        shapes.push({ type: "tick", x: 8 + width(cmp), y1: top - 2, y2: top + 9 });
    }
    return shapes;
  }

  // Columns: one slot per bucket, the compared bar beside the current one.
  const n = current.length;
  const slot = (RIGHT - LEFT) / n;
  const zero = y(0);
  const bar = (v: number | null, x: number, w: number, role: MiniRole): MiniShape => {
    const top = y(v ?? 0);
    return {
      type: "rect",
      x: round(x),
      y: Math.min(top, zero),
      width: round(w),
      height: round(Math.abs(zero - top)),
      role,
    };
  };
  const shapes: MiniShape[] = [];
  for (let i = 0; i < n; i++) {
    const start = LEFT + i * slot + slot * 0.15;
    if (compare) {
      shapes.push(bar(compare[i] ?? null, start, slot * 0.35, "compare"));
      shapes.push(bar(current[i] ?? null, start + slot * 0.35, slot * 0.35, "current"));
    } else {
      shapes.push(bar(current[i] ?? null, start, slot * 0.7, i === other ? "other" : "current"));
    }
  }
  return shapes;
}
