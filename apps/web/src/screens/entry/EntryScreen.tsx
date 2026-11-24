// Add / edit an entry (Add.dc.html). Phones: full screen with the Save button in a sticky
// footer; from 1024px the same form, centered in the content column. Saving and deleting go
// through the repository (which tells the sync client about the change), then return to the
// List on the entry's month.
import { type LiveTransaction, listTags } from "@budgee/core";
import { useBeforeLeave, useHref, useNavigate, useParams } from "@solidjs/router";
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  createUniqueId,
  type JSX,
  Match,
  on,
  Show,
  Switch,
} from "solid-js";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Segmented } from "../../components/Segmented";
import { useApp } from "../../context";
import { createLiveQuery } from "../../db/live";
import {
  buildEntry,
  type EntryErrors,
  type EntryField,
  type EntryForm,
  type EntryType,
  emptyForm,
  formFromTransaction,
  normalizeAmountText,
  prefillAmount,
  rateText,
  sameForm,
} from "../../entry/form";
import { addTag, detailSuggestions, recentCurrencies, tagSuggestions } from "../../entry/suggest";
import { t } from "../../i18n";
import { todayIso } from "../../lib/date";
import { sortByOrder } from "../../list/categories";
import { monthOf } from "../../list/month";
import { setListMonth } from "../../list/store";
import { CloseIcon } from "../../shell/icons";
import { useDocumentTitle } from "../../shell/Screen";
import {
  AmountField,
  ChoiceField,
  DateField,
  DetailField,
  ErrorText,
  ForeignFields,
  TagsField,
} from "./fields";

export function AddScreen() {
  useDocumentTitle(() => t("add.title"));
  return <EntryEditor />;
}

export function EditScreen() {
  const { db } = useApp();
  const params = useParams<{ id: string }>();
  useDocumentTitle(() => t("edit.title"));
  // Read once: a sync arriving while the form is open must not reset what is being typed.
  const [row] = createResource(
    () => params.id,
    async (id) => {
      const found = await db.transactions.get(id);
      return found && !found.deleted ? (found as LiveTransaction) : null;
    },
  );
  return (
    <Switch>
      <Match when={row.state === "errored"}>
        <Missing title={t("entry.loadError")} hint={t("entry.loadErrorHint")} />
      </Match>
      <Match when={row.state === "ready" || row.state === "refreshing"}>
        <Show
          when={row()}
          keyed
          fallback={<Missing title={t("entry.notFound")} hint={t("entry.notFoundHint")} />}
        >
          {(tx) => <EntryEditor tx={tx} />}
        </Show>
      </Match>
    </Switch>
  );
}

function EntryHeader(props: { title: string; children?: JSX.Element }) {
  const listHref = useHref(() => "/");
  return (
    <header class="editor-header">
      <a class="editor-close" href={listHref()} aria-label={t("entry.close")}>
        <CloseIcon size={22} strokeWidth={2} />
      </a>
      <h1 class="editor-title">{props.title}</h1>
      <div class="editor-header-end">{props.children}</div>
    </header>
  );
}

/** An edit screen with no entry to show: not found, or the read failed. */
function Missing(props: { title: string; hint: string }) {
  const listHref = useHref(() => "/");
  return (
    <div class="editor-screen">
      <EntryHeader title={t("edit.title")} />
      <div class="editor-missing">
        <p class="editor-missing-title">{props.title}</p>
        <p class="hint">{props.hint}</p>
        <a class="btn btn-primary" href={listHref()}>
          {t("entry.backToList")}
        </a>
      </div>
    </div>
  );
}

/** The errors a change to each form field clears. */
const CLEARS: Record<keyof EntryForm, readonly EntryField[]> = {
  type: ["category"],
  amount: ["amount"],
  foreign: ["originalAmount", "originalCurrency"],
  originalAmount: ["originalAmount"],
  originalCurrency: ["originalCurrency"],
  date: ["date"],
  category: ["category"],
  detail: [],
  tags: ["tags"],
  tagDraft: ["tags"],
  note: [],
};

