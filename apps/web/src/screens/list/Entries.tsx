// The month's entries: day groups of rows on phones, one table on wide screens. Every row is
// a link to its edit screen.
import type { LiveTransaction } from "@budgee/core";
import { useHref } from "@solidjs/router";
import { createMemo, createUniqueId, For, Show } from "solid-js";
import { useApp } from "../../context";
import { t } from "../../i18n";
import { todayIso } from "../../lib/date";
import { dayLabel, groupByDay, shortDate, signedAmount, sortNewestFirst } from "../../list/group";

interface EntriesProps {
  entries: readonly LiveTransaction[];
}

function useEntryFormat() {
  const { format } = useApp();
  return {
    amount: (e: LiveTransaction) => format.money(signedAmount(e), { sign: "always" }),
    original: (e: LiveTransaction) =>
      e.original_amount !== null && e.original_currency !== null
        ? format.original(e.original_amount, e.original_currency)
        : "",
  };
}

export function DayList(props: EntriesProps) {
  const { settings, format } = useApp();
  const days = createMemo(() => groupByDay(props.entries));
  const today = todayIso();
  return (
    <div class="days">
      <For each={days()}>
        {(day) => {
          const headingId = createUniqueId();
          return (
            <section class="day" aria-labelledby={headingId}>
              <div class="day-head">
                <h2 id={headingId} class="day-label">
                  {dayLabel(day.date, today, settings().locale)}
                </h2>
                <span class="day-net">{format.money(day.net, { sign: "always" })}</span>
              </div>
              <ul class="day-entries">
                <For each={day.entries}>
                  {(entry) => (
                    <li>
                      <EntryRow entry={entry} />
                    </li>
                  )}
                </For>
              </ul>
            </section>
          );
        }}
      </For>
    </div>
  );
}

function EntryRow(props: { entry: LiveTransaction }) {
  const fmt = useEntryFormat();
  const href = useHref(() => `/edit/${props.entry.id}`);
  const income = () => props.entry.type === "income";
  // The detail, or the note when there is no detail.
  const secondary = () => props.entry.detail || props.entry.note;
  return (
    <a class="entry" href={href()}>
      <span class="entry-avatar" classList={{ "entry-avatar-income": income() }} aria-hidden="true">
        {Array.from(props.entry.category)[0]}
      </span>
      <span class="entry-main">
        <span class="entry-title">{props.entry.category}</span>
        <Show when={secondary()}>
          <span class="entry-detail">{secondary()}</span>
        </Show>
      </span>
      <span class="entry-amounts">
        <span class="entry-amount" classList={{ "amount-income": income() }}>
          {fmt.amount(props.entry)}
        </span>
        <Show when={fmt.original(props.entry)}>
          {(original) => <span class="entry-original">{original()}</span>}
        </Show>
      </span>
    </a>
  );
}

export function EntryTable(props: EntriesProps) {
  const { settings } = useApp();
  const rows = createMemo(() => sortNewestFirst(props.entries));
  return (
    <div class="entry-table-wrap">
      <table class="entry-table">
        <thead>
          <tr>
            <th scope="col">{t("list.colDate")}</th>
            <th scope="col">{t("list.colCategory")}</th>
            <th scope="col">{t("list.colDetail")}</th>
            <th scope="col">{t("list.colNote")}</th>
            <th scope="col" class="col-end">
              {t("list.colOriginal")}
            </th>
            <th scope="col" class="col-end">
              {t("list.colAmount", { currency: settings().currency })}
            </th>
          </tr>
        </thead>
        <tbody>
          <For each={rows()}>{(entry) => <EntryTableRow entry={entry} />}</For>
        </tbody>
      </table>
    </div>
  );
}

function EntryTableRow(props: { entry: LiveTransaction }) {
  const { settings } = useApp();
  const fmt = useEntryFormat();
  const href = useHref(() => `/edit/${props.entry.id}`);
  return (
    <tr>
      <td class="cell-date">{shortDate(props.entry.date, settings().locale)}</td>
      <td class="cell-category">
        {/* Stretched over the row, so the whole row opens the entry. */}
        <a class="row-link" href={href()}>
          {props.entry.category}
        </a>
      </td>
      <td class="cell-wrap">{props.entry.detail || t("list.none")}</td>
      <td class="cell-muted cell-wrap">{props.entry.note}</td>
      <td class="cell-original">{fmt.original(props.entry)}</td>
      <td class="cell-amount" classList={{ "amount-income": props.entry.type === "income" }}>
        {fmt.amount(props.entry)}
      </td>
    </tr>
  );
}
