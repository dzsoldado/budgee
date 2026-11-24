// After the import: what changed and what was skipped.
import { A } from "@solidjs/router";
import { Show } from "solid-js";
import type { ImportResult } from "../../../csv/import";
import { t } from "../../../i18n";
import { StepHead } from "./common";

export function DoneStep(props: {
  result: ImportResult;
  skipped: number;
  number: Intl.NumberFormat;
  onAnother: () => void;
  heading: (el: HTMLHeadingElement) => void;
}) {
  const count = (n: number) => props.number.format(n);
  const changed = () => props.result.added + props.result.merged > 0;
  return (
    <div class="card stack">
      <StepHead step={undefined} title={t("import.doneTitle")} heading={props.heading} />
      <Show when={!changed()}>
        <p class="pair-text">{t("import.doneNone")}</p>
      </Show>
      <Show when={changed() || props.skipped > 0}>
        <dl class="settings-facts import-facts">
          <Show when={changed()}>
            <dt>{t("import.added")}</dt>
            <dd>{count(props.result.added)}</dd>
          </Show>
          <Show when={props.result.merged > 0}>
            <dt>{t("import.merged")}</dt>
            <dd>{count(props.result.merged)}</dd>
          </Show>
          <Show when={props.result.categories > 0}>
            <dt>{t("import.categoriesCreated")}</dt>
            <dd>{count(props.result.categories)}</dd>
          </Show>
          <Show when={props.skipped > 0}>
            <dt>{t("import.skipped")}</dt>
            <dd>{count(props.skipped)}</dd>
          </Show>
        </dl>
      </Show>
      <div class="pair-actions">
        <button type="button" class="btn btn-secondary" onClick={props.onAnother}>
          {t("import.another")}
        </button>
        <A href="/" class="btn btn-primary">
          {t("import.toList")}
        </A>
      </div>
    </div>
  );
}
