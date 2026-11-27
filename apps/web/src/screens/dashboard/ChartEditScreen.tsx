// Edit chart (ChartEdit.dc.html), also for a new chart from the gallery (`new?template=<key>`).
// A live preview on top (the dashboard's ChartView, updated shortly after each change), then
// the fields as drawn. Options that make no sense together are not offered (rules in
// dashboard/editor.ts); what doesn't apply is kept in the draft but neither previewed nor saved.
// Save and Remove go through the repository; leaving with unsaved changes asks first.
import {
  type ChartConfig,
  computeChart,
  type DashboardContext,
  type Exclusions,
  type LiveChartConfig,
  listTags,
  sameTag,
  type TransactionRow,
} from "@budgee/core";
import { useBeforeLeave, useHref, useNavigate, useParams, useSearchParams } from "@solidjs/router";
import {
  type Accessor,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  createUniqueId,
  For,
  type JSX,
  Match,
  on,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { BoldPrefix, createCombobox, Suggestions } from "../../components/combobox";
import { useApp } from "../../context";
import { addChart, removeChart, SaveChartError, saveChart } from "../../dashboard/charts";
import {
  type ChartDraft,
  COMPARES,
  changeConfig,
  compareApplies,
  cumulativeApplies,
  dashboardExclusionText,
  type ExclusionList,
  effectiveConfig,
  exclusionRows,
  groupingsFor,
  KINDS,
  type Kind,
  LIMITS,
  latestTag,
  limitApplies,
  metricApplies,
  metricsFor,
  newDraft,
  optionLabel,
  PERIODS,
  periodChoices,
  periodRefApplies,
  sameDraft,
  toggleExclusion,
} from "../../dashboard/editor";
import { dashboardMonth } from "../../dashboard/store";
import { createLiveQuery } from "../../db/live";
import { addTag, tagSuggestions } from "../../entry/suggest";
import { t } from "../../i18n";
import { todayIso } from "../../lib/date";
import { sortByOrder } from "../../list/categories";
import { monthTitle } from "../../list/month";
import {
  BarsIcon,
  CloseIcon,
  DoughnutIcon,
  LineChartIcon,
  TableIcon,
  TagIcon,
} from "../../shell/icons";
import { focusOnArrival, useDocumentTitle } from "../../shell/Screen";
import { ChartView } from "./ChartView";

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** How long the preview waits for the fields to settle before it redraws. */
const PREVIEW_DELAY_MS = 250;

export function ChartEditScreen() {
  const params = useParams<{ id: string }>();
  // A different chart is a different editor.
  return (
    <Show when={params.id} keyed>
      {(id) => <ChartEditLoader id={id} />}
    </Show>
  );
}

function ChartEditLoader(props: { id: string }) {
  const { db } = useApp();
  const [search] = useSearchParams<{ template?: string }>();
  const isNew = props.id === "new";
  useDocumentTitle(() => (isNew ? t("chartEdit.newTitle") : t("chartEdit.editTitle")));

  // The preview's data, the tags offered, and the trip a Trip total starts on.
  const rows = createLiveQuery(() => db.transactions.toArray());
  // Read once: a sync arriving while the editor is open must not reset what is being edited.
  const [row] = createResource(
    () => (isNew ? false : props.id),
    async (id) => {
      const found = await db.chart_configs.get(id);
      return found && !found.deleted ? (found as LiveChartConfig) : null;
    },
  );
  /** A new chart's starting point waits for the entries (Trip total's tag), then stays. */
  const [fresh, setFresh] = createSignal<ChartDraft>();
  createEffect(() => {
    const loaded = rows();
    if (!isNew || !loaded || fresh()) return;
    const key = search.template;
    setFresh(newDraft(key === undefined || key === "blank" ? null : key, latestTag(loaded)));
  });

  return (
    <Switch>
      <Match when={isNew && fresh()}>
        {(draft) => <ChartEditor id={null} initial={draft()} rows={rows} />}
      </Match>
      <Match when={!isNew && row.state === "errored"}>
        <Missing title={t("chartEdit.loadError")} hint={t("chartEdit.loadErrorHint")} />
      </Match>
      <Match when={!isNew && (row.state === "ready" || row.state === "refreshing")}>
        <Show
          when={row()}
          keyed
          fallback={<Missing title={t("chartEdit.notFound")} hint={t("chartEdit.notFoundHint")} />}
        >
          {(chart) => (
            <ChartEditor
              id={chart.id}
              initial={{ name: chart.name, config: chart.config }}
              rows={rows}
            />
          )}
        </Show>
      </Match>
    </Switch>
  );
}

function Missing(props: { title: string; hint: string }) {
  const dashboardHref = useHref(() => "/dashboard");
  return (
    <div class="chart-form-screen">
      <header class="form-bar">
        <a class="form-bar-close" href={dashboardHref()} aria-label={t("addChart.close")}>
          <CloseIcon size={22} strokeWidth={2} />
        </a>
        <h1 class="form-bar-title" tabindex="-1" ref={focusOnArrival}>
          {t("chartEdit.editTitle")}
        </h1>
        <span class="form-bar-spacer" />
      </header>
      <div class="editor-missing">
        <p class="editor-missing-title">{props.title}</p>
        <p class="hint">{props.hint}</p>
        <a class="btn btn-primary" href={dashboardHref()}>
          {t("chartEdit.backToDashboard")}
        </a>
      </div>
    </div>
  );
}

const KIND_ICONS: Record<Kind, (props: { size: number }) => JSX.Element> = {
  bar: BarsIcon,
  line: LineChartIcon,
  doughnut: DoughnutIcon,
  table: TableIcon,
};

function ChartEditor(props: {
  /** null: a new chart. */
  id: string | null;
  initial: ChartDraft;
  rows: Accessor<TransactionRow[] | undefined>;
}) {
  const { db, repo, settings } = useApp();
  const navigate = useNavigate();
  const dashboardHref = useHref(() => "/dashboard");
  const formId = createUniqueId();
  const editing = props.id;
  // A stored config that doesn't fit the rules (e.g. synced from an older version) opens as
  // what it will be saved as, so the fields show what the preview draws.
  const initial: ChartDraft = {
    ...props.initial,
    config: changeConfig(props.initial.config, {}),
  };

  const [draft, setDraft] = createSignal<ChartDraft>(initial);
  const config = () => draft().config;
  const patch = (changes: Partial<ChartConfig>) =>
    setDraft((d) => ({ ...d, config: changeConfig(d.config, changes) }));
  const setLimit = (limit: number | null) =>
    setDraft((d) => {
      const { limit: _, ...rest } = d.config;
      return { ...d, config: limit === null ? rest : { ...rest, limit } };
    });
  const dirty = () => !sameDraft(draft(), initial);

  // ─── Preview ──────────────────────────────────────────────────────────────
  const effective = createMemo(() => effectiveConfig(config()), undefined, { equals: sameJson });
  const [previewConfig, setPreviewConfig] = createSignal(effective());
  createEffect(
    on(
      effective,
      (next) => {
        const timer = setTimeout(() => setPreviewConfig(() => next), PREVIEW_DELAY_MS);
        onCleanup(() => clearTimeout(timer));
      },
      { defer: true },
    ),
  );
  const ctx = createMemo<DashboardContext>(() => ({
    today: todayIso(),
    dashboard: settings().dashboard,
    ref: `${dashboardMonth()}-01`,
  }));
  /** The first entry's date, where the months and years a chart can be on start. */
  const earliest = createMemo(() => {
    let first: string | null = null;
    for (const row of props.rows() ?? [])
      if (!row.deleted && (first === null || row.date < first)) first = row.date;
    return first;
  });
  const periodUnit = () => (config().period === "year" ? "year" : "month");
  const choices = createMemo(() =>
    periodChoices(periodUnit(), earliest(), ctx().today, config().periodRef),
  );
  /** A year keeps the month it had, so going back to a chosen month finds it again. */
  const setPeriodRef = (value: string) =>
    patch({
      periodRef: value.length === 4 ? `${value}${(config().periodRef ?? "-01").slice(4)}` : value,
    });
  const previewData = createMemo(() => {
    const rows = props.rows();
    return rows && computeChart(previewConfig(), rows, ctx());
  });

  // ─── Names for the lists ─────────────────────────────────────────────────
  const categoryRows = createLiveQuery(() => db.categories.toArray());
  const known = createMemo(() => listTags(props.rows() ?? []));
  /** Live names in Settings order, plus names this chart or the dashboard still exclude. */
  const withExcluded = (names: string[], list: ExclusionList) => {
    const extra = [...config().exclude[list], ...settings().dashboard.exclude[list]];
    const same = list === "tags" ? sameTag : (a: string, b: string) => a === b;
    for (const name of extra) if (!names.some((n) => same(n, name))) names.push(name);
    return names;
  };
  const active = (rows: readonly { name: string; archived: boolean }[]) =>
    rows.filter((r) => !r.archived).map((r) => r.name);
  const categories = createMemo(() => sortByOrder(categoryRows() ?? []));
  const expenseCategories = createMemo(() =>
    active(categories().filter((c) => c.type === "expense")),
  );
  const incomeCategories = createMemo(() =>
    active(categories().filter((c) => c.type === "income")),
  );
  /** Excluded names no list has any more, so they can be counted again. */
  const staleNames = createMemo(() => {
    const all = [...expenseCategories(), ...incomeCategories()];
    return withExcluded([...all], "categories").slice(all.length);
  });
  /** Which entries the chart reads: a table shows both income and expenses. */
  const reads = () => {
    const c = effective();
    if (c.kind === "table" || (c.metric !== "expenses" && c.metric !== "income")) return "both";
    return c.metric === "expenses" ? "expense" : "income";
  };
  // Stale names go with the expenses, or with the income when the chart reads only income.
  const expenseNames = createMemo(() => [...expenseCategories(), ...staleNames()]);
  const incomeNames = createMemo(() =>
    reads() === "income" ? [...incomeCategories(), ...staleNames()] : incomeCategories(),
  );
  const tagNames = createMemo(() =>
    withExcluded(
      known().map((k) => k.tag),
      "tags",
    ).sort((a, b) => a.localeCompare(b)),
  );

  // ─── Save, remove, leave ─────────────────────────────────────────────────
  let nameInput!: HTMLInputElement;
  let leaving = false;
  let saving = false;
  const [nameError, setNameError] = createSignal(false);
  const [formError, setFormError] = createSignal<"save" | "remove" | null>(null);
  /** The chart was removed on another device while being edited. */
  const [gone, setGone] = createSignal(false);

  const leave = () => {
    leaving = true;
    navigate("/dashboard");
  };

  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    if (saving || gone()) return;
    const name = draft().name.trim();
    if (name === "") {
      setNameError(true);
      nameInput.focus();
      return;
    }
    setFormError(null);
    saving = true;
    const fields = { name, config: effective() };
    try {
      if (editing) await saveChart(db, repo, editing, fields, initial.config);
      else await addChart(db, repo, fields);
    } catch (error) {
      saving = false;
      if (error instanceof SaveChartError) setGone(true);
      else {
        console.error("Saving the chart failed", error);
        setFormError("save");
      }
      return;
    }
    leave();
  };

  const [confirmingRemove, setConfirmingRemove] = createSignal(false);
  const remove = async () => {
    setConfirmingRemove(false);
    if (!editing) return;
    try {
      await removeChart(repo, editing);
    } catch (error) {
      console.error("Removing the chart failed", error);
      setFormError("remove");
      return;
    }
    leave();
  };

  /** Set while a navigation waits for "Discard changes?"; calling it leaves. */
  const [pendingLeave, setPendingLeave] = createSignal<(() => void) | null>(null);
  useBeforeLeave((event) => {
    if (leaving || gone() || !dirty()) return;
    event.preventDefault();
    setPendingLeave(() => () => {
      leaving = true;
      setPendingLeave(null);
      event.retry(true);
    });
  });

  // ─── Fields ──────────────────────────────────────────────────────────────
  const nameId = createUniqueId();
  const noteId = createUniqueId();
  /** Why Show or Compare with is fixed, said under the selects. */
  const fixedNote = () => {
    const c = effective();
    const notes: string[] = [];
    if (!metricApplies(c)) notes.push(t("chartEdit.metricTable"));
    if (!compareApplies(c))
      notes.push(
        c.kind === "bar" || c.kind === "line"
          ? t("chartEdit.compareAllTime")
          : t("chartEdit.compareKind"),
      );
    return notes.join(" ");
  };

  const toggle = (list: ExclusionList, name: string) =>
    patch({ exclude: toggleExclusion(config().exclude, list, name) });

  return (
    <div class="chart-form-screen chart-editor">
      <header class="form-bar">
        <a class="form-bar-cancel" href={dashboardHref()}>
          {t("chartEdit.cancel")}
        </a>
        <h1 class="form-bar-title" tabindex="-1" ref={focusOnArrival}>
          {editing ? t("chartEdit.editTitle") : t("chartEdit.newTitle")}
        </h1>
        <Show when={!gone()} fallback={<span class="form-bar-spacer" />}>
          <button type="submit" form={formId} class="btn btn-primary form-bar-save">
            {t("chartEdit.save")}
          </button>
        </Show>
      </header>

      <form id={formId} class="ce-form" novalidate onSubmit={save}>
        <div class="ce-preview">
          <span class="ce-label" aria-hidden="true">
            {t("chartEdit.preview")}
          </span>
          <Show when={previewData()}>
            {(data) => (
              <ChartView
                name={draft().name.trim() || t("chartEdit.untitled")}
                config={previewConfig()}
                data={data()}
              />
            )}
          </Show>
        </div>

        <div class="ce-fields">
          <div role="alert" class="ce-alerts">
            <Show when={gone()}>
              <div class="ce-alert">
                <p>{t("chartEdit.deletedElsewhere")}</p>
                <a class="btn btn-secondary" href={dashboardHref()}>
                  {t("chartEdit.backToDashboard")}
                </a>
              </div>
            </Show>
            <Show when={formError()}>
              <p class="field-error">
                {formError() === "save" ? t("chartEdit.errorSave") : t("chartEdit.errorRemove")}
              </p>
            </Show>
          </div>

          <div class="field">
            <label class="ce-label" for={nameId}>
              {t("chartEdit.name")}
            </label>
            <input
              ref={nameInput}
              id={nameId}
              type="text"
              class="input"
              value={draft().name}
              placeholder={t("chartEdit.untitled")}
              aria-invalid={nameError()}
              aria-describedby={nameError() ? `${nameId}-error` : undefined}
              onInput={(event) => {
                const name = event.currentTarget.value;
                setDraft((d) => ({ ...d, name }));
                if (name.trim() !== "") setNameError(false);
              }}
            />
            <Show when={nameError()}>
              <p id={`${nameId}-error`} class="field-error">
                {t("chartEdit.nameRequired")}
              </p>
            </Show>
          </div>

          <fieldset class="ce-group">
            <legend class="ce-label ce-legend">{t("chartEdit.kind")}</legend>
            <div class="ce-kinds">
              <For each={KINDS}>
                {(kind) => {
                  const Icon = KIND_ICONS[kind];
                  return (
                    <button
                      type="button"
                      class="ce-kind"
                      aria-pressed={config().kind === kind}
                      onClick={() => patch({ kind })}
                    >
                      <Icon size={20} />
                      {optionLabel.kind(kind)}
                    </button>
                  );
                }}
              </For>
            </div>
          </fieldset>

          <div class="ce-selects">
            <SelectField
              label={t("chartEdit.metric")}
              value={config().metric}
              options={metricsFor(config().kind)}
              text={optionLabel.metric}
              disabled={!metricApplies(effective())}
              describedBy={fixedNote() ? noteId : undefined}
              onChange={(metric) => patch({ metric })}
            />
            <SelectField
              label={t("chartEdit.groupBy")}
              value={config().groupBy}
              options={groupingsFor(config().kind)}
              text={optionLabel.groupBy}
              onChange={(groupBy) => patch({ groupBy })}
            />
            <SelectField
              label={t("chartEdit.period")}
              value={config().period}
              options={PERIODS}
              text={optionLabel.period}
              onChange={(period) =>
                patch(
                  config().periodRef === undefined
                    ? { period, periodRef: dashboardMonth() }
                    : { period },
                )
              }
            />
            <Show when={periodRefApplies(config())}>
              <SelectField
                label={
                  periodUnit() === "year" ? t("chartEdit.periodYear") : t("chartEdit.periodMonth")
                }
                value={(config().periodRef ?? dashboardMonth()).slice(
                  0,
                  periodUnit() === "year" ? 4 : 7,
                )}
                options={choices()}
                text={(value) =>
                  value.length === 4 ? value : monthTitle(value, settings().locale)
                }
                onChange={setPeriodRef}
              />
            </Show>
            <SelectField
              label={t("chartEdit.compare")}
              value={effective().compare}
              options={COMPARES}
              text={optionLabel.compare}
              disabled={!compareApplies(effective())}
              describedBy={fixedNote() ? noteId : undefined}
              onChange={(compare) => patch({ compare })}
            />
          </div>
          <Show when={fixedNote()}>
            <p class="hint ce-note" id={noteId}>
              {fixedNote()}
            </p>
          </Show>

          <Show when={cumulativeApplies(effective())}>
            <SwitchRow
              title={t("chartEdit.cumulative")}
              hint={t("chartEdit.cumulativeHint")}
              checked={config().cumulative}
              onChange={(cumulative) => patch({ cumulative })}
            />
          </Show>
          <Show when={limitApplies(effective())}>
            <LimitRow value={config().limit ?? null} onChange={setLimit} />
          </Show>

          <section class="ce-counts" aria-labelledby={`${formId}-counts`}>
            <div class="ce-counts-head">
              <h2 id={`${formId}-counts`} class="ce-counts-title">
                {t("chartEdit.counts")}
              </h2>
              <span class="ce-counts-hint">{t("chartEdit.countsHint")}</span>
            </div>

            <SwitchRow
              title={t("chartEdit.useDashboard")}
              hint={dashboardExclusionText(settings().dashboard.exclude, settings().locale)}
              checked={config().useDashboardExclusions}
              onChange={(useDashboardExclusions) => patch({ useDashboardExclusions })}
            />

            <Show when={reads() !== "income"}>
              <CheckList
                title={t("chartEdit.expenses")}
                list="categories"
                names={expenseNames()}
                exclude={config().exclude}
                dashboard={settings().dashboard.exclude}
                useDashboard={config().useDashboardExclusions}
                onToggle={toggle}
              />
            </Show>
            <Show when={reads() !== "expense" && incomeNames().length > 0}>
              <CheckList
                title={t("chartEdit.income")}
                list="categories"
                names={incomeNames()}
                exclude={config().exclude}
                dashboard={settings().dashboard.exclude}
                useDashboard={config().useDashboardExclusions}
                onToggle={toggle}
              />
            </Show>
            <CheckList
              title={t("chartEdit.tags")}
              list="tags"
              names={tagNames()}
              exclude={config().exclude}
              dashboard={settings().dashboard.exclude}
              useDashboard={config().useDashboardExclusions}
              onToggle={toggle}
              empty={t("chartEdit.noTags")}
              tag
            >
              <OnlyTags
                tags={config().onlyTags}
                known={known()}
                onChange={(onlyTags) => patch({ onlyTags })}
              />
            </CheckList>
          </section>

          <Show when={editing && !gone()}>
            <button type="button" class="ce-remove" onClick={() => setConfirmingRemove(true)}>
              {t("chartEdit.remove")}
            </button>
          </Show>
        </div>
      </form>

      <ConfirmDialog
        open={confirmingRemove()}
        title={t("dashboard.removeTitle", { name: initial.name })}
        body={t("dashboard.removeBody")}
        confirmLabel={t("dashboard.removeConfirm")}
        cancelLabel={t("dashboard.cancel")}
        destructive
        onConfirm={() => void remove()}
        onCancel={() => setConfirmingRemove(false)}
      />
      <ConfirmDialog
        open={pendingLeave() !== null}
        title={t("chartEdit.discardTitle")}
        body={t("chartEdit.discardBody")}
        confirmLabel={t("chartEdit.discardConfirm")}
        cancelLabel={t("chartEdit.keepEditing")}
        destructive
        onConfirm={() => pendingLeave()?.()}
        onCancel={() => setPendingLeave(null)}
      />
    </div>
  );
}

