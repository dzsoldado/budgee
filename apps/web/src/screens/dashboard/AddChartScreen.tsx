// Add chart (AddChart.dc.html): the suggestions, each with a small preview drawn from the user's
// own entries, and a blank chart. Each opens the chart editor pre-filled; nothing is saved
// until Save there. A preview is computed only once its card comes near the screen.
import {
  type ChartConfig,
  computeChart,
  type DashboardContext,
  type TransactionRow,
} from "@budgee/core";
import { useHref } from "@solidjs/router";
import { createMemo, createSignal, For, Match, onCleanup, onMount, Switch } from "solid-js";
import { useApp } from "../../context";
import {
  latestTag,
  newDraft,
  TEMPLATES,
  templateDescription,
  templateTitle,
} from "../../dashboard/editor";
import {
  MINI_HEIGHT,
  MINI_WIDTH,
  type MiniRole,
  type MiniShape,
  miniShapes,
  RING_RADIUS,
} from "../../dashboard/mini";
import { dashboardMonth } from "../../dashboard/store";
import { createLiveQuery } from "../../db/live";
import { t } from "../../i18n";
import { todayIso } from "../../lib/date";
import { CloseIcon, PlusIcon } from "../../shell/icons";
import { focusOnArrival, useDocumentTitle } from "../../shell/Screen";

export function AddChartScreen() {
  const { db, settings } = useApp();
  useDocumentTitle(() => t("addChart.title"));
  const dashboardHref = useHref(() => "/dashboard");
  const newHref = useHref(() => "/dashboard/chart/new");

  const rows = createLiveQuery(() => db.transactions.toArray());
  const tripTag = createMemo(() => latestTag(rows() ?? []));
  const ctx = createMemo<DashboardContext>(() => ({
    today: todayIso(),
    dashboard: settings().dashboard,
    ref: `${dashboardMonth()}-01`,
  }));

  return (
    <div class="chart-form-screen">
      <header class="form-bar">
        <a class="form-bar-close" href={dashboardHref()} aria-label={t("addChart.close")}>
          <CloseIcon size={22} strokeWidth={2} />
        </a>
        <h1 class="form-bar-title" tabindex="-1" ref={focusOnArrival}>
          {t("addChart.title")}
        </h1>
        <span class="form-bar-spacer" />
      </header>

      <div class="gallery">
        <p class="gallery-intro">{t("addChart.intro")}</p>
        <ul class="gallery-grid" aria-label={t("addChart.suggestions")}>
          <For each={TEMPLATES}>
            {(template) => (
              <li>
                <a class="gallery-card" href={`${newHref()}?template=${template.key}`}>
                  <MiniPreview
                    config={newDraft(template.key, tripTag()).config}
                    rows={rows()}
                    ctx={ctx()}
                  />
                  <span class="gallery-title">{templateTitle(template.key)}</span>
                  <span class="gallery-hint">{templateDescription(template.key)}</span>
                </a>
              </li>
            )}
          </For>
        </ul>
        <a class="gallery-blank" href={`${newHref()}?template=blank`}>
          <PlusIcon size={18} strokeWidth={2.2} />
          {t("addChart.blank")}
        </a>
      </div>
    </div>
  );
}

const ROLE_COLOR: Record<Exclude<MiniRole, "current">, string> = {
  compare: "var(--compare)",
  other: "var(--compare)",
};

/** Money out orange, money in teal, anything else neutral ink (never purple), as on the dashboard. */
const metricColor = (metric: ChartConfig["metric"]) =>
  metric === "expenses" ? "var(--expense)" : metric === "income" ? "var(--income)" : "var(--ink)";

function MiniPreview(props: {
  config: ChartConfig;
  rows: readonly TransactionRow[] | undefined;
  ctx: DashboardContext;
}) {
  const [near, setNear] = createSignal(false);
  let svg!: SVGSVGElement;
  onMount(() => {
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        setNear(true);
        observer.disconnect();
      },
      { rootMargin: "200px" },
    );
    observer.observe(svg);
    onCleanup(() => observer.disconnect());
  });

  const shapes = createMemo<MiniShape[] | null>(() => {
    if (!near() || !props.rows) return null;
    return miniShapes(computeChart(props.config, props.rows, props.ctx), props.config);
  });
  const color = (role: MiniRole) =>
    role === "current" ? metricColor(props.config.metric) : ROLE_COLOR[role];

  return (
    <svg
      ref={svg}
      class="gallery-preview"
      viewBox={`0 0 ${MINI_WIDTH} ${MINI_HEIGHT}`}
      width="100%"
      aria-hidden="true"
    >
      {/* Nothing to draw (yet): a dashed baseline. */}
      <Switch
        fallback={
          <line
            x1="6"
            x2="134"
            y1="50"
            y2="50"
            style={{ stroke: "var(--axis)" }}
            stroke-dasharray="3 3"
          />
        }
      >
        <Match when={(shapes()?.length ?? 0) > 0}>
          <g transform={`rotate(-90 ${MINI_WIDTH / 2} ${MINI_HEIGHT / 2})`}>
            <For each={shapes()?.filter((s) => s.type === "arc")}>
              {(arc) =>
                arc.type === "arc" && (
                  <circle
                    cx={MINI_WIDTH / 2}
                    cy={MINI_HEIGHT / 2}
                    r={RING_RADIUS}
                    fill="none"
                    stroke-width="9"
                    style={{ stroke: color(arc.role) }}
                    stroke-opacity={arc.opacity}
                    stroke-dasharray={arc.dash}
                    stroke-dashoffset={arc.offset}
                  />
                )
              }
            </For>
          </g>
          <For each={shapes()?.filter((s) => s.type !== "arc")}>
            {(shape) => (
              <Switch>
                <Match when={shape.type === "polyline" && shape}>
                  {(line) => (
                    <polyline
                      fill="none"
                      style={{ stroke: color(line().role) }}
                      stroke-width="2"
                      stroke-linejoin="round"
                      stroke-linecap="round"
                      points={line().points}
                    />
                  )}
                </Match>
                <Match when={shape.type === "rect" && shape}>
                  {(rect) => (
                    <rect
                      x={rect().x}
                      y={rect().y}
                      width={rect().width}
                      height={rect().height}
                      rx="1.5"
                      style={{ fill: color(rect().role) }}
                    />
                  )}
                </Match>
                <Match when={shape.type === "tick" && shape}>
                  {(tick) => (
                    <line
                      x1={tick().x}
                      x2={tick().x}
                      y1={tick().y1}
                      y2={tick().y2}
                      style={{ stroke: "var(--compare)" }}
                      stroke-width="2.5"
                      stroke-linecap="round"
                    />
                  )}
                </Match>
              </Switch>
            )}
          </For>
        </Match>
      </Switch>
    </svg>
  );
}
