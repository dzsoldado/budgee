// The Add / edit form's fields, drawn as in Add.dc.html. Each reads the form and reports
// changes through `patch`; errors appear under their field after a save attempt.
import { CURRENCIES, currencyName, type TagCount } from "@budgee/core";
import { type Accessor, createMemo, createUniqueId, For, Show } from "solid-js";
import { BoldPrefix, createCombobox, Suggestions } from "../../components/combobox";
import type { EntryField, EntryForm, FieldError } from "../../entry/form";
import type { DetailSuggestion } from "../../entry/suggest";
import { t } from "../../i18n";
import { CalendarIcon, CloseIcon, TagIcon } from "../../shell/icons";

export interface FieldProps {
  form: Accessor<EntryForm>;
  patch: (changes: Partial<EntryForm>) => void;
  error: (field: EntryField) => FieldError | undefined;
}

/** The message under a field; `id` is what the field's aria-describedby points at. */
export function ErrorText(props: { id: string; error: FieldError | undefined }) {
  return (
    <Show when={props.error}>
      {(error) => (
        <p id={props.id} class="field-error">
          {t(error().key, error().params)}
        </p>
      )}
    </Show>
  );
}

/** aria-invalid and aria-describedby for a field with `error`. */
const invalid = (error: FieldError | undefined, id: string) => ({
  "aria-invalid": error ? ("true" as const) : undefined,
  "aria-describedby": error ? id : undefined,
});

export function AmountField(
  props: FieldProps & { currency: string; onType: () => void; onLeave: () => void },
) {
  const id = createUniqueId();
  const error = () => props.error("amount");
  return (
    <div class="editor-amount">
      <label for={id} class="editor-amount-label">
        {t("entry.amount", { currency: props.currency })}
      </label>
      <input
        id={id}
        class="editor-amount-input"
        inputmode="decimal"
        autocomplete="off"
        placeholder={t("entry.amountPlaceholder")}
        value={props.form().amount}
        onInput={(event) => {
          props.patch({ amount: event.currentTarget.value });
          props.onType();
        }}
        onBlur={() => props.onLeave()}
        {...invalid(error(), `${id}-error`)}
      />
      <ErrorText id={`${id}-error`} error={error()} />
    </div>
  );
}

