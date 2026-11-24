// Search and filters. Phones: type chips and Category, Tag and Amount pickers (Main.dc.html).
// Wide screens: a Type segmented control and the same pickers (Desktop.dc.html).
import { type LiveCategory, type LiveTransaction, listTags, sameTag } from "@budgee/core";
import { createMemo, For, type JSX, Show } from "solid-js";
import { FilterPicker, type PickerGroup } from "../../components/FilterPicker";
import { Segmented } from "../../components/Segmented";
import { useApp } from "../../context";
import { type MessageKey, t } from "../../i18n";
import { type ListFilter, type TypeFilter, withType } from "../../list/filter";
import { listFilter, updateListFilter } from "../../list/store";
import { ChevronDownIcon, CloseIcon, SearchIcon } from "../../shell/icons";
import { AmountFilter, amountSummary } from "./AmountFilter";

const TYPES: readonly { value: TypeFilter; label: MessageKey }[] = [
  { value: "all", label: "list.all" },
  { value: "income", label: "list.income" },
  { value: "expense", label: "list.expenses" },
];

type PickerKey = "categories" | "tags";

export function Filters(props: {
  wide: boolean;
  /** In Settings order. */
  categories: readonly LiveCategory[];
  /** The month's entries, for the tags in use. */
  monthEntries: readonly LiveTransaction[];
}) {
  const { settings } = useApp();
  const filter = listFilter;
  /** Archived names drop out of the choices unless chosen already. */
  const offered = (
    rows: readonly { name: string; archived: boolean }[],
    chosen: readonly string[],
  ) => rows.filter((r) => !r.archived || chosen.includes(r.name)).map((r) => r.name);

  const categoryGroups = createMemo((): PickerGroup[] => {
    const type = filter().type;
    const of = (kind: "income" | "expense") =>
      offered(
        props.categories.filter((c) => c.type === kind),
        filter().categories,
      );
    const groups: PickerGroup[] =
      type !== "all"
        ? [{ options: of(type) }]
        : [
            { label: t("list.expenses"), options: of("expense") },
            { label: t("list.income"), options: of("income") },
          ];
    return groups.filter((group) => group.options.length > 0);
  });
  const setType = (type: TypeFilter) =>
    updateListFilter(withType(filter(), type, props.categories));
  const tagOptions = createMemo(() => {
    const inUse = listTags(props.monthEntries).map((c) => c.tag);
    const chosenElsewhere = filter().tags.filter((tag) => !inUse.some((u) => sameTag(u, tag)));
    return [...inUse, ...chosenElsewhere];
  });

  const picker = (key: PickerKey, label: MessageKey, groups: () => readonly PickerGroup[]) => {
    const chosen = () => filter()[key];
    const name = t(label);
    const summary = (): string => {
      const values = chosen();
      if (props.wide) {
        if (values.length === 0) return t("filter.summaryAny", { label: name });
        if (values.length === 1)
          return t("filter.summaryOne", { label: name, value: values[0] ?? "" });
        return t("filter.summaryMany", { label: name, count: values.length });
      }
      if (values.length === 0) return name;
      if (values.length === 1) return values[0] ?? name;
      return t("filter.chipMany", { label: name, count: values.length });
    };
    return (
      <FilterPicker
        label={name}
        groups={groups()}
        selected={chosen()}
        onChange={(values) => updateListFilter({ [key]: values } as Partial<ListFilter>)}
        same={key === "tags" ? sameTag : undefined}
        emptyText={key === "tags" ? t("filter.noTags") : undefined}
        sheet={!props.wide}
        triggerClass={`${props.wide ? "filter-button" : "filter-chip filter-chip-menu"}${
          chosen().length > 0 ? " filter-active" : ""
        }`}
      >
        {summary()}
        <Show when={!props.wide}>
          <ChevronDownIcon size={14} />
        </Show>
      </FilterPicker>
    );
  };

  const amount = () => {
    const name = t("filter.amount");
    const summary = () => {
      const condition = amountSummary(filter().amount);
      if (props.wide) {
        return condition === null
          ? t("filter.summaryAny", { label: name })
          : t("filter.summaryOne", { label: name, value: condition });
      }
      return condition ?? name;
    };
    return (
      <AmountFilter
        value={filter().amount}
        onChange={(value) => updateListFilter({ amount: value })}
        currency={settings().currency}
        sheet={!props.wide}
        triggerClass={`${props.wide ? "filter-button" : "filter-chip filter-chip-menu"}${
          amountSummary(filter().amount) !== null ? " filter-active" : ""
        }`}
      >
        {summary()}
        <Show when={!props.wide}>
          <ChevronDownIcon size={14} />
        </Show>
      </AmountFilter>
    );
  };

  const search = (): JSX.Element => {
    let input!: HTMLInputElement;
    return (
      <div class="search">
        <label class="search-field">
          <SearchIcon size={props.wide ? 16 : 18} />
          <input
            ref={input}
            type="search"
            aria-label={t("list.search")}
            placeholder={t("list.searchPlaceholder")}
            value={filter().search}
            onInput={(event) => updateListFilter({ search: event.currentTarget.value })}
          />
        </label>
        <Show when={filter().search !== ""}>
          <button
            type="button"
            class="search-clear"
            aria-label={t("list.clearSearch")}
            onClick={() => {
              updateListFilter({ search: "" });
              input.focus();
            }}
          >
            <CloseIcon size={16} />
          </button>
        </Show>
      </div>
    );
  };

  return (
    <Show
      when={props.wide}
      fallback={
        <div class="list-filters">
          {search()}
          <div class="chip-row">
            <For each={TYPES}>
              {(type) => (
                <button
                  type="button"
                  class="filter-chip"
                  aria-pressed={filter().type === type.value}
                  onClick={() => setType(type.value)}
                >
                  {t(type.label)}
                </button>
              )}
            </For>
            {picker("categories", "filter.category", categoryGroups)}
            {picker("tags", "filter.tag", () => [{ options: tagOptions() }])}
            {amount()}
          </div>
        </div>
      }
    >
      <div class="list-filters">
        {search()}
        <Segmented
          label={t("list.type")}
          options={TYPES.map((type) => ({ value: type.value, label: t(type.label) }))}
          value={filter().type}
          onChange={setType}
        />
        {picker("categories", "filter.category", categoryGroups)}
        {picker("tags", "filter.tag", () => [{ options: tagOptions() }])}
        {amount()}
      </div>
    </Show>
  );
}
