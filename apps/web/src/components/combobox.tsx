// An input with a list of suggestions (ARIA combobox, list autocomplete). Focus stays in the
// input; the active option is announced through aria-activedescendant. Keys: ArrowDown and
// ArrowUp move through the options (ArrowDown also opens the list), Enter picks the active
// option, Escape closes the list. Nothing is active until an arrow key is pressed, so Enter
// on its own keeps the text as typed.
import { type Accessor, createSignal, createUniqueId, For, type JSX, Show } from "solid-js";

export interface Combobox {
  /** Attributes for the input. */
  inputProps: () => JSX.InputHTMLAttributes<HTMLInputElement>;
  /** Handles the combobox keys; true when the key was used (and its default prevented). */
  onKeyDown: (event: KeyboardEvent) => boolean;
  /** Opens the list (on typing); it shows only while there are options. */
  show: () => void;
  hide: () => void;
  expanded: Accessor<boolean>;
  active: Accessor<number>;
  listId: string;
  optionId: (index: number) => string;
}

export function createCombobox(options: {
  count: Accessor<number>;
  pick: (index: number) => void;
}): Combobox {
  const id = createUniqueId();
  const listId = `${id}-list`;
  const optionId = (index: number) => `${id}-opt-${index}`;
  const [open, setOpen] = createSignal(false);
  const [active, setActive] = createSignal(-1);
  const expanded = () => open() && options.count() > 0;
  const current = () => (active() < options.count() ? active() : -1);

  const show = () => {
    setActive(-1);
    setOpen(true);
  };
  const hide = () => {
    setOpen(false);
    setActive(-1);
  };

  const onKeyDown = (event: KeyboardEvent): boolean => {
    const count = options.count();
    const step = (delta: number) => {
      if (!open()) setOpen(true);
      setActive((a) => (a < 0 ? (delta > 0 ? 0 : count - 1) : (a + delta + count) % count));
    };
    let used = true;
    if (event.key === "ArrowDown" && count > 0) step(1);
    else if (event.key === "ArrowUp" && expanded()) step(-1);
    else if (event.key === "Enter" && expanded() && current() >= 0) {
      options.pick(current());
      hide();
    } else if (event.key === "Escape" && expanded()) hide();
    else used = false;
    if (used) event.preventDefault();
    return used;
  };

  return {
    inputProps: () => ({
      role: "combobox",
      "aria-autocomplete": "list",
      "aria-expanded": expanded(),
      "aria-controls": expanded() ? listId : undefined,
      "aria-activedescendant": expanded() && current() >= 0 ? optionId(current()) : undefined,
      autocomplete: "off",
    }),
    onKeyDown,
    show,
    hide,
    expanded,
    active: current,
    listId,
    optionId,
  };
}

/** The suggestions under the input, in the page flow (as drawn in Add.dc.html). */
export function Suggestions<T>(props: {
  combobox: Combobox;
  label: string;
  items: readonly T[];
  pick: (index: number) => void;
  children: (item: T) => JSX.Element;
}) {
  const box = props.combobox;
  return (
    <Show when={box.expanded()}>
      <div id={box.listId} role="listbox" aria-label={props.label} class="suggestions">
        <For each={props.items}>
          {(item, i) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: keys stay with the input (aria-activedescendant)
            <div
              id={box.optionId(i())}
              role="option"
              class="suggestion"
              tabIndex={-1}
              aria-selected={box.active() === i()}
              // Keeps focus in the input, so picking never blurs (and closes) the list first.
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                props.pick(i());
                box.hide();
              }}
            >
              {props.children(item)}
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}

/** `text` with its first `length` characters in bold, the typed part of a suggestion. */
export function BoldPrefix(props: { text: string; length: number }) {
  return (
    <span class="suggestion-text">
      <b>{props.text.slice(0, props.length)}</b>
      {props.text.slice(props.length)}
    </span>
  );
}
