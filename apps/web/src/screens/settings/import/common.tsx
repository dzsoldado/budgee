// Shared by the import wizard's steps: field names, problem texts and the step heading.
import type { CsvColumn, ImportContext, ImportIssue } from "@budgee/core";
import { type JSX, Show } from "solid-js";
import type { CsvFile } from "../../../csv/import";
import { type MessageKey, t } from "../../../i18n";

/** The file read in step 1, with what its rows are checked against. */
export interface LoadedFile extends CsvFile {
  name: string;
  context: ImportContext;
}

export const FIELD_LABEL: Record<CsvColumn, MessageKey> = {
  date: "import.field.date",
  type: "import.field.type",
  amount: "import.field.amount",
  category: "import.field.category",
  detail: "import.field.detail",
  note: "import.field.note",
  tags: "import.field.tags",
  original_amount: "import.field.originalAmount",
  original_currency: "import.field.originalCurrency",
  id: "import.field.id",
  hlc: "import.field.hlc",
};

/** What is wrong with a cell, in words; only a category clash names the cell (`value`). */
export function issueText(issue: ImportIssue, value: string): string {
  const field = t(FIELD_LABEL[issue.field]);
  switch (issue.code) {
    case "required":
      return t("import.issue.required", { field });
    case "pair":
      if (issue.field === "hlc") return t("import.issue.idWithoutHlc");
      if (issue.field === "id") return t("import.issue.hlcWithoutId");
      return t("import.issue.pairOriginal");
    case "unknown_currency":
      return t("import.issue.currency");
    case "income_category":
      return t("import.issue.incomeCategory", { name: value });
    case "expense_category":
      return t("import.issue.expenseCategory", { name: value });
    case "invalid":
      if (issue.field === "date") return t("import.issue.date");
      if (issue.field === "type") return t("import.issue.type");
      if (issue.field === "id") return t("import.issue.id");
      if (issue.field === "hlc") return t("import.issue.hlc");
      return t("import.issue.amount", { field });
  }
}

/** Only one of the original amount and currency: often a column matched by mistake. */
export const isOriginalPair = (issue: ImportIssue) =>
  issue.code === "pair" &&
  (issue.field === "original_amount" || issue.field === "original_currency");

/** "Step N of 4" (left out on the done step) and the step's title, focused on arrival. */
export function StepHead(props: {
  step: number | undefined;
  title: string;
  heading: (el: HTMLHeadingElement) => void;
  children?: JSX.Element;
}) {
  return (
    <div class="import-head">
      <Show when={props.step}>
        {(step) => <p class="import-step">{t("import.stepOf", { step: step() })}</p>}
      </Show>
      <h2 class="pair-title" tabindex="-1" ref={props.heading}>
        {props.title}
      </h2>
      {props.children}
    </div>
  );
}

/** "file.csv · 12 rows". */
export function fileRowsText(name: string, rows: number, number: Intl.NumberFormat): string {
  return rows === 1
    ? t("import.fileRowsOne", { name })
    : t("import.fileRowsMany", { name, count: number.format(rows) });
}
