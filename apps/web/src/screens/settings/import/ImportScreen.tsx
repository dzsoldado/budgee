// Settings → Import CSV (spec "Import"), in four steps: pick a file; match its columns to fields
// (auto-matched by header name); preview the rows with errors and warnings; then confirm, with
// the unknown categories offered for creation. Rows with an id merge like
// synced rows; the others become new entries. Nothing is written before the confirm. The rows
// are checked once, on the way to the preview, never on each column change.
import {
  autoMapHeaders,
  type ColumnMapping,
  type ImportValidation,
  validateImportRows,
} from "@budgee/core";
import { useSearchParams } from "@solidjs/router";
import { createMemo, createSignal, Match, Switch } from "solid-js";
import { useApp } from "../../../context";
import {
  applyImport,
  CsvReadError,
  checkCsvSize,
  confirmSummary,
  type ImportResult,
  loadImportContext,
  newNames,
  planImport,
  readCsvText,
  upToDateIds,
} from "../../../csv/import";
import { t } from "../../../i18n";
import { Screen } from "../../../shell/Screen";
import { announce } from "../../../sync/status";
import { settingsBack } from "../common";
import { ColumnsStep } from "./ColumnsStep";
import { ConfirmStep } from "./ConfirmStep";
import { fileRowsText, type LoadedFile } from "./common";
import { DoneStep } from "./DoneStep";
import { FileStep, type ReadOutcome } from "./FileStep";
import { PreviewStep } from "./PreviewStep";

type Step = "file" | "columns" | "preview" | "confirm" | "done";

const readProblemText = (error: unknown): string => {
  if (!(error instanceof CsvReadError)) return t("import.error.unreadable");
  const line = error.line ?? 0;
  switch (error.reason) {
    case "too_large":
      return t("import.error.tooLarge");
    case "empty":
      return t("import.error.empty");
    case "unterminated_quote":
      return t("import.error.unterminatedQuote", { line });
    case "text_after_quote":
      return t("import.error.textAfterQuote", { line });
  }
};

/** Lets the browser paint (a busy label) before a long, synchronous pass. */
const paint = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

