// The "⋯" on a dashboard chart: a menu button (WAI-ARIA menu button pattern) with Edit, Move up,
// Move down and Remove. Opening moves focus to the first item (ArrowUp on the button: the last);
// ArrowUp/ArrowDown/Home/End move between items; Escape closes and returns focus to the button;
// Tab or a tap outside closes it.
import { createEffect, createSignal, createUniqueId, onCleanup, Show } from "solid-js";
import { t } from "../../i18n";
import { MoreIcon } from "../../shell/icons";

export function ChartMenu(props: {
  name: string;
  /** Marks the button, so the dashboard can focus it again after a move re-renders it. */
  chartId: string;
  editHref: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const id = createUniqueId();
  const [open, setOpen] = createSignal(false);
  let wrap!: HTMLDivElement;
  let button!: HTMLButtonElement;
  let list: HTMLDivElement | undefined;

  const items = () => [...(list?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  const focusItem = (index: number) => {
    const all = items();
    all[(index + all.length) % all.length]?.focus();
  };
  const show = (first: boolean) => {
    setOpen(true);
    focusItem(first ? 0 : -1);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.focus();
  };

  createEffect(() => {
    if (!open()) return;
    const outside = (event: PointerEvent) => {
      if (!wrap.contains(event.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", outside);
    onCleanup(() => document.removeEventListener("pointerdown", outside));
  });

  const onButtonKey = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    show(event.key === "ArrowDown");
  };
  const onMenuKey = (event: KeyboardEvent) => {
    const at = items().indexOf(document.activeElement as HTMLElement);
    switch (event.key) {
      case "ArrowDown":
        focusItem(at + 1);
        break;
      case "ArrowUp":
        focusItem(at - 1);
        break;
      case "Home":
        focusItem(0);
        break;
      case "End":
        focusItem(-1);
        break;
      case "Escape":
        close(true);
        break;
      case "Tab":
        setOpen(false);
        return;
      default:
        return;
    }
    event.preventDefault();
  };
  /** Closes with focus back on the button, then acts (a move or the remove confirm). */
  const choose = (action: () => void) => {
    close(true);
    action();
  };

  return (
    <div class="chart-menu" ref={wrap}>
      <button
        type="button"
        ref={button}
        class="chart-edit"
        data-chart-menu={props.chartId}
        aria-label={t("dashboard.chartOptions", { name: props.name })}
        aria-haspopup="menu"
        aria-expanded={open()}
        aria-controls={open() ? `${id}-menu` : undefined}
        onClick={() => (open() ? close(true) : show(true))}
        onKeyDown={onButtonKey}
      >
        <MoreIcon size={20} />
      </button>
      <Show when={open()}>
        <div
          ref={list}
          id={`${id}-menu`}
          role="menu"
          class="chart-menu-list"
          aria-label={props.name}
          onKeyDown={onMenuKey}
        >
          <a role="menuitem" tabIndex={-1} class="chart-menu-item" href={props.editHref}>
            {t("dashboard.menuEdit")}
          </a>
          <Show when={props.canMoveUp}>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              class="chart-menu-item"
              onClick={() => choose(() => props.onMove(-1))}
            >
              {t("dashboard.menuMoveUp")}
            </button>
          </Show>
          <Show when={props.canMoveDown}>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              class="chart-menu-item"
              onClick={() => choose(() => props.onMove(1))}
            >
              {t("dashboard.menuMoveDown")}
            </button>
          </Show>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            class="chart-menu-item chart-menu-danger"
            onClick={() => choose(props.onRemove)}
          >
            {t("dashboard.menuRemove")}
          </button>
        </div>
      </Show>
    </div>
  );
}