function SelectField<T extends string>(props: {
  label: string;
  value: T;
  options: readonly T[];
  text: (option: T) => string;
  disabled?: boolean;
  describedBy?: string | undefined;
  onChange: (value: T) => void;
}) {
  return (
    <label class="field">
      <span class="ce-label">{props.label}</span>
      <select
        class="ce-select"
        disabled={props.disabled}
        aria-describedby={props.disabled ? props.describedBy : undefined}
        onChange={(event) => props.onChange(event.currentTarget.value as T)}
      >
        <For each={props.options}>
          {(option) => (
            <option value={option} selected={option === props.value}>
              {props.text(option)}
            </option>
          )}
        </For>
      </select>
    </label>
  );
}

function SwitchRow(props: {
  title: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = createUniqueId();
  return (
    <div class="ce-row">
      <span class="ce-row-text">
        <span class="ce-row-title" id={`${id}-title`}>
          {props.title}
        </span>
        <span class="ce-row-hint" id={`${id}-hint`}>
          {props.hint}
        </span>
      </span>
      <button
        type="button"
        role="switch"
        class="switch"
        aria-checked={props.checked}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-hint`}
        onClick={() => props.onChange(!props.checked)}
      />
    </div>
  );
}

function LimitRow(props: { value: number | null; onChange: (limit: number | null) => void }) {
  const id = createUniqueId();
  const options = () =>
    props.value === null || LIMITS.includes(props.value)
      ? LIMITS
      : [...LIMITS, props.value].sort((a, b) => a - b);
  return (
    <div class="ce-row">
      <span class="ce-row-text">
        <label class="ce-row-title" for={id}>
          {t("chartEdit.limit")}
        </label>
        <span class="ce-row-hint" id={`${id}-hint`}>
          {t("chartEdit.limitHint")}
        </span>
      </span>
      <select
        id={id}
        class="ce-select ce-select-small"
        aria-describedby={`${id}-hint`}
        onChange={(event) => {
          const value = event.currentTarget.value;
          props.onChange(value === "" ? null : Number(value));
        }}
      >
        <option value="" selected={props.value === null}>
          {t("chartEdit.limitAll")}
        </option>
        <For each={options()}>
          {(n) => (
            <option value={n} selected={props.value === n}>
              {t("chartEdit.limitTop", { n })}
            </option>
          )}
        </For>
      </select>
    </div>
  );
}

/** A card of names to tick (counted) or untick (left out of this chart), as drawn. */
function CheckList(props: {
  title: string;
  list: ExclusionList;
  names: string[];
  exclude: Exclusions;
  dashboard: Exclusions;
  useDashboard: boolean;
  onToggle: (list: ExclusionList, name: string) => void;
  tag?: boolean;
  empty?: string;
  children?: JSX.Element;
}) {
  const rows = createMemo(() =>
    exclusionRows(props.list, props.names, props.exclude, props.dashboard, props.useDashboard),
  );
  const rowOf = (name: string) => rows().find((r) => r.name === name);
  return (
    <fieldset class="ce-list">
      <legend class="visually-hidden">{props.title}</legend>
      <div class="ce-list-head">
        <span class="ce-list-title">{props.title}</span>
        <Show when={rows().length > 0}>
          <span class="ce-list-count">
            {t("chartEdit.counted", {
              n: rows().filter((r) => r.on).length,
              total: rows().length,
            })}
          </span>
        </Show>
      </div>
      {props.children}
      <Show
        when={props.names.length > 0}
        fallback={<p class="ce-list-empty hint">{props.empty}</p>}
      >
        {/* Keyed by name, so a toggled box keeps its focus. */}
        <For each={props.names}>
          {(name) => {
            const row = () => rowOf(name);
            return (
              <label class="ce-check">
                <input
                  type="checkbox"
                  checked={row()?.on ?? true}
                  disabled={row()?.locked ?? false}
                  onChange={() => props.onToggle(props.list, name)}
                />
                <span class="ce-check-name" classList={{ "ce-check-off": !(row()?.on ?? true) }}>
                  <Show when={props.tag}>
                    <TagIcon size={12} strokeWidth={2.2} />
                  </Show>
                  {name}
                </span>
                <Show when={row()?.note}>
                  {(note) => (
                    <span class="ce-check-note">
                      {note() === "dashboard"
                        ? t("chartEdit.noteDashboard")
                        : t("chartEdit.noteHere")}
                    </span>
                  )}
                </Show>
              </label>
            );
          }}
        </For>
      </Show>
    </fieldset>
  );
}

/** "Only entries tagged": tag chips with autocomplete from the tags in use. */
function OnlyTags(props: {
  tags: readonly string[];
  known: ReturnType<typeof listTags>;
  onChange: (tags: string[]) => void;
}) {
  const id = createUniqueId();
  const [typed, setTyped] = createSignal("");
  const [error, setError] = createSignal(false);
  const items = createMemo(() => tagSuggestions(props.known, typed(), props.tags));
  let input!: HTMLInputElement;

  const add = (text: string) => {
    if (text.trim() === "") return;
    const added = addTag(
      props.tags,
      text,
      props.known.map((k) => k.tag),
    );
    if (!added.ok) {
      setError(true);
      return;
    }
    props.onChange(added.tags);
    setTyped("");
    input.value = "";
    setError(false);
  };
  const pick = (index: number) => {
    const item = items()[index];
    if (item) add(item.tag);
  };
  const combo = createCombobox({ count: () => items().length, pick });
  const remove = (tag: string) => {
    props.onChange(props.tags.filter((x) => x !== tag));
    input.focus();
  };

  return (
    <div class="ce-only">
      <div class="ce-only-row">
        <label class="ce-only-label" for={id}>
          {t("chartEdit.onlyTagged")}
        </label>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: a click on the box's padding focuses its input */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: the input inside handles the keys */}
        <div
          class="tag-box ce-only-box"
          classList={{ "tag-box-invalid": error() }}
          onClick={(event) => {
            if (event.target === event.currentTarget) input.focus();
          }}
        >
          <For each={props.tags}>
            {(tag) => (
              <span class="tag-chip">
                <TagIcon size={12} />
                {tag}
                <button
                  type="button"
                  class="tag-remove"
                  aria-label={t("chartEdit.removeOnlyTag", { tag })}
                  onClick={() => remove(tag)}
                >
                  <CloseIcon size={14} />
                </button>
              </span>
            )}
          </For>
          <input
            ref={input}
            id={id}
            type="text"
            class="tag-input"
            placeholder={props.tags.length === 0 ? t("chartEdit.onlyTaggedPlaceholder") : ""}
            aria-describedby={`${id}-hint`}
            aria-invalid={error()}
            {...combo.inputProps()}
            value={typed()}
            onInput={(event) => {
              setTyped(event.currentTarget.value);
              setError(false);
              combo.show();
            }}
            onKeyDown={(event) => {
              if (combo.onKeyDown(event)) return;
              if (event.key === "Enter") {
                event.preventDefault();
                add(typed());
              } else if (event.key === "Backspace" && typed() === "" && props.tags.length) {
                props.onChange(props.tags.slice(0, -1));
              }
            }}
            onBlur={() => combo.hide()}
          />
        </div>
      </div>
      <Suggestions combobox={combo} label={t("entry.tagsInUse")} items={items()} pick={pick}>
        {(item) => (
          <>
            <BoldPrefix text={item.tag} length={typed().trim().length} />
            <span class="suggestion-meta">{t("entry.used", { count: item.count })}</span>
          </>
        )}
      </Suggestions>
      <p id={`${id}-hint`} class="hint ce-only-hint" aria-live="polite">
        {error() ? t("entry.errorTagSemicolon") : t("chartEdit.onlyTaggedHint")}
      </p>
    </div>
  );
}
