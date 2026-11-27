// A month (or year) title that opens a picker: a year with its twelve months, or twelve years,
// as a popover under the title on wide screens or a bottom sheet on phones (like the filter
// pickers). The title is as wide as the year's longest month name, so whatever sits beside it stays put
// while stepping through the months.
// Keyboard: arrows move over the cells (left and right carry on into the page before or after);
// Enter or Space picks; Escape closes back to the title; Tab leaves and closes.
import { createSignal, createUniqueId, For, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { t } from "../i18n";
import { formatPlainDate } from "../i18n/format";
import { todayIso } from "../lib/date";
import { monthOf, monthsOfYear, monthTitle } from "../list/month";
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from "../shell/icons";
import { placeUnder, usePanelDismiss } from "./FilterPicker";

export interface MonthPickerProps {
  /** `YYYY-MM`. */
  value: string;
  /** Months of a year, or years. */
  unit: "month" | "year";
  locale: string;
  /** The latest month (`YYYY-MM`) that can be picked; any when omitted. */
  max?: string | undefined;
  /** A `YYYY-MM`; picking a year keeps the value's month (at most `max`). */
  onChange: (month: string) => void;
  /** Bottom sheet (phones) instead of a popover. */
  sheet: boolean;
  /** Keep the longest month's width (default), for controls laid out beside the title. */
  steady?: boolean;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

export function MonthPicker(props: MonthPickerProps) {
  const id = createUniqueId();
  const [open, setOpen] = createSignal(false);
  let trigger!: HTMLButtonElement;
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.focus();
  };
  const year = () => Number(props.value.slice(0, 4));

  return (
    <>
      <button
        type="button"
        ref={trigger}
        class="month-pick"
        aria-haspopup="dialog"
        aria-expanded={open()}
        aria-controls={open() ? `${id}-panel` : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <span class="month-pick-label">
          <Show when={props.unit === "month"} fallback={<span>{props.value.slice(0, 4)}</span>}>
            <span>{monthTitle(props.value, props.locale)}</span>
            <For each={props.steady === false ? [] : monthsOfYear(year())}>
              {(month) => (
                <span class="month-pick-sizer" aria-hidden="true">
                  {monthTitle(month, props.locale)}
                </span>
              )}
            </For>
          </Show>
        </span>
        <ChevronDownIcon size={16} />
      </button>
      <Show when={open()}>
        <Portal>
          <PickerPanel {...props} id={id} trigger={trigger} close={close} />
        </Portal>
      </Show>
    </>
  );
}

function PickerPanel(
  props: MonthPickerProps & {
    id: string;
    trigger: HTMLButtonElement;
    close: (refocus: boolean) => void;
  },
) {
  let panel!: HTMLDivElement;
  const months = props.unit === "month";
  const current = monthOf(todayIso());
  const valueYear = Number(props.value.slice(0, 4));
  // A page holds twelve cells: a year's months, or twelve years from a multiple of 12. Cell
  // `page * 12 + index` is month `index` of year `page`, or year `page * 12 + index`.
  const [page, setPage] = createSignal(months ? valueYear : Math.floor(valueYear / 12));
  /** The cell (0–11) holding the grid's one tab stop. */
  const [active, setActive] = createSignal(
    months ? Number(props.value.slice(5, 7)) - 1 : valueYear % 12,
  );
  const cellId = (index: number) => `${props.id}-c${index}`;

  const atMost = (month: string) =>
    props.max !== undefined && month > props.max ? props.max : month;
  /** A year at the value's month, as picking a year keeps it. */
  const inYear = (year: string) => atMost(`${year}${props.value.slice(4, 7)}`);
  /** A month or a year as the cells name them: `YYYY-MM` or `YYYY`. */
  const key = (month: string) => (months ? month : month.slice(0, 4));
  const cellKey = (index: number) =>
    months ? `${pad(page(), 4)}-${pad(index + 1)}` : pad(page() * 12 + index, 4);
  /** The month a cell picks: the month itself, or the year at the value's month. */
  const monthAt = (index: number): string => (months ? cellKey(index) : inYear(cellKey(index)));
  const tooLate = (index: number) => props.max !== undefined && cellKey(index) > key(props.max);
  const cells = () => Array.from({ length: 12 }, (_, i) => i);
  const firstOfNextPage = () => (months ? `${pad(page() + 1, 4)}-01` : pad((page() + 1) * 12, 4));
  const hasNextPage = () =>
    props.max === undefined || firstOfNextPage() <= (months ? props.max : props.max.slice(0, 4));

  const pick = (month: string) => {
    props.onChange(month);
    props.close(true);
  };

  /** Moves the tab stop by `delta` cells, onto the page before or after past either end. */
  const move = (delta: number) => {
    const total = page() * 12 + active() + delta;
    setPage(Math.floor(total / 12));
    setActive(((total % 12) + 12) % 12);
    document.getElementById(cellId(active()))?.focus();
  };

  const onGridKeyDown = (event: KeyboardEvent) => {
    const deltas: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -4,
      ArrowDown: 4,
    };
    const delta = deltas[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    const rtl = getComputedStyle(panel).direction === "rtl";
    move(rtl && Math.abs(delta) === 1 ? -delta : delta);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      props.close(true);
      return;
    }
    // Tabbing out of either end closes the panel on the title, and the Tab then carries on
    // from there, as if the panel sat inline. The grid counts once: its tab stop.
    if (event.key !== "Tab") return;
    const stops = [
      ...panel.querySelectorAll<HTMLElement>("button:not([tabindex='-1']):not(:disabled)"),
    ];
    const edge = event.shiftKey ? stops[0] : stops[stops.length - 1];
    if (event.target === edge) props.close(true);
  };

  const onFocusOut = usePanelDismiss({
    panel: () => panel,
    trigger: props.trigger,
    sheet: props.sheet,
    close: props.close,
  });

  onMount(() => {
    if (!props.sheet) placeUnder(panel, props.trigger);
    document.getElementById(cellId(active()))?.focus();
  });

  const pageLabel = () => (months ? pad(page(), 4) : `${page() * 12} – ${page() * 12 + 11}`);
  const cellText = (index: number) =>
    months
      ? formatPlainDate(`${cellKey(index)}-01`, props.locale, { month: "short" })
      : cellKey(index);

  return (
    <>
      <Show when={props.sheet}>
        <div class="picker-backdrop" aria-hidden="true" />
      </Show>
      <div
        ref={panel}
        id={`${props.id}-panel`}
        role="dialog"
        aria-modal={props.sheet ? "true" : undefined}
        aria-labelledby={`${props.id}-title`}
        tabindex="-1"
        class={props.sheet ? "picker picker-sheet" : "picker picker-popover month-picker"}
        onFocusOut={onFocusOut}
        onKeyDown={onKeyDown}
      >
        <h2 id={`${props.id}-title`} class="visually-hidden">
          {months ? t("picker.chooseMonth") : t("picker.chooseYear")}
        </h2>
        <div class="picker-head month-picker-head">
          <div class="month-picker-page">
            <button
              type="button"
              class="month-picker-step"
              aria-label={months ? t("picker.previousYear") : t("picker.previousYears")}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeftIcon size={18} />
            </button>
            <span class="month-picker-page-label" aria-live="polite">
              {pageLabel()}
            </span>
            <button
              type="button"
              class="month-picker-step"
              aria-label={months ? t("picker.nextYear") : t("picker.nextYears")}
              disabled={!hasNextPage()}
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRightIcon size={18} />
            </button>
          </div>
          <button
            type="button"
            class="btn picker-done"
            onClick={() => pick(months ? atMost(current) : inYear(current.slice(0, 4)))}
          >
            {months ? t("picker.thisMonth") : t("picker.thisYear")}
          </button>
        </div>
        <fieldset class="month-grid" aria-label={pageLabel()}>
          <For each={cells()}>
            {(index) => {
              return (
                <button
                  type="button"
                  id={cellId(index)}
                  class="month-cell"
                  classList={{ "month-cell-today": cellKey(index) === key(current) }}
                  tabIndex={active() === index ? 0 : -1}
                  aria-label={months ? monthTitle(cellKey(index), props.locale) : undefined}
                  aria-current={cellKey(index) === key(props.value) ? "true" : undefined}
                  aria-disabled={tooLate(index) ? "true" : undefined}
                  onFocus={() => setActive(index)}
                  onKeyDown={onGridKeyDown}
                  onClick={() => {
                    if (!tooLate(index)) pick(monthAt(index));
                  }}
                >
                  {cellText(index)}
                </button>
              );
            }}
          </For>
        </fieldset>
      </div>
    </>
  );
}
