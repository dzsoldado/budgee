// Import step 1: choose the CSV file.
import { createUniqueId } from "solid-js";
import { t } from "../../../i18n";
import { ChevronRightIcon, FileIcon } from "../../../shell/icons";
import { StepHead } from "./common";

/** How reading went: `no_file` focuses the picker, `failed` the error. */
export type ReadOutcome = "read" | "no_file" | "failed";

export function FileStep(props: {
  chosen: File | undefined;
  onChoose: (file: File | undefined) => void;
  error: string | undefined;
  busy: boolean;
  onRead: () => Promise<ReadOutcome>;
  heading: (el: HTMLHeadingElement) => void;
}) {
  const id = createUniqueId();
  let input!: HTMLInputElement;
  let error!: HTMLParagraphElement;

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    const outcome = await props.onRead();
    if (outcome === "no_file") input.focus();
    if (outcome === "failed") error.focus();
  };

  return (
    <form class="card stack" novalidate onSubmit={submit}>
      <StepHead step={1} title={t("import.fileTitle")} heading={props.heading}>
        <p class="pair-text">{t("import.intro")}</p>
      </StepHead>
      <div class="field">
        <span class="field-label" id={`${id}-file-label`}>
          {t("import.file")}
        </span>
        <label class="file-pick">
          <input
            ref={input}
            type="file"
            class="file-pick-input"
            accept=".csv,text/csv,text/plain"
            aria-labelledby={`${id}-file-label`}
            aria-describedby={`${id}-file-hint`}
            onChange={(event) => props.onChoose(event.currentTarget.files?.[0])}
          />
          <span class="file-pick-icon">
            <FileIcon size={18} />
          </span>
          <span class="file-pick-name" classList={{ "file-pick-empty": !props.chosen }}>
            {props.chosen?.name ?? t("import.chooseFile")}
          </span>
          <ChevronRightIcon size={16} />
        </label>
        <p id={`${id}-file-hint`} class="hint">
          {t("import.fileHint")}
        </p>
      </div>
      <p class="field-error" role="alert" tabindex="-1" ref={error}>
        {props.error}
      </p>
      <button
        type="submit"
        class="btn btn-primary pair-wide"
        aria-busy={props.busy}
        disabled={props.busy}
      >
        {props.busy ? t("import.reading") : t("import.read")}
      </button>
    </form>
  );
}
