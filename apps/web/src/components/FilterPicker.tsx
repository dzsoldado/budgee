// A multi-select filter: a trigger button opening a listbox, as a popover under the button on
// wide screens or a bottom sheet on phones. "Any" (first option) clears the choice.
// Keyboard (roving focus over the options): arrows, Home/End move; Space/Enter toggle; Escape
// closes back to the trigger; Tab leaves and closes.
import {
  createSignal,
  createUniqueId,
  For,
  Index,
  type JSX,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { Portal } from "solid-js/web";
import { t } from "../i18n";
import { CheckIcon } from "../shell/icons";

export interface PickerGroup {
  /** Shown above the group's options; omit for a single group. */
  label?: string;
  options: readonly string[];
}

export interface FilterPickerProps {
  /** The filter's name: the dialog title and the listbox name. */
  label: string;
  groups: readonly PickerGroup[];
  selected: readonly string[];
  onChange: (selected: string[]) => void;
  /** Option equality; tags compare ignoring case. Defaults to `===`. */
  same?: ((a: string, b: string) => boolean) | undefined;
  /** Shown instead of options when there are none. */
  emptyText?: string | undefined;
  /** Bottom sheet (phones) instead of a popover. */
  sheet: boolean;
  triggerClass: string;
  /** Trigger content: the summary of the choice, plus any icon. */
  children: JSX.Element;
}

export function FilterPicker(props: FilterPickerProps) {
  const id = createUniqueId();
  const [open, setOpen] = createSignal(false);
  let trigger!: HTMLButtonElement;

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.focus();
  };

  return (
    <>
      <button
        type="button"
        ref={trigger}
        class={props.triggerClass}
        aria-haspopup="listbox"
        aria-expanded={open()}
        aria-controls={open() ? `${id}-panel` : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        {props.children}
      </button>
      <Show when={open()}>
        <Portal>
          <PickerPanel {...props} id={id} trigger={trigger} close={close} />
        </Portal>
      </Show>
    </>
  );
}

/** Under the trigger, its inline-start edge aligned, kept inside the viewport. */
export function placeUnder(panel: HTMLElement, trigger: HTMLElement): void {
  const rect = trigger.getBoundingClientRect();
  const viewport = document.documentElement.clientWidth;
  const rtl = getComputedStyle(trigger).direction === "rtl";
  const start = rtl ? viewport - rect.right : rect.left;
  const room = viewport - panel.offsetWidth - 16;
  panel.style.setProperty("inset-block-start", `${rect.bottom + window.scrollY + 6}px`);
  panel.style.setProperty(
    "inset-inline-start",
    `${Math.max(16, Math.min(start, room)) + (rtl ? 0 : window.scrollX)}px`,
  );
}

/**
 * Closes a filter panel on a click outside it or a viewport width change, for as long as the
 * calling component lives. Returns the panel's focusout handler: focus leaving closes it too.
 */
export function usePanelDismiss(options: {
  panel: () => HTMLElement;
  trigger: HTMLElement;
  sheet: boolean;
  close: (refocus: boolean) => void;
}): (event: FocusEvent) => void {
  const { panel, trigger, sheet, close } = options;
  const onPointerDown = (event: PointerEvent) => {
    const target = event.target as Node;
    // The sheet is modal: tapping its backdrop returns to the trigger.
    if (!panel().contains(target) && !trigger.contains(target)) close(sheet);
  };
  // Phones fire resize when the URL bar slides in or out; only a width change moves the panel.
  const openWidth = window.innerWidth;
  const onResize = () => {
    if (window.innerWidth !== openWidth) close(false);
  };
  onMount(() => {
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", onResize);
  });
  onCleanup(() => {
    document.removeEventListener("pointerdown", onPointerDown);
    window.removeEventListener("resize", onResize);
  });
  return (event) => {
    const next = event.relatedTarget as Node | null;
    if (next && !panel().contains(next) && next !== trigger) close(false);
  };
}

function PickerPanel(
  props: FilterPickerProps & {
    id: string;
    trigger: HTMLButtonElement;
    close: (refocus: boolean) => void;
  },
) {
  const same = (a: string, b: string) => (props.same ? props.same(a, b) : a === b);
  const isSelected = (value: string) => props.selected.some((s) => same(s, value));
  const values = () => props.groups.flatMap((g) => g.options);
  // Index 0 is "Any"; option i of `values()` is index i + 1.
  const firstSelected = values().findIndex(isSelected);
  const [active, setActive] = createSignal(firstSelected + 1);
  const optionId = (index: number) => `${props.id}-opt-${index}`;
  let panel!: HTMLDivElement;
  let done!: HTMLButtonElement;

  const toggle = (index: number) => {
    if (index === 0) return props.onChange([]);
    const value = values()[index - 1];
    if (value === undefined) return;
    props.onChange(
      isSelected(value)
        ? props.selected.filter((s) => !same(s, value))
        : [...props.selected, value],
    );
  };

  const move = (index: number) => {
    const next = Math.max(0, Math.min(values().length, index));
    setActive(next);
    document.getElementById(optionId(next))?.focus();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const keys: Record<string, () => void> = {
      ArrowDown: () => move(active() + 1),
      ArrowUp: () => move(active() - 1),
      Home: () => move(0),
      End: () => move(values().length),
      " ": () => toggle(active()),
      Enter: () => toggle(active()),
    };
    const action = keys[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  };

  const onPanelKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      props.close(true);
    }
    // The panel holds two tab stops, Done then the options. Tabbing out of either end closes
    // it on the trigger, and the Tab then carries on from there, as if the panel sat inline.
    if (event.key === "Tab" && event.shiftKey === (event.target === done)) props.close(true);
  };

  const onFocusOut = usePanelDismiss({
    panel: () => panel,
    trigger: props.trigger,
    sheet: props.sheet,
    close: props.close,
  });

  onMount(() => {
    if (!props.sheet) placeUnder(panel, props.trigger);
    move(active());
  });

  /** List index of a group's first option: after "Any" and the groups before it. */
  const offset = (group: number) =>
    1 + props.groups.slice(0, group).reduce((n, g) => n + g.options.length, 0);

  const option = (label: string, index: () => number, value?: string) => {
    const selected = () => (value === undefined ? props.selected.length === 0 : isSelected(value));
    return (
      <div
        id={optionId(index())}
        role="option"
        class="picker-option"
        tabIndex={active() === index() ? 0 : -1}
        aria-selected={selected()}
        onFocus={() => setActive(index())}
        onKeyDown={onKeyDown}
        onClick={() => toggle(index())}
      >
        <span class="picker-option-label">{label}</span>
        <span class="picker-check" aria-hidden="true">
          <CheckIcon size={14} strokeWidth={2.6} />
        </span>
      </div>
    );
  };
  // Options are keyed by value, so a choice never re-creates the focused option.
  const options = (group: () => PickerGroup, groupIndex: number) => (
    <For each={group().options}>
      {(value, i) => option(value, () => offset(groupIndex) + i(), value)}
    </For>
  );

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
        class={props.sheet ? "picker picker-sheet" : "picker picker-popover"}
        onFocusOut={onFocusOut}
        onKeyDown={onPanelKeyDown}
      >
        <div class="picker-head">
          <h2 id={`${props.id}-title`} class="picker-title">
            {props.label}
          </h2>
          <button
            type="button"
            ref={done}
            class="btn picker-done"
            onClick={() => props.close(true)}
          >
            {t("filter.done")}
          </button>
        </div>
        <div
          role="listbox"
          class="picker-list"
          aria-labelledby={`${props.id}-title`}
          aria-multiselectable="true"
        >
          {option(t("filter.any"), () => 0)}
          <Index each={props.groups}>
            {(group, groupIndex) => (
              <Show when={group().label} fallback={options(group, groupIndex)}>
                {(label) => (
                  <fieldset class="picker-group">
                    <legend class="picker-group-label">{label()}</legend>
                    {options(group, groupIndex)}
                  </fieldset>
                )}
              </Show>
            )}
          </Index>
        </div>
        <Show when={values().length === 0 && props.emptyText}>
          <p class="hint picker-empty">{props.emptyText}</p>
        </Show>
      </div>
    </>
  );
}
