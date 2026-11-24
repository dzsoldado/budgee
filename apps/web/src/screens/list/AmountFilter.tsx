// The amount filter: more than, less than or equal to a typed amount. Its trigger and panel
// look and close like the other filter pickers (a popover on wide screens, a sheet on phones).
import { createSignal, createUniqueId, type JSX, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { placeUnder, usePanelDismiss } from "../../components/FilterPicker";
import { Segmented } from "../../components/Segmented";
import { type MessageKey, t } from "../../i18n";
import { type AmountCondition, type AmountOp, amountBound } from "../../list/filter";

const OPS: readonly { value: AmountOp; label: MessageKey; symbol: string }[] = [
  { value: "gt", label: "filter.amountGt", symbol: ">" },
  { value: "lt", label: "filter.amountLt", symbol: "<" },
  { value: "eq", label: "filter.amountEq", symbol: "=" },
];

/** "> 1,500": the condition as the trigger shows it, or null when it filters nothing. */
export function amountSummary(condition: AmountCondition): string | null {
  if (amountBound(condition) === null) return null;
  const symbol = OPS.find((op) => op.value === condition.op)?.symbol ?? "";
  return `${symbol} ${condition.text.trim()}`;
}

export function AmountFilter(props: {
  value: AmountCondition;
  onChange: (value: AmountCondition) => void;
  /** Main currency code, for the field's name. */
  currency: string;
  sheet: boolean;
  triggerClass: string;
  children: JSX.Element;
}) {
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
        aria-haspopup="dialog"
        aria-expanded={open()}
        aria-controls={open() ? `${id}-panel` : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        {props.children}
      </button>
      <Show when={open()}>
        <Portal>
          <AmountPanel {...props} id={id} trigger={trigger} close={close} />
        </Portal>
      </Show>
    </>
  );
}

function AmountPanel(props: {
  id: string;
  value: AmountCondition;
  onChange: (value: AmountCondition) => void;
  currency: string;
  sheet: boolean;
  trigger: HTMLButtonElement;
  close: (refocus: boolean) => void;
}) {
  let panel!: HTMLDivElement;
  let input!: HTMLInputElement;
  const invalid = () => props.value.text.trim() !== "" && amountBound(props.value) === null;

  const onFocusOut = usePanelDismiss({
    panel: () => panel,
    trigger: props.trigger,
    sheet: props.sheet,
    close: props.close,
  });

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" || (event.key === "Enter" && event.target === input)) {
      event.preventDefault();
      props.close(true);
      return;
    }
    // Tabbing out of either end closes the panel on the trigger, and the Tab then carries on
    // from there, as if the panel sat inline. Radios only count once: the group's checked one.
    if (event.key !== "Tab") return;
    const stops = [
      ...panel.querySelectorAll<HTMLElement>("button, input:not([type=radio]), input:checked"),
    ];
    const edge = event.shiftKey ? stops[0] : stops[stops.length - 1];
    if (event.target === edge) props.close(true);
  };

  onMount(() => {
    if (!props.sheet) placeUnder(panel, props.trigger);
    input.focus();
  });

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
        onKeyDown={onKeyDown}
      >
        <div class="picker-head">
          <h2 id={`${props.id}-title`} class="picker-title">
            {t("filter.amount")}
          </h2>
          <div class="picker-actions">
            <Show when={props.value.text !== ""}>
              <button
                type="button"
                class="btn picker-clear"
                onClick={() => {
                  props.onChange({ ...props.value, text: "" });
                  input.focus();
                }}
              >
                {t("filter.clear")}
              </button>
            </Show>
            <button type="button" class="btn picker-done" onClick={() => props.close(true)}>
              {t("filter.done")}
            </button>
          </div>
        </div>
        <div class="amount-filter">
          <Segmented
            label={t("filter.amountComparison")}
            options={OPS.map((op) => ({ value: op.value, label: t(op.label) }))}
            value={props.value.op}
            onChange={(op) => props.onChange({ ...props.value, op })}
          />
          <label class="visually-hidden" for={`${props.id}-amount`}>
            {t("entry.amount", { currency: props.currency })}
          </label>
          <input
            ref={input}
            id={`${props.id}-amount`}
            class="input num"
            inputmode="decimal"
            autocomplete="off"
            placeholder={t("filter.amountPlaceholder", { currency: props.currency })}
            value={props.value.text}
            onInput={(event) => props.onChange({ ...props.value, text: event.currentTarget.value })}
            aria-invalid={invalid() ? "true" : undefined}
            aria-describedby={invalid() ? `${props.id}-error` : undefined}
          />
          <Show when={invalid()}>
            <p id={`${props.id}-error`} class="field-error">
              {t("entry.errorAmountInvalid")}
            </p>
          </Show>
        </div>
      </div>
    </>
  );
}
