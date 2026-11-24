// One row of the import preview: its file line, what it reads as, and what is wrong with it.
import { type ColumnMapping, type CsvColumn, formatAmount, type ImportRow } from "@budgee/core";
import { For, Show } from "solid-js";
import { useApp } from "../../../context";
import { t } from "../../../i18n";
import { issueText, type LoadedFile } from "./common";

export function PreviewRow(props: { row: ImportRow; file: LoadedFile; mapping: ColumnMapping }) {
  const { settings } = useApp();
  const cell = (field: CsvColumn) => {
    const at = props.mapping[field];
    return at === undefined ? "" : (props.file.rows[props.row.index]?.[at]?.trim() ?? "");
  };
  const line = () => props.file.lines[props.row.index] ?? props.row.index + 2;
  const ok = () => (props.row.ok ? props.row : undefined);
  const title = () => ok()?.fields.category ?? (cell("category") || "—");
  // As the file wrote it: its own decimals, not the main currency's rounding (9.99 stays 9.99).
  const amount = () => {
    const fields = ok()?.fields;
    if (!fields) return cell("amount");
    return formatAmount(fields.type === "income" ? fields.amount : -fields.amount, {
      locale: settings().locale,
      decimals: fields.amount % 100 === 0 ? 0 : 2,
      sign: "always",
    });
  };
  const meta = () =>
    [ok()?.fields.date ?? cell("date"), ok()?.fields.detail ?? cell("detail")]
      .filter(Boolean)
      .join(" · ");

  return (
    <li
      class="import-row"
      classList={{
        "import-row-error": !props.row.ok,
        "import-row-warning": !!ok()?.duplicate,
      }}
    >
      <div class="import-row-head">
        <span class="import-line">{t("import.line", { line: line() })}</span>
        <Show when={!props.row.ok}>
          <span class="import-badge import-badge-error">{t("import.badgeError")}</span>
        </Show>
        <Show when={ok()?.duplicate}>
          <span class="import-badge">{t("import.badgeDuplicate")}</span>
        </Show>
      </div>
      <div class="import-row-main">
        <span class="import-row-title">{title()}</span>
        <span
          class="import-row-amount"
          classList={{ "amount-income": ok()?.fields.type === "income" }}
        >
          {amount()}
        </span>
      </div>
      <Show when={meta()}>
        <span class="import-row-meta">{meta()}</span>
      </Show>
      <Show when={!props.row.ok}>
        <ul class="import-issues">
          <For each={props.row.ok ? [] : props.row.errors}>
            {(issue) => <li>{issueText(issue, cell(issue.field))}</li>}
          </For>
        </ul>
      </Show>
    </li>
  );
}
