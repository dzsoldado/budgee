// Settings → Categories, grouped by type.
import { createMemo, For, Show } from "solid-js";
import { useApp } from "../../context";
import { createLiveQuery } from "../../db/live";
import { type MessageKey, t } from "../../i18n";
import { categoriesOfType, type EntryType, type ListItem } from "../../settings/lists";
import { Screen } from "../../shell/Screen";
import { createAnnouncer, createLiveEntries, settingsBack } from "./common";
import { ListManager } from "./ListManager";

const TYPES: readonly { type: EntryType; title: MessageKey; label: MessageKey; add: MessageKey }[] =
  [
    {
      type: "expense",
      title: "lists.expenses",
      label: "lists.expenseCategories",
      add: "lists.newExpenseCategory",
    },
    {
      type: "income",
      title: "lists.income",
      label: "lists.incomeCategories",
      add: "lists.newIncomeCategory",
    },
  ];

export function CategoriesScreen() {
  const { db } = useApp();
  const rows = createLiveQuery(() => db.categories.toArray());
  const entries = createLiveEntries(db);
  const { region, announce } = createAnnouncer();
  return (
    <Screen title={t("settings.categories")} back={settingsBack()} class="settings">
      <p class="settings-intro">{t("lists.categoriesIntro")}</p>
      <Show when={rows()}>
        {(all) => (
          <For each={TYPES}>
            {(group) => {
              const items = createMemo(() => categoriesOfType(all(), group.type) as ListItem[]);
              return (
                <section class="section">
                  <h2 class="section-title">{t(group.title)}</h2>
                  <ListManager
                    type={group.type}
                    rows={items()}
                    entries={entries()}
                    label={t(group.label)}
                    addLabel="lists.addCategory"
                    addTitle={group.add}
                    announce={announce}
                  />
                </section>
              );
            }}
          </For>
        )}
      </Show>
      {region}
    </Screen>
  );
}
