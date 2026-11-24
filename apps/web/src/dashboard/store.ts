// The month the Dashboard is on (`YYYY-MM`; the year view shows its year), kept for the session
// like the List's month. Month or year, the comparison and the exclusions are settings.
import { createSignal } from "solid-js";
import { todayIso } from "../lib/date";
import { monthOf } from "../list/month";

const [dashboardMonth, setDashboardMonth] = createSignal(monthOf(todayIso()));

export { dashboardMonth, setDashboardMonth };
