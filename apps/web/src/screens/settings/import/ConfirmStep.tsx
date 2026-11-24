// Import step 4: the unknown categories offered for creation, what the import will do, then
// Import.
import { createMemo, For, Show } from "solid-js";
import type { ConfirmSummary, NewName } from "../../../csv/import";
import { type MessageKey, t } from "../../../i18n";
import { StepHead } from "./common";

const GROUPS: readonly { type: NewName["type"]; title: MessageKey }[] = [
  { type: "expense", title: "import.newExpenses" },
  { type: "income", title: "import.newIncome" },
];

export function ConfirmStep(props: {
  fileSummary: string;
  names: readonly NewName[];
  declined: ReadonlySet<string>;
  onToggle: (key: string, keep: boolean) => void;
  summary: ConfirmSummary;
  /** Rows with an id in the plan: the merge hint only matters then. */
  merges: number;
  number: Intl.NumberFormat;
  busy: boolean;
  error: string | undefined;
  onBack: () => void;
  onImport: () => void;
  heading: (el: HTMLHeadingElement) => void;
}) {
  const count = (n: number) => props.number.format(n);
  const rowsText = (n: number) =>
    n === 1 ? t("import.rowsOne") : t("import.rowsMany", { count: count(n) });
  const s = createMemo(() => props.summary);

  return (
    <div class="card stack">
      <StepHead step={4} title={t("import.confirmTitle")} heading={props.heading}>
        <p class="hint">{props.fileSummary}</p>
      </StepHead>
      <Show when={props.names.length > 0}>
        <fieldset class="import-names">
          <legend class="field-label">{t("import.newNames")}</legend>
          <p class="hint">{t("import.newNamesHint")}</p>
          <For each={GROUPS}>
            {(group) => {
              const keys = () =>
                props.names.filter((name) => name.type === group.type).map((name) => name.key);
              return (
                <Show when={keys().length > 0}>
                  <fieldset class="import-names-group">
                    <legend>{t(group.title)}</legend>
                    {/* By key: unticking a category rebuilds the list; its checkbox keeps focus. */}
                    <For each={keys()}>
                      {(key) => {
                        const name = () => props.names.find((n) => n.key === key) as NewName;
                        return (
                          <label class="check import-name">
                            <input
                              type="checkbox"
                              checked={!props.declined.has(key)}
                              onChange={(event) => props.onToggle(key, event.currentTarget.checked)}
                            />
                            <span class="settings-item-text">
                              <span class="settings-item-name">{name().name}</span>
                              <span class="settings-item-meta">{rowsText(name().rows)}</span>
                            </span>
                          </label>
                        );
                      }}
                    </For>
                  </fieldset>
                </Show>
              );
            }}
          </For>
        </fieldset>
      </Show>
      {/* Unticking a category changes these: said politely. */}
      <div aria-live="polite">
        <dl class="settings-facts import-facts" aria-label={t("import.summary")}>
          <dt>{t("import.toAdd")}</dt>
          <dd>{count(s().toAdd)}</dd>
          <Show when={props.merges > 0}>
            <dt>{t("import.toMerge")}</dt>
            <dd>{count(s().toMerge)}</dd>
          </Show>
          <Show when={s().upToDate > 0}>
            <dt>{t("import.upToDate")}</dt>
            <dd>{count(s().upToDate)}</dd>
          </Show>
          <Show when={s().skippedErrors > 0}>
            <dt>{t("import.skippedErrors")}</dt>
            <dd>{count(s().skippedErrors)}</dd>
          </Show>
          <Show when={s().skippedDeclined > 0}>
            <dt>{t("import.skippedDeclined")}</dt>
            <dd>{count(s().skippedDeclined)}</dd>
          </Show>
          <Show when={s().skippedRepeated > 0}>
            <dt>{t("import.skippedRepeated")}</dt>
            <dd>{count(s().skippedRepeated)}</dd>
          </Show>
        </dl>
        <Show when={s().nothingToDo}>
          <p class="pair-text">{t("import.nothingToDo")}</p>
        </Show>
      </div>
      <Show when={props.merges > 0}>
        <p class="hint">{t("import.mergeHint")}</p>
      </Show>
      <p class="field-error" role="alert">
        {props.error}
      </p>
      <div class="pair-actions">
        <button type="button" class="btn btn-secondary" onClick={props.onBack}>
          {t("import.back")}
        </button>
        <button
          type="button"
          class="btn btn-primary"
          aria-busy={props.busy}
          disabled={props.busy || s().nothingToDo}
          onClick={props.onImport}
        >
          {props.busy ? t("import.importing") : t("import.confirm")}
        </button>
      </div>
    </div>
  );
}