export function ForeignFields(
  props: FieldProps & {
    /** Currencies paid in before, most recent first. */
    recents: readonly string[];
    /** The chosen code: always offered, even when neither list has it (the main currency). */
    current: string;
    mainCurrency: string;
    locale: string;
    hint: string | null;
    onOriginalChange: () => void;
  },
) {
  const id = createUniqueId();
  const amountError = () => props.error("originalAmount");
  const currencyError = () => props.error("originalCurrency");
  const label = (code: string) =>
    t("entry.currencyOption", { code, name: currencyName(code, props.locale) });
  const others = createMemo(() =>
    CURRENCIES.filter((code) => code !== props.mainCurrency && !props.recents.includes(code)),
  );
  /** An entry's own code that neither list offers (the main currency, a withdrawn code). */
  const unlisted = () =>
    props.current !== "" &&
    !props.recents.includes(props.current) &&
    !others().includes(props.current);
  const option = (code: string) => (
    <option value={code} selected={props.form().originalCurrency === code}>
      {label(code)}
    </option>
  );

  return (
    <section class="foreign" aria-label={t("entry.foreignSection")}>
      <div class="foreign-head">
        <span id={`${id}-switch`} class="foreign-title">
          {t("entry.foreign")}
        </span>
        <button
          type="button"
          class="switch"
          role="switch"
          aria-checked={props.form().foreign}
          aria-labelledby={`${id}-switch`}
          onClick={() => {
            const on = !props.form().foreign;
            // Off clears the pair; on starts from the most recent currency.
            props.patch({
              foreign: on,
              originalAmount: "",
              originalCurrency: on ? (props.recents[0] ?? "") : "",
            });
            props.onOriginalChange();
          }}
        />
      </div>
      <Show when={props.form().foreign}>
        <div class="foreign-grid">
          <div class="field">
            <label for={`${id}-amount`} class="field-label">
              {t("entry.originalAmount")}
            </label>
            <input
              id={`${id}-amount`}
              class="input input-sunk num"
              inputmode="decimal"
              autocomplete="off"
              value={props.form().originalAmount}
              onInput={(event) => {
                props.patch({ originalAmount: event.currentTarget.value });
                props.onOriginalChange();
              }}
              {...invalid(amountError(), `${id}-amount-error`)}
            />
            <ErrorText id={`${id}-amount-error`} error={amountError()} />
          </div>
          <div class="field">
            <label for={`${id}-currency`} class="field-label">
              {t("entry.originalCurrency")}
            </label>
            <select
              id={`${id}-currency`}
              class="input input-sunk select"
              onChange={(event) => {
                props.patch({ originalCurrency: event.currentTarget.value });
                props.onOriginalChange();
              }}
              {...invalid(currencyError(), `${id}-currency-error`)}
            >
              <Show when={props.form().originalCurrency === ""}>
                <option value="" disabled selected>
                  {t("entry.chooseCurrency")}
                </option>
              </Show>
              <Show when={unlisted()}>{option(props.current)}</Show>
              <Show when={props.recents.length > 0}>
                <optgroup label={t("entry.recentCurrencies")}>
                  <For each={props.recents}>{option}</For>
                </optgroup>
              </Show>
              <optgroup label={t("entry.allCurrencies")}>
                <For each={others()}>{option}</For>
              </optgroup>
            </select>
            <ErrorText id={`${id}-currency-error`} error={currencyError()} />
          </div>
        </div>
        <Show when={props.hint}>
          <p class="hint" aria-live="polite">
            {props.hint}
          </p>
        </Show>
      </Show>
    </section>
  );
}

export function DateField(props: FieldProps) {
  const id = createUniqueId();
  const error = () => props.error("date");
  let input!: HTMLInputElement;
  return (
    <div class="field">
      <label for={id} class="field-label">
        {t("entry.date")}
      </label>
      <span class="date-box">
        <CalendarIcon size={18} />
        <input
          ref={input}
          id={id}
          type="date"
          class="date-input"
          required
          value={props.form().date}
          onInput={(event) => props.patch({ date: event.currentTarget.value })}
          // The native picker icon is hidden (the drawn one sits at the start), so a click
          // anywhere opens the picker.
          onClick={() => {
            try {
              input.showPicker();
            } catch {
              // Not allowed here (or not supported): typing the date still works.
            }
          }}
          {...invalid(error(), `${id}-error`)}
        />
      </span>
      <ErrorText id={`${id}-error`} error={error()} />
    </div>
  );
}

/** Single-choice chips (the category). */
export function ChoiceField(props: {
  legend: string;
  options: readonly string[];
  selected: string;
  onSelect: (name: string) => void;
  error: FieldError | undefined;
}) {
  const id = createUniqueId();
  return (
    <fieldset
      class="choice-group"
      aria-describedby={props.error ? `${id}-error` : undefined}
      data-invalid={props.error ? "" : undefined}
    >
      <legend class="field-label choice-legend">{props.legend}</legend>
      <div class="choice-row">
        <For each={props.options}>
          {(name) => (
            <button
              type="button"
              class="choice-chip"
              aria-pressed={props.selected === name}
              onClick={() => props.onSelect(name)}
            >
              {name}
            </button>
          )}
        </For>
      </div>
      <ErrorText id={`${id}-error`} error={props.error} />
    </fieldset>
  );
}

