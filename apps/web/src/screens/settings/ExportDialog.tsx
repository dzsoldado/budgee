// Export CSV: everything or what the List shows (its month and filter), simple or full. Saved
// through a download, or the share sheet on Android when it takes files.
import type { CsvFlavour } from "@budgee/core";
import { createEffect, createMemo, createSignal, createUniqueId, on } from "solid-js";
import { Dialog } from "../../components/Dialog";
import { useApp } from "../../context";
import {
  csvFile,
  deliverFile,
  type ExportScope,
  isAndroid,
  loadAllEntries,
  loadListEntries,
} from "../../csv/export";
import { createLiveQuery } from "../../db/live";
import { t } from "../../i18n";
import { todayIso } from "../../lib/date";
import { isFilterActive } from "../../list/filter";
import { monthTitle } from "../../list/month";
import { listFilter, listMonth } from "../../list/store";
import { announce } from "../../sync/status";

export type ExportWhat = "all" | "list";

function Choice<T extends string>(props: {
  name: string;
  value: T;
  checked: boolean;
  label: string;
  meta: string;
  onChoose: (value: T) => void;
}) {
  return (
    <label class="export-choice">
      <input
        type="radio"
        name={props.name}
        value={props.value}
        checked={props.checked}
        data-autofocus={props.checked ? "" : undefined}
        onChange={() => props.onChoose(props.value)}
      />
      <span class="settings-item-text">
        <span class="settings-item-name">{props.label}</span>
        <span class="settings-item-meta">{props.meta}</span>
      </span>
    </label>
  );
}

export function ExportDialog(props: { open: boolean; what: ExportWhat; onClose: () => void }) {
  const { db, platform, settings } = useApp();
  const id = createUniqueId();
  const [what, setWhat] = createSignal<ExportWhat>(props.what);
  const [flavour, setFlavour] = createSignal<CsvFlavour>("simple");
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);

  // Each opening starts from the caller's choice of what to export.
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return;
        setWhat(props.what);
        setError(undefined);
      },
    ),
  );

  // Counted only while open: the dialog stays mounted so focus returns where it came from.
  const all = createLiveQuery(
    () => props.open,
    (open) => (open ? loadAllEntries(db) : undefined),
  );
  const shown = createLiveQuery(
    () => (props.open ? ([listMonth(), listFilter()] as const) : undefined),
    (list) => (list ? loadListEntries(db, list[0], list[1]) : undefined),
  );
  const number = createMemo(() => new Intl.NumberFormat(settings().locale));
  const count = (n: number | undefined) =>
    n === 1 ? t("lists.entriesOne") : t("lists.entriesMany", { count: number().format(n ?? 0) });
  const listMeta = createMemo(() => {
    const month = monthTitle(listMonth(), settings().locale);
    const entries = count(shown()?.length);
    return isFilterActive(listFilter())
      ? t("export.listFilteredMeta", { month, entries })
      : t("export.listMeta", { month, entries });
  });
  const sharing = () => isAndroid(navigator.userAgent) && platform.share.canShareFiles();

  const run = async () => {
    if (busy()) return;
    setError(undefined);
    setBusy(true);
    try {
      const scope: ExportScope =
        what() === "all"
          ? { kind: "all", today: todayIso() }
          : { kind: "list", month: listMonth() };
      const rows =
        what() === "all"
          ? await loadAllEntries(db)
          : await loadListEntries(db, listMonth(), listFilter());
      if (rows.length === 0) {
        setError(t("export.empty"));
        return;
      }
      const file = csvFile(rows, flavour(), scope);
      const result = await deliverFile(platform, file, isAndroid(navigator.userAgent));
      if (result === "cancelled") return;
      const entries = count(rows.length);
      announce(
        result === "shared"
          ? t("export.shared", { name: file.name, entries })
          : t("export.saved", { name: file.name, entries }),
      );
      props.onClose();
    } catch (failure) {
      console.error("Exporting the CSV failed", failure);
      setError(t("export.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={props.open} title={t("export.title")} onClose={props.onClose}>
      <form
        class="dialog-form export-form"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <fieldset class="export-group">
          <legend class="field-label">{t("export.what")}</legend>
          {/* Drawn once (not from a list rebuilt as the counts load), so focus stays put. */}
          <Choice
            name={`${id}-what`}
            value="all"
            checked={what() === "all"}
            label={t("export.all")}
            meta={count(all()?.length)}
            onChoose={setWhat}
          />
          <Choice
            name={`${id}-what`}
            value="list"
            checked={what() === "list"}
            label={t("export.list")}
            meta={listMeta()}
            onChoose={setWhat}
          />
        </fieldset>
        <fieldset class="export-group">
          <legend class="field-label">{t("export.format")}</legend>
          <Choice
            name={`${id}-flavour`}
            value="simple"
            checked={flavour() === "simple"}
            label={t("export.simple")}
            meta={t("export.simpleMeta")}
            onChoose={setFlavour}
          />
          <Choice
            name={`${id}-flavour`}
            value="full"
            checked={flavour() === "full"}
            label={t("export.full")}
            meta={t("export.fullMeta")}
            onChoose={setFlavour}
          />
        </fieldset>
        <p class="field-error" role="alert">
          {error()}
        </p>
        <div class="confirm-actions">
          <button type="button" class="btn btn-secondary" onClick={props.onClose}>
            {t("lists.cancel")}
          </button>
          <button type="submit" class="btn btn-primary" aria-busy={busy()} disabled={busy()}>
            {busy() ? t("export.saving") : sharing() ? t("export.share") : t("export.save")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