export function ImportScreen() {
  const { db, repo, settings } = useApp();
  const [params] = useSearchParams();
  const back =
    params.from === "list" ? { href: "/", label: t("import.backToList") } : settingsBack();

  const [step, setStep] = createSignal<Step>("file");
  const [chosen, setChosen] = createSignal<File>();
  const [file, setFile] = createSignal<LoadedFile>();
  const [mapping, setMapping] = createSignal<ColumnMapping>({});
  const [validation, setValidation] = createSignal<ImportValidation>();
  const [declined, setDeclined] = createSignal<ReadonlySet<string>>(new Set());
  const [upToDate, setUpToDate] = createSignal<ReadonlySet<string>>(new Set());
  const [result, setResult] = createSignal<{ result: ImportResult; skipped: number }>();
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const number = createMemo(() => new Intl.NumberFormat(settings().locale));

  let heading: HTMLHeadingElement | undefined;
  const setHeading = (el: HTMLHeadingElement) => {
    heading = el;
  };
  /** Every step change moves focus to the new step's heading. */
  const go = (next: Step) => {
    setError(undefined);
    setStep(next);
    queueMicrotask(() => heading?.focus());
  };

  const plan = createMemo(() => {
    const checked = validation();
    return checked ? planImport(checked, declined()) : undefined;
  });
  const names = createMemo(() => {
    const checked = validation();
    return checked ? newNames(checked, declined()) : [];
  });
  const summary = createMemo(() => {
    const planned = plan();
    return planned ? confirmSummary(planned, upToDate()) : undefined;
  });

  const read = async (): Promise<ReadOutcome> => {
    if (busy()) return "read";
    setError(undefined);
    const picked = chosen();
    if (!picked) {
      setError(t("import.error.noFile"));
      return "no_file";
    }
    setBusy(true);
    try {
      checkCsvSize(picked.size);
      const text = await picked.text();
      await paint();
      const parsed = readCsvText(text);
      const context = await loadImportContext(db);
      setFile({ ...parsed, name: picked.name, context });
      setMapping(autoMapHeaders(parsed.headers));
      setValidation(undefined);
      setDeclined(new Set<string>());
      go("columns");
      return "read";
    } catch (failure) {
      if (!(failure instanceof CsvReadError)) console.error("Reading the CSV failed", failure);
      setError(readProblemText(failure));
      return "failed";
    } finally {
      setBusy(false);
    }
  };

  const check = async () => {
    const loaded = file();
    if (!loaded || busy()) return;
    setBusy(true);
    try {
      await paint();
      setValidation(validateImportRows(loaded.rows, mapping(), loaded.context));
      setDeclined(new Set<string>());
      go("preview");
    } catch (failure) {
      console.error("Checking the CSV rows failed", failure);
      setError(t("import.error.unreadable"));
    } finally {
      setBusy(false);
    }
  };

  const toConfirm = async () => {
    const checked = validation();
    if (!checked || busy()) return;
    setBusy(true);
    try {
      setUpToDate(await upToDateIds(db, planImport(checked).merges));
      go("confirm");
    } catch (failure) {
      console.error("Reading entries for the import failed", failure);
      setError(t("import.error.unreadable"));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    const planned = plan();
    const counts = summary();
    if (!planned || !counts || busy()) return;
    setBusy(true);
    setError(undefined);
    try {
      setResult({ result: await applyImport(db, repo, planned), skipped: counts.skipped });
      announce(t("import.doneTitle"));
      go("done");
    } catch (failure) {
      console.error("Saving the import failed", failure);
      setError(t("import.saveFailed"));
    } finally {
      setBusy(false);
    }
  };

  const startOver = () => {
    setChosen(undefined);
    setFile(undefined);
    setValidation(undefined);
    setResult(undefined);
    go("file");
  };

  const toggleName = (key: string, keep: boolean) =>
    setDeclined((current) => {
      const next = new Set(current);
      if (keep) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <Screen title={t("import.title")} back={back} class="settings pairing import">
      <Switch>
        <Match when={step() === "file"}>
          <FileStep
            chosen={chosen()}
            onChoose={(picked) => {
              setChosen(picked);
              setError(undefined);
            }}
            error={error()}
            busy={busy()}
            onRead={read}
            heading={setHeading}
          />
        </Match>
        <Match when={step() === "columns" && file()}>
          {(loaded) => (
            <ColumnsStep
              file={loaded()}
              mapping={mapping()}
              onMapping={setMapping}
              number={number()}
              checking={busy()}
              error={error()}
              onBack={startOver}
              onContinue={check}
              heading={setHeading}
            />
          )}
        </Match>
        <Match when={step() === "preview" && file() && validation()}>
          <PreviewStep
            file={file() as LoadedFile}
            mapping={mapping()}
            validation={validation() as ImportValidation}
            number={number()}
            busy={busy()}
            error={error()}
            onColumns={() => go("columns")}
            onContinue={toConfirm}
            heading={setHeading}
          />
        </Match>
        <Match when={step() === "confirm" && summary()}>
          {(counts) => (
            <ConfirmStep
              fileSummary={fileRowsText(
                file()?.name ?? "",
                validation()?.rows.length ?? 0,
                number(),
              )}
              names={names()}
              declined={declined()}
              onToggle={toggleName}
              summary={counts()}
              merges={plan()?.merges.length ?? 0}
              number={number()}
              busy={busy()}
              error={error()}
              onBack={() => go("preview")}
              onImport={confirm}
              heading={setHeading}
            />
          )}
        </Match>
        <Match when={step() === "done" && result()}>
          {(done) => (
            <DoneStep
              result={done().result}
              skipped={done().skipped}
              number={number()}
              onAnother={startOver}
              heading={setHeading}
            />
          )}
        </Match>
      </Switch>
    </Screen>
  );
}