export function DetailField(
  props: FieldProps & { suggest: (typed: string) => DetailSuggestion[] },
) {
  const id = createUniqueId();
  const items = createMemo(() => props.suggest(props.form().detail));
  const pick = (index: number) => {
    const item = items()[index];
    if (item) props.patch({ detail: item.detail });
  };
  const combo = createCombobox({ count: () => items().length, pick });
  const typed = () => props.form().detail.trim().length;
  return (
    <div class="field">
      <label for={id} class="field-label">
        {t("entry.detail")}
      </label>
      <input
        id={id}
        type="text"
        class="input"
        {...combo.inputProps()}
        value={props.form().detail}
        onInput={(event) => {
          props.patch({ detail: event.currentTarget.value });
          combo.show();
        }}
        onKeyDown={(event) => combo.onKeyDown(event)}
        onBlur={() => combo.hide()}
      />
      <Suggestions combobox={combo} label={t("entry.pastDetails")} items={items()} pick={pick}>
        {(item) => (
          <>
            <BoldPrefix text={item.detail} length={typed()} />
            <span class="suggestion-meta">{t("entry.used", { count: item.count })}</span>
          </>
        )}
      </Suggestions>
    </div>
  );
}

export function TagsField(
  props: FieldProps & {
    suggest: (typed: string) => TagCount[];
    /** Adds `text` as a tag; false when it cannot be one (it contains ";"). */
    add: (text: string) => boolean;
  },
) {
  const id = createUniqueId();
  const error = () =>
    props.form().tagDraft.includes(";")
      ? ({ key: "entry.errorTagSemicolon" } as const)
      : props.error("tags");
  const items = createMemo(() => props.suggest(props.form().tagDraft));
  let input!: HTMLInputElement;

  const addDraft = (text: string) => {
    if (text.trim() === "") return;
    if (props.add(text)) props.patch({ tagDraft: "" });
  };
  const pick = (index: number) => {
    const item = items()[index];
    if (item) addDraft(item.tag);
  };
  const combo = createCombobox({ count: () => items().length, pick });
  const remove = (tag: string) => {
    props.patch({ tags: props.form().tags.filter((x) => x !== tag) });
    input.focus();
  };

  return (
    <div class="field">
      <label for={id} class="field-label">
        {t("entry.tags")} <span class="field-note">{t("entry.tagsNote")}</span>
      </label>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a click on the box's padding focuses its input */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the input inside handles the keys */}
      <div
        class="tag-box"
        classList={{ "tag-box-invalid": !!error() }}
        onClick={(event) => {
          if (event.target === event.currentTarget) input.focus();
        }}
      >
        <For each={props.form().tags}>
          {(tag) => (
            <span class="tag-chip">
              <TagIcon size={12} />
              {tag}
              <button
                type="button"
                class="tag-remove"
                aria-label={t("entry.removeTag", { tag })}
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
          placeholder={t("entry.tagPlaceholder")}
          {...combo.inputProps()}
          value={props.form().tagDraft}
          {...invalid(error(), `${id}-error`)}
          onInput={(event) => {
            // A comma ends a tag (phone keyboards send no usable key for it).
            const parts = event.currentTarget.value.split(",");
            const draft = parts.pop() ?? "";
            const blocked = parts.some((part) => part.trim() !== "" && !props.add(part));
            props.patch({ tagDraft: blocked ? event.currentTarget.value : draft });
            event.currentTarget.value = blocked ? event.currentTarget.value : draft;
            combo.show();
          }}
          onKeyDown={(event) => {
            if (combo.onKeyDown(event)) return;
            const draft = props.form().tagDraft;
            if (event.key === "Enter" && draft.trim() !== "") {
              event.preventDefault();
              addDraft(draft);
            } else if (event.key === "Backspace" && draft === "" && props.form().tags.length) {
              props.patch({ tags: props.form().tags.slice(0, -1) });
            }
          }}
          onBlur={() => combo.hide()}
        />
      </div>
      <Suggestions combobox={combo} label={t("entry.tagsInUse")} items={items()} pick={pick}>
        {(item) => (
          <>
            <BoldPrefix text={item.tag} length={props.form().tagDraft.trim().length} />
            <span class="suggestion-meta">{t("entry.used", { count: item.count })}</span>
          </>
        )}
      </Suggestions>
      <p id={`${id}-error`} class="field-error" aria-live="polite">
        {error() ? t(error()?.key ?? "entry.errorTagSemicolon") : ""}
      </p>
    </div>
  );
}
