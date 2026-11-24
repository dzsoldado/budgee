// The dashboard-wide exclusions: a sheet (a centered dialog on wide screens) with category and
// tag chips. Each tap saves at once; Done or Escape closes and focus returns to
// the button that opened it.
import { type Exclusions, listTags, sameTag } from "@budgee/core";
import { createEffect, createMemo, createUniqueId, For, Show } from "solid-js";
import { useApp } from "../../context";
import { createLiveQuery } from "../../db/live";
import { t } from "../../i18n";
import { sortByOrder } from "../../list/categories";

type List = keyof Exclusions;

export function ExclusionsSheet(props: {
  open: boolean;
  exclude: Exclusions;
  onChange: (exclude: Exclusions) => void;
  onClose: () => void;
  error: boolean;
}) {
  const id = createUniqueId();
  const { db } = useApp();
  let dialog!: HTMLDialogElement;

  const categoryRows = createLiveQuery(() => db.categories.toArray());
  // Tags are read only while the sheet is open: they come from every entry.
  const transactions = createLiveQuery(
    () => props.open,
    (open) => (open ? db.transactions.toArray() : []),
  );

  /** Names in Settings order: live ones, plus archived ones still excluded. */
  const names = (rows: readonly { name: string; archived: boolean }[], list: List) =>
    rows.filter((r) => !r.archived || props.exclude[list].includes(r.name)).map((r) => r.name);
  const categories = createMemo(() => sortByOrder(categoryRows() ?? []));
  const expenseCategories = createMemo(() =>
    names(
      categories().filter((c) => c.type === "expense"),
      "categories",
    ),
  );
  const incomeCategories = createMemo(() =>
    names(
      categories().filter((c) => c.type === "income"),
      "categories",
    ),
  );
  const tags = createMemo(() => {
    const found = listTags(transactions() ?? []).map((c) => c.tag);
    // An excluded tag no entry carries any more still shows, so it can be let go.
    for (const tag of props.exclude.tags) if (!found.some((f) => sameTag(f, tag))) found.push(tag);
    return found.sort((a, b) => a.localeCompare(b));
  });

  const isOn = (list: List, name: string) =>
    list === "tags"
      ? props.exclude.tags.some((x) => sameTag(x, name))
      : props.exclude[list].includes(name);
  const toggle = (list: List, name: string) => {
    const same = list === "tags" ? sameTag : (a: string, b: string) => a === b;
    const current = props.exclude[list];
    props.onChange({
      ...props.exclude,
      [list]: isOn(list, name) ? current.filter((x) => !same(x, name)) : [...current, name],
    });
  };

  createEffect(() => {
    if (props.open && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLElement>(".sheet-done")?.focus();
    } else if (!props.open && dialog.open) dialog.close();
  });

  const group = (title: string, list: List, options: () => string[], empty?: string) => (
    <fieldset class="sheet-group">
      <legend class="sheet-group-title">{title}</legend>
      <Show when={options().length > 0} fallback={<p class="hint">{empty}</p>}>
        <div class="sheet-chips">
          <For each={options()}>
            {(name) => (
              <button
                type="button"
                class="chip"
                aria-pressed={isOn(list, name)}
                onClick={() => toggle(list, name)}
              >
                {name}
              </button>
            )}
          </For>
        </div>
      </Show>
    </fieldset>
  );

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the backdrop tap's key twin is Escape (onCancel)
    <dialog
      ref={dialog}
      class="sheet"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-hint`}
      onCancel={(event) => {
        event.preventDefault();
        props.onClose();
      }}
      onClick={(event) => {
        // A tap on the backdrop (outside the sheet's box) closes it.
        if (event.target === dialog) props.onClose();
      }}
    >
      <div class="sheet-head">
        <h2 class="sheet-title" id={`${id}-title`}>
          {t("dashboard.excludeTitle")}
        </h2>
        <button type="button" class="btn picker-done sheet-done" onClick={() => props.onClose()}>
          {t("dashboard.done")}
        </button>
      </div>
      <div class="sheet-body">
        <p class="hint" id={`${id}-hint`}>
          {t("dashboard.excludeHint")}
        </p>
        <Show when={props.error}>
          <p class="sheet-error" role="alert">
            {t("dashboard.excludeError")}
          </p>
        </Show>
        {group(t("dashboard.excludeExpenses"), "categories", expenseCategories)}
        <Show when={incomeCategories().length > 0}>
          {group(t("dashboard.excludeIncome"), "categories", incomeCategories)}
        </Show>
        {group(t("dashboard.excludeTags"), "tags", tags, t("dashboard.noTags"))}
      </div>
    </dialog>
  );
}
