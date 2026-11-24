// Import step 2: match the file's columns to fields. Only the cheap check (required fields with
// no column) runs here; the rows are checked when the user continues.
import { type ColumnMapping, type CsvColumn, FULL_COLUMNS } from "@budgee/core";
import { createMemo, createSignal, createUniqueId, For, Show } from "solid-js";
import { missingColumns } from "../../../csv/import";
import { type MessageKey, t } from "../../../i18n";
import { FIELD_LABEL, fileRowsText, type LoadedFile, StepHead } from "./common";

const NEED: Partial<Record<CsvColumn, MessageKey>> = {
  date: "import.required",
  type: "import.required",
  amount: "import.required",
  category: "import.required",
  id: "import.fullOnly",
  hlc: "import.fullOnly",
};

export function ColumnsStep(props: {
  file: LoadedFile;
  mapping: ColumnMapping;
  onMapping: (mapping: ColumnMapping) => void;
  number: Intl.NumberFormat;
  /** The rows are being checked ("Checking…"). */
  checking: boolean;
  /** Checking the rows failed. */
  error: string | undefined;
  onBack: () => void;
  onContinue: () => void;
  heading: (el: HTMLHeadingElement) => void;
}) {
  const id = createUniqueId();
  const [showMissing, setShowMissing] = createSignal(false);
  const missing = createMemo(() => missingColumns(props.mapping));
  const selectId = (field: CsvColumn) => `${id}-col-${field}`;
  const firstRow = createMemo(() =>
    props.file.rows.find((row) => row.some((cell) => cell.trim() !== "")),
  );
  const sample = (field: CsvColumn) => {
    const at = props.mapping[field];
    if (at === undefined) return undefined;
    const value = firstRow()?.[at]?.trim() ?? "";
    return value === "" ? t("import.sampleEmpty") : t("import.sample", { value });
  };
  const summary = () =>
    showMissing() && missing().length > 0
      ? t("import.missingSummary", {
          fields: missing()
            .map((field) => t(FIELD_LABEL[field]))
            .join(", "),
        })
      : undefined;

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (props.checking) return;
    const first = missing()[0];
    if (first) {
      setShowMissing(true);
      document.getElementById(selectId(first))?.focus();
      return;
    }
    props.onContinue();
  };

  return (
    <form class="card stack" onSubmit={submit} novalidate>
      <StepHead step={2} title={t("import.columnsTitle")} heading={props.heading}>
        <p class="pair-text">{t("import.columnsIntro")}</p>
        <p class="hint">
          {fileRowsText(
            props.file.name,
            props.file.rows.filter((row) => row.some((cell) => cell.trim() !== "")).length,
            props.number,
          )}
        </p>
      </StepHead>
      <div class="import-columns">
        <For each={FULL_COLUMNS}>
          {(field) => {
            const need = NEED[field];
            const isMissing = () => showMissing() && missing().includes(field);
            return (
              <div class="field">
                <label class="field-label import-field-label" for={selectId(field)}>
                  {t(FIELD_LABEL[field])}
                  <Show when={need}>{(key) => <span class="import-need">{t(key())}</span>}</Show>
                </label>
                <select
                  id={selectId(field)}
                  class="input select"
                  aria-invalid={isMissing() ? "true" : undefined}
                  aria-describedby={`${selectId(field)}-hint ${selectId(field)}-error`}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    const next = { ...props.mapping };
                    if (value === "") delete next[field];
                    else next[field] = Number(value);
                    props.onMapping(next);
                  }}
                >
                  <option value="" selected={props.mapping[field] === undefined}>
                    {t("import.notInFile")}
                  </option>
                  <For each={props.file.headers}>
                    {(header, index) => (
                      <option value={index()} selected={props.mapping[field] === index()}>
                        {header.trim() || t("import.columnUnnamed", { n: index() + 1 })}
                      </option>
                    )}
                  </For>
                </select>
                <p id={`${selectId(field)}-hint`} class="hint">
                  {sample(field)}
                </p>
                <p id={`${selectId(field)}-error`} class="field-error">
                  {isMissing() ? t("import.missing") : ""}
                </p>
              </div>
            );
          }}
        </For>
      </div>
      <p class="field-error" role="alert">
        {summary() ?? props.error}
      </p>
      <div class="pair-actions">
        <button type="button" class="btn btn-secondary" onClick={props.onBack}>
          {t("import.back")}
        </button>
        <button type="submit" class="btn btn-primary" aria-busy={props.checking}>
          {props.checking ? t("import.checking") : t("import.continue")}
        </button>
      </div>
    </form>
  );
}
