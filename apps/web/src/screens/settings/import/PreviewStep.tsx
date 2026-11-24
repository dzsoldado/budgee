// Import step 3: what the rows read as. Counts cover every row; the lists draw at most
// PREVIEW_LIMIT rows, so a large file (or a wrong mapping) never builds thousands of rows.
import type { ColumnMapping, ImportValidation } from "@budgee/core";
import { createMemo, createSignal, For, Show } from "solid-js";
import { Segmented } from "../../../components/Segmented";
import { previewPage, previewSummary } from "../../../csv/import";
import { t } from "../../../i18n";
import { fileRowsText, isOriginalPair, type LoadedFile, StepHead } from "./common";
import { PreviewRow } from "./PreviewRow";

/** How many rows "First rows" shows. */
const FIRST_ROWS = 20;

export function PreviewStep(props: {
  file: LoadedFile;
  mapping: ColumnMapping;
  validation: ImportValidation;
  number: Intl.NumberFormat;
  busy: boolean;
  error: string | undefined;
  onColumns: () => void;
  onContinue: () => void;
  heading: (el: HTMLHeadingElement) => void;
}) {
  const summary = createMemo(() => previewSummary(props.validation));
  const [view, setView] = createSignal<"first" | "problems">(
    summary().errors > 0 ? "problems" : "first",
  );
  const count = (n: number) => props.number.format(n);
  const listed = () =>
    view() === "first" ? props.validation.rows.slice(0, FIRST_ROWS) : summary().problems;
  const page = createMemo(() => previewPage(listed()));
  const pairErrors = createMemo(() =>
    summary().problems.some((row) => !row.ok && row.errors.some(isOriginalPair)),
  );

  return (
    <div class="card stack">
      <StepHead step={3} title={t("import.previewTitle")} heading={props.heading}>
        <p class="hint">{fileRowsText(props.file.name, summary().rows, props.number)}</p>
      </StepHead>
      <dl class="settings-facts import-facts">
        <dt>{t("import.ready")}</dt>
        <dd>{count(summary().ready)}</dd>
        <Show when={summary().errors > 0}>
          <dt>{t("import.withErrors")}</dt>
          <dd class="import-fact-error">{count(summary().errors)}</dd>
        </Show>
        <Show when={summary().duplicates > 0}>
          <dt>{t("import.duplicates")}</dt>
          <dd>{count(summary().duplicates)}</dd>
        </Show>
        <Show when={summary().withId > 0}>
          <dt>{t("import.withId")}</dt>
          <dd>{count(summary().withId)}</dd>
        </Show>
      </dl>
      <Show when={summary().errors > 0}>
        <p class="hint">{t("import.errorsHint")}</p>
      </Show>
      <Show when={pairErrors()}>
        <div class="import-pair-hint">
          <p class="hint">{t("import.pairHint")}</p>
          <button type="button" class="settings-text-btn" onClick={props.onColumns}>
            {t("import.changeColumns")}
          </button>
        </div>
      </Show>
      <Show when={summary().duplicates > 0}>
        <p class="hint">{t("import.duplicatesHint")}</p>
      </Show>
      <Show when={summary().problems.length > 0}>
        <Segmented
          label={t("import.view")}
          class="import-view"
          options={[
            { value: "first", label: t("import.showFirst") },
            {
              value: "problems",
              label: t("import.showProblems", { count: count(summary().problems.length) }),
            },
          ]}
          value={view()}
          onChange={setView}
        />
      </Show>
      <p class="hint" aria-live="polite">
        {view() === "first"
          ? t("import.firstRows", { count: Math.min(FIRST_ROWS, summary().rows) })
          : page().capped
            ? t("import.showingFirst", {
                shown: count(page().shown.length),
                total: count(page().total),
              })
            : t("import.problemRows")}
      </p>
      <ul class="import-rows">
        <For each={page().shown}>
          {(row) => <PreviewRow row={row} file={props.file} mapping={props.mapping} />}
        </For>
      </ul>
      <Show when={summary().ready === 0}>
        <p class="field-error">{t("import.noneReady")}</p>
      </Show>
      <p class="field-error" role="alert">
        {props.error}
      </p>
      <div class="pair-actions">
        <button type="button" class="btn btn-secondary" onClick={props.onColumns}>
          {t("import.back")}
        </button>
        <button
          type="button"
          class="btn btn-primary"
          aria-busy={props.busy}
          disabled={props.busy || summary().ready === 0}
          onClick={props.onContinue}
        >
          {t("import.continue")}
        </button>
      </div>
    </div>
  );
}