function EntryEditor(props: { tx?: LiveTransaction }) {
  const { db, repo, settings } = useApp();
  const navigate = useNavigate();
  const editing = props.tx;

  const categoryRows = createLiveQuery(() => db.categories.toArray());
  const transactionRows = createLiveQuery(() => db.transactions.toArray());
  const categories = createMemo(() => sortByOrder(categoryRows() ?? []));
  const entries = createMemo(() =>
    (transactionRows() ?? []).filter((row): row is typeof row & LiveTransaction => !row.deleted),
  );
  /** Past entries for the rate, never the entry being edited; undefined until loaded. */
  const others = createMemo(() =>
    transactionRows() === undefined ? undefined : entries().filter((e) => e.id !== editing?.id),
  );
  const knownTags = createMemo(() => listTags(entries()));
  const recents = createMemo(() => recentCurrencies(entries(), settings().currency));

  const initial = editing ? formFromTransaction(editing, settings()) : emptyForm(todayIso());
  const [form, setForm] = createSignal<EntryForm>(initial);
  const [errors, setErrors] = createSignal<EntryErrors>({});
  const dirty = () => !sameForm(form(), initial);

  const patch = (changes: Partial<EntryForm>) => {
    setForm((current) => ({ ...current, ...changes }));
    const cleared = (Object.keys(changes) as (keyof EntryForm)[]).flatMap((key) => CLEARS[key]);
    if (cleared.length === 0) return;
    setErrors((current) => {
      const next = { ...current };
      for (const field of [...cleared, "form" as const]) delete next[field];
      return next;
    });
  };

  // ─── Foreign currency: rate hint and prefill ──────────────────────────────
  /** The main amount was typed (or loaded), so the rate never overwrites it. */
  const [amountTyped, setAmountTyped] = createSignal(initial.amount.trim() !== "");
  const onAmountTyped = () => setAmountTyped(form().amount.trim() !== "");
  /** While the main amount isn't the user's, it follows the original amount at the last rate. */
  const prefill = () => {
    const next = prefillAmount({
      form: form(),
      typed: amountTyped(),
      entries: others(),
      decimals: settings().decimals,
      locale: settings().locale,
    });
    if (next !== null) patch({ amount: next });
  };
  // The rate's source loading (or changing) updates an amount the user hasn't typed.
  createEffect(on(others, prefill, { defer: true }));
  /** The main amount as typed, grouped once it is left ("6000" becomes "6,000"). */
  const groupAmount = () => {
    const text = normalizeAmountText(form().amount, settings().decimals, settings().locale);
    if (text !== form().amount) patch({ amount: text });
  };
  const hint = createMemo(() => {
    const { foreign, originalCurrency: currency } = form();
    const past = others();
    if (!foreign || currency === "" || past === undefined) return null;
    const main = settings().currency;
    const rate = rateText(currency, past, settings().locale);
    return rate === null
      ? t("entry.noRateHint", { currency, main })
      : t("entry.rateHint", { currency, rate, main });
  });

  // ─── Choices ──────────────────────────────────────────────────────────────
  /** Archived names are offered only when already chosen (an older entry). */
  const categoryNames = createMemo(() =>
    categories()
      .filter((c) => c.type === form().type && (!c.archived || c.name === form().category))
      .map((c) => c.name),
  );
  const setType = (type: EntryType) => {
    const keep = categories().some((c) => c.type === type && c.name === form().category);
    patch(keep ? { type } : { type, category: "" });
  };
  const tagNames = () => knownTags().map((k) => k.tag);
  const addTagText = (text: string) => {
    const added = addTag(form().tags, text, tagNames());
    if (added.ok) patch({ tags: added.tags });
    return added.ok;
  };

  // ─── Save, delete, leave ──────────────────────────────────────────────────
  let formElement!: HTMLFormElement;
  let leaving = false;
  let saving = false;
  const formErrorId = createUniqueId();

  const leaveTo = (date: string) => {
    leaving = true;
    setListMonth(monthOf(date));
    navigate("/");
  };

  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    if (saving) return;
    const result = buildEntry(form(), {
      decimals: settings().decimals,
      createdAt: editing?.created_at ?? new Date().toISOString(),
      knownTags: tagNames(),
      initial: editing ? { text: initial.amount, amount: editing.amount } : undefined,
    });
    if (!result.ok) {
      setErrors(result.errors);
      queueMicrotask(() =>
        formElement
          .querySelector<HTMLElement>('[aria-invalid="true"], [data-invalid] button')
          ?.focus(),
      );
      return;
    }
    saving = true;
    let written: boolean;
    try {
      written = await repo.write(async (writer) => {
        // A sync may have deleted the entry while the form was open; saving would bring it
        // back, so the check runs in the same transaction as the write. Other changes synced
        // meanwhile are overwritten: the last save wins.
        if (editing) {
          const current = await db.transactions.get(editing.id);
          if (!current || current.deleted) return false;
        }
        await writer.put("transactions", result.fields, editing?.id);
        return true;
      });
    } catch (error) {
      console.error("Saving the entry failed", error);
      saving = false;
      setErrors({ form: { key: "entry.errorSave" } });
      return;
    }
    saving = false;
    if (written) leaveTo(result.fields.date);
    else setDeletedElsewhere(true);
  };
  /** The entry was deleted on another device before this edit was saved. */
  const [deletedElsewhere, setDeletedElsewhere] = createSignal(false);

  const [confirmingDelete, setConfirmingDelete] = createSignal(false);
  const remove = async () => {
    if (!editing) return;
    setConfirmingDelete(false);
    try {
      await repo.remove("transactions", editing.id);
    } catch (error) {
      console.error("Deleting the entry failed", error);
      setErrors((current) => ({ ...current, form: { key: "entry.errorDelete" } }));
      return;
    }
    leaveTo(editing.date);
  };

  /** Set while a navigation waits for "Discard changes?"; calling it leaves. */
  const [pendingLeave, setPendingLeave] = createSignal<(() => void) | null>(null);
  useBeforeLeave((event) => {
    if (leaving || !dirty()) return;
    event.preventDefault();
    setPendingLeave(() => () => {
      leaving = true;
      setPendingLeave(null);
      event.retry(true);
    });
  });

  return (
    <div class="editor-screen">
      <EntryHeader title={editing ? t("edit.title") : t("add.title")}>
        <Show when={editing}>
          <button
            type="button"
            class="btn btn-danger editor-delete"
            onClick={() => setConfirmingDelete(true)}
          >
            {t("entry.delete")}
          </button>
        </Show>
      </EntryHeader>

      <form ref={formElement} class="editor-form" novalidate onSubmit={save}>
        <div class="editor-fields">
          <Segmented
            wide
            label={t("entry.type")}
            value={form().type}
            onChange={setType}
            options={[
              { value: "expense", label: t("entry.expense"), class: "segment-expense" },
              { value: "income", label: t("entry.income"), class: "segment-income" },
            ]}
          />
          <AmountField
            form={form}
            patch={patch}
            error={(f) => errors()[f]}
            currency={settings().currency}
            onType={onAmountTyped}
            onLeave={groupAmount}
          />
          <ForeignFields
            form={form}
            patch={patch}
            error={(f) => errors()[f]}
            recents={recents()}
            current={form().originalCurrency}
            mainCurrency={settings().currency}
            locale={settings().locale}
            hint={hint()}
            onOriginalChange={prefill}
          />
          <DateField form={form} patch={patch} error={(f) => errors()[f]} />
          <ChoiceField
            legend={t("entry.category")}
            options={categoryNames()}
            selected={form().category}
            onSelect={(category) => patch({ category })}
            error={errors().category}
          />
          <DetailField
            form={form}
            patch={patch}
            error={(f) => errors()[f]}
            suggest={(typed) => detailSuggestions(entries(), form().type, typed)}
          />
          <TagsField
            form={form}
            patch={patch}
            error={(f) => errors()[f]}
            suggest={(typed) => tagSuggestions(knownTags(), typed, form().tags)}
            add={addTagText}
          />
          <NoteField form={form} patch={patch} />
        </div>

        <footer class="editor-footer">
          <div role="alert">
            <ErrorText id={formErrorId} error={errors().form} />
            <Show when={deletedElsewhere()}>
              <p class="field-error">{t("entry.deletedElsewhere")}</p>
            </Show>
          </div>
          <Show
            when={!deletedElsewhere()}
            fallback={
              <button
                type="button"
                class="btn btn-secondary editor-save"
                onClick={() => leaveTo(editing?.date ?? todayIso())}
              >
                {t("entry.backToList")}
              </button>
            }
          >
            <button type="submit" class="btn btn-primary editor-save">
              {form().type === "income" ? t("entry.saveIncome") : t("entry.saveExpense")}
            </button>
          </Show>
        </footer>
      </form>

      <ConfirmDialog
        open={confirmingDelete()}
        title={t("entry.deleteTitle")}
        body={t("entry.deleteBody")}
        confirmLabel={t("entry.deleteConfirm")}
        cancelLabel={t("entry.cancel")}
        destructive
        onConfirm={() => void remove()}
        onCancel={() => setConfirmingDelete(false)}
      />
      <ConfirmDialog
        open={pendingLeave() !== null}
        title={t("entry.discardTitle")}
        body={t("entry.discardBody")}
        confirmLabel={t("entry.discardConfirm")}
        cancelLabel={t("entry.keepEditing")}
        destructive
        onConfirm={() => pendingLeave()?.()}
        onCancel={() => setPendingLeave(null)}
      />
    </div>
  );
}

function NoteField(props: { form: () => EntryForm; patch: (changes: Partial<EntryForm>) => void }) {
  const id = createUniqueId();
  return (
    <div class="field">
      <label for={id} class="field-label">
        {t("entry.note")} <span class="field-note">{t("entry.optional")}</span>
      </label>
      <input
        id={id}
        type="text"
        class="input input-note"
        placeholder={t("entry.notePlaceholder")}
        value={props.form().note}
        onInput={(event) => props.patch({ note: event.currentTarget.value })}
      />
    </div>
  );
}
