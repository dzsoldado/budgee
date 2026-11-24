// A segmented control: native radios (arrow keys move the choice), drawn as in the mockups.
import { createUniqueId, For } from "solid-js";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Extra class on the segment, e.g. `segment-expense` for its checked color. */
  class?: string;
}

export function Segmented<T extends string>(props: {
  /** Accessible name of the group. */
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** `wide`: full-width two-way toggle (Expense / Income). */
  wide?: boolean;
  /** Extra class on the group, e.g. `segmented-decimals`. */
  class?: string;
  disabled?: boolean;
}) {
  const name = createUniqueId();
  return (
    <div
      class={["segmented", props.wide ? "segmented-wide" : "", props.class ?? ""]
        .filter(Boolean)
        .join(" ")}
      role="radiogroup"
      aria-label={props.label}
    >
      <For each={props.options}>
        {(option) => (
          <label class={option.class}>
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={props.value === option.value}
              disabled={props.disabled}
              onChange={() => props.onChange(option.value)}
            />
            {option.label}
          </label>
        )}
      </For>
    </div>
  );
}
