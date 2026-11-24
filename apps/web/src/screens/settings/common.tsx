// Shared by the Settings screens.
import type { LiveTransaction } from "@budgee/core";
import { createSignal } from "solid-js";
import type { BudgeeDb } from "../../db/db";
import { createLiveQuery } from "../../db/live";
import { t } from "../../i18n";

/** "1 entry", "12 entries". */
export function entriesText(count: number): string {
  return count === 1 ? t("lists.entriesOne") : t("lists.entriesMany", { count });
}

/** Every live entry, updated live; undefined while loading. */
export function createLiveEntries(db: BudgeeDb) {
  return createLiveQuery(() =>
    db.transactions
      .toArray()
      .then((rows) => rows.filter((row): row is typeof row & LiveTransaction => !row.deleted)),
  );
}

/** The back link of a Settings sub-screen. */
export const settingsBack = () => ({ href: "/settings", label: t("settings.back") });

/** A visually hidden status line that announces finished changes. */
export function createAnnouncer() {
  const [status, setStatus] = createSignal("");
  const region = (
    <p class="visually-hidden" role="status">
      {status()}
    </p>
  );
  return { region, announce: setStatus };
}
