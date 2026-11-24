// The List's month and filter, kept for the session (not across reloads) so they survive a
// trip to the edit screen. Other modules (CSV export of "the current filter") read them here.
import { createSignal } from "solid-js";
import { todayIso } from "../lib/date";
import { EMPTY_FILTER, type ListFilter } from "./filter";
import { monthOf } from "./month";

const [listMonth, setListMonth] = createSignal(monthOf(todayIso()));
const [listFilter, setListFilter] = createSignal<ListFilter>(EMPTY_FILTER);

export { listFilter, listMonth, setListMonth };

export function updateListFilter(patch: Partial<ListFilter>): void {
  setListFilter((current) => ({ ...current, ...patch }));
}

export function clearListFilter(): void {
  setListFilter(EMPTY_FILTER);
}
