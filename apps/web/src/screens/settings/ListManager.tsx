// Settings → Categories: the categories of one type in order, with move up / down buttons, and
// one dialog to add, rename, archive, merge or delete a row. Every change is a single repository
// write (settings/lists.ts).
import type { LiveTransaction } from "@budgee/core";
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  type JSX,
  Match,
  on,
  Show,
  Switch,
} from "solid-js";
import { Dialog } from "../../components/Dialog";
import { useApp } from "../../context";
import { type MessageKey, t } from "../../i18n";
import {
  addItem,
  checkName,
  deleteItem,
  type EntryType,
  isLastActive,
  ListError,
  type ListErrorReason,
  type ListItem,
  mergeItem,
  moveItem,
  renameItem,
  setArchived,
  usage,
} from "../../settings/lists";
import { ChevronDownIcon, ChevronUpIcon, PlusIcon } from "../../shell/icons";
import { entriesText } from "./common";

type View = { kind: "add" } | { kind: "edit" | "merge" | "delete" | "inUse"; id: string };

const TITLE: Record<Exclude<View["kind"], "add">, MessageKey> = {
  edit: "lists.editTitle",
  merge: "lists.mergeTitle",
  delete: "lists.deleteTitle",
  inUse: "lists.inUseTitle",
};

const ERROR_TEXT: Record<ListErrorReason, MessageKey> = {
  empty: "lists.errorEmpty",
  taken: "lists.errorTaken",
  takenByIncome: "lists.errorTakenByIncome",
  takenByExpense: "lists.errorTakenByExpense",
  missing: "lists.errorMissing",
  inUse: "lists.errorInUse",
  last: "lists.errorLast",
};

export function ListManager(props: {
  type: EntryType;
  /** The type's live categories in order. */
  rows: readonly ListItem[];
  /** Live entries, for the counts; undefined while loading. */
  entries: readonly LiveTransaction[] | undefined;
  /** Accessible name of the list, e.g. "Expense categories". */
  label: string;
  addLabel: MessageKey;
  addTitle: MessageKey;
  /** Announces a finished change (a status region on the screen). */
  announce: (text: string) => void;
}) {
  const { db, repo } = useApp();
  const errorId = createUniqueId();
  const [view, setView] = createSignal<View>();
  const [name, setName] = createSignal("");
  const [target, setTarget] = createSignal("");
  const [error, setError] = createSignal<MessageKey>();
  const [busy, setBusy] = createSignal(false);

  const count = (row: ListItem) =>
    props.entries === undefined ? undefined : usage(props.entries, props.type, row.name);
  const meta = (row: ListItem) => {
    const n = count(row);
    const entries = n === undefined ? "" : entriesText(n);
    return row.archived ? t("lists.archivedMeta", { entries }) : entries;
  };

  /** The row the dialog is about; undefined for Add, or once it is gone. */
  const row = createMemo(() => {
    const current = view();
    return current && current.kind !== "add"
      ? props.rows.find((r) => r.id === current.id)
      : undefined;
  });
  const others = createMemo(() => props.rows.filter((r) => r.id !== row()?.id));
  /** The only active row can't be archived, merged away or deleted: new entries need one. */
  const lastActive = () => {
    const current = row();
    return !!current && isLastActive(props.rows, current);
  };
  const targetRow = () => others().find((r) => r.id === target());

  const show = (next: View) => {
    setError(undefined);
    setView(next);
  };
  const close = () => {
    setError(undefined);
    setView(undefined);
  };
  // After a change the list re-renders, so the row that opened the dialog is gone: once the
  // change shows, focus goes to the row by id, else to the row now at its place, else to Add.
  let list!: HTMLUListElement;
  let addButton!: HTMLButtonElement;
  let refocus: { id: string | undefined; index: number; before: readonly ListItem[] } | undefined;
  const applyRefocus = () => {
    if (!refocus || view() || props.rows === refocus.before) return;
    const { id, index } = refocus;
    refocus = undefined;
    const rows = [...list.querySelectorAll<HTMLButtonElement>(".settings-item-main")];
    const byId =
      id === undefined ? null : list.querySelector<HTMLButtonElement>(`[data-row="${id}"]`);
    (byId ?? rows[Math.min(index, rows.length - 1)] ?? addButton).focus();
  };
  createEffect(on(() => props.rows, applyRefocus, { defer: true }));
  /** Closes the dialog after a successful write and sends focus where the change landed. */
  const done = (before: readonly ListItem[], id: string | undefined, index: number) => {
    refocus = { id, index, before };
    close();
    applyRefocus();
  };
  const indexOf = (id: string) =>
    Math.max(
      0,
      props.rows.findIndex((r) => r.id === id),
    );

  // A row deleted elsewhere (sync, another tab) while its dialog is open closes the dialog.
  createEffect(() => {
    const current = view();
    if (current && current.kind !== "add" && !row()) close();
  });
  const openEdit = (r: ListItem) => {
    setName(r.name);
    show({ kind: "edit", id: r.id });
  };
  const openAdd = () => {
    setName("");
    show({ kind: "add" });
  };
  const openMerge = (id: string) => {
    const choices = props.rows.filter((r) => r.id !== id);
    setTarget((choices.find((r) => !r.archived) ?? choices[0])?.id ?? "");
    show({ kind: "merge", id });
  };
  const openDelete = (r: ListItem) =>
    show({ kind: (count(r) ?? 0) > 0 ? "inUse" : "delete", id: r.id });

  /** Runs a write; on failure shows why (or the in-use choices) and returns false. */
  const run = async (write: () => Promise<unknown>): Promise<boolean> => {
    if (busy()) return false;
    setBusy(true);
    setError(undefined);
    try {
      await write();
      return true;
    } catch (failure) {
      const current = row();
      if (failure instanceof ListError && failure.reason === "inUse" && current) {
        show({ kind: "inUse", id: current.id });
      } else if (failure instanceof ListError) {
        setError(ERROR_TEXT[failure.reason]);
      } else {
        console.error("Saving the list change failed", failure);
        setError("lists.errorSave");
      }
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const current = view();
    if (!current) return;
    const exceptId = current.kind === "add" ? undefined : current.id;
    const checked = checkName(name(), props.rows, exceptId);
    if (!checked.ok) {
      setError(ERROR_TEXT[checked.error]);
      return;
    }
    const before = props.rows;
    if (current.kind === "add") {
      let added: ListItem | undefined;
      const ok = await run(async () => {
        added = await addItem(db, repo, props.type, checked.name);
      });
      if (ok) {
        done(before, added?.id, before.length);
        props.announce(t("lists.addedStatus", { name: checked.name }));
      }
      return;
    }
    if (checked.name === row()?.name) {
      close();
      return;
    }
    let changed = 0;
    const ok = await run(async () => {
      changed = await renameItem(db, repo, props.type, current.id, checked.name);
    });
    if (ok) {
      done(before, current.id, indexOf(current.id));
      props.announce(
        t("lists.renamedStatus", { name: checked.name, entries: entriesText(changed) }),
      );
    }
  };

  const toggleArchive = async (r: ListItem) => {
    const archived = !r.archived;
    const before = props.rows;
    if (await run(() => setArchived(db, repo, props.type, r.id, archived))) {
      done(before, r.id, indexOf(r.id));
      props.announce(
        t(archived ? "lists.archivedStatus" : "lists.unarchivedStatus", { name: r.name }),
      );
    }
  };

  const merge = async (source: ListItem) => {
    const into = targetRow();
    if (!into) return;
    const before = props.rows;
    const index = indexOf(source.id);
    let changed = 0;
    const ok = await run(async () => {
      changed = await mergeItem(db, repo, props.type, source.id, into.id);
    });
    if (ok) {
      done(before, undefined, index);
      props.announce(
        t("lists.mergedStatus", {
          name: source.name,
          target: into.name,
          entries: entriesText(changed),
        }),
      );
    }
  };

  const remove = async (r: ListItem) => {
    const before = props.rows;
    const index = indexOf(r.id);
    if (await run(() => deleteItem(db, repo, props.type, r.id))) {
      done(before, undefined, index);
      props.announce(t("lists.deletedStatus", { name: r.name }));
    }
  };

  // ─── Reorder: focus follows the moved row ─────────────────────────────────
  let follow: { id: string; dir: "up" | "down" } | undefined;
  createEffect(
    on(
      () => props.rows,
      () => {
        if (!follow) return;
        const { id, dir } = follow;
        follow = undefined;
        const other = dir === "up" ? "down" : "up";
        const button =
          list.querySelector<HTMLButtonElement>(`[data-move="${id}:${dir}"]:not(:disabled)`) ??
          list.querySelector<HTMLButtonElement>(`[data-move="${id}:${other}"]`);
        button?.focus();
      },
      { defer: true },
    ),
  );
  const move = async (r: ListItem, delta: -1 | 1) => {
    const index = props.rows.findIndex((x) => x.id === r.id);
    follow = { id: r.id, dir: delta < 0 ? "up" : "down" };
    try {
      await moveItem(db, repo, props.type, r.id, delta);
      props.announce(
        t("lists.movedStatus", {
          name: r.name,
          position: index + 1 + delta,
          total: props.rows.length,
        }),
      );
    } catch (failure) {
      follow = undefined;
      console.error("Reordering failed", failure);
      props.announce(t("lists.errorSave"));
    }
  };

  const title = () => {
    const current = view();
    const r = row();
    if (!current) return "";
    if (current.kind === "add") return t(props.addTitle);
    return t(TITLE[current.kind], { name: r?.name ?? "" });
  };

  const errorText = () => (
    <p id={errorId} class="field-error" role="alert">
      {error() ? t(error() as MessageKey) : ""}
    </p>
  );

  /** The name form; `hint` sits under the field, `more` (Archive, Merge…, Delete) under the actions. */
  const nameForm = (
    submitLabel: MessageKey,
    slots: { hint?: () => JSX.Element; more?: () => JSX.Element } = {},
  ) => (
    <form
      class="dialog-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label class="field">
        <span class="field-label">{t("lists.name")}</span>
        <input
          class="input"
          data-autofocus
          autocomplete="off"
          value={name()}
          aria-invalid={error() ? "true" : undefined}
          aria-describedby={errorId}
          onInput={(event) => {
            setName(event.currentTarget.value);
            setError(undefined);
          }}
        />
      </label>
      {slots.hint?.()}
      {errorText()}
      <div class="confirm-actions">
        <button type="button" class="btn btn-secondary" onClick={close}>
          {t("lists.cancel")}
        </button>
        <button type="submit" class="btn btn-primary" disabled={busy()}>
          {t(submitLabel)}
        </button>
      </div>
      {slots.more?.()}
    </form>
  );

  return (
    <>
      <div class="settings-card">
        <ul class="settings-list" aria-label={props.label} ref={list}>
          <For each={props.rows}>
            {(r, i) => (
              <li class="settings-item" classList={{ "settings-item-archived": r.archived }}>
                <button
                  type="button"
                  class="settings-item-main"
                  data-row={r.id}
                  aria-haspopup="dialog"
                  onClick={() => openEdit(r)}
                >
                  <span class="settings-item-name">{r.name}</span>
                  <span class="settings-item-meta">{meta(r)}</span>
                </button>
                <button
                  type="button"
                  class="icon-btn"
                  data-move={`${r.id}:up`}
                  aria-label={t("lists.moveUp", { name: r.name })}
                  disabled={i() === 0}
                  onClick={() => move(r, -1)}
                >
                  <ChevronUpIcon size={18} />
                </button>
                <button
                  type="button"
                  class="icon-btn"
                  data-move={`${r.id}:down`}
                  aria-label={t("lists.moveDown", { name: r.name })}
                  disabled={i() === props.rows.length - 1}
                  onClick={() => move(r, 1)}
                >
                  <ChevronDownIcon size={18} />
                </button>
              </li>
            )}
          </For>
        </ul>
        <button
          type="button"
          class="settings-add"
          aria-haspopup="dialog"
          ref={addButton}
          onClick={openAdd}
        >
          <PlusIcon size={18} />
          {t(props.addLabel)}
        </button>
      </div>

      <Dialog open={!!view()} view={view()?.kind} title={title()} onClose={close}>
        <Switch>
          <Match when={view()?.kind === "add"}>{nameForm("lists.add")}</Match>
          <Match when={view()?.kind === "edit" && row()}>
            {(r) =>
              nameForm("lists.save", {
                hint: () => (
                  <p class="hint">
                    {(count(r()) ?? 0) > 0
                      ? t("lists.renameHint", { entries: entriesText(count(r()) ?? 0) })
                      : t("lists.renameHintNone")}
                  </p>
                ),
                more: () => (
                  <>
                    <div class="dialog-more">
                      <button
                        type="button"
                        class="btn btn-secondary"
                        disabled={busy() || (!r().archived && lastActive())}
                        onClick={() => toggleArchive(r())}
                      >
                        {t(r().archived ? "lists.unarchive" : "lists.archive")}
                      </button>
                      <button
                        type="button"
                        class="btn btn-secondary"
                        disabled={others().length === 0 || lastActive()}
                        onClick={() => openMerge(r().id)}
                      >
                        {t("lists.mergeAction")}
                      </button>
                      <button
                        type="button"
                        class="btn btn-danger"
                        disabled={lastActive()}
                        onClick={() => openDelete(r())}
                      >
                        {t("lists.delete")}
                      </button>
                    </div>
                    <Show when={lastActive()}>
                      <p class="hint">{t("lists.lastHint")}</p>
                    </Show>
                  </>
                ),
              })
            }
          </Match>
          <Match when={view()?.kind === "merge" && row()}>
            {(r) => (
              <form
                class="dialog-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void merge(r());
                }}
              >
                <label class="field">
                  <span class="field-label">{t("lists.mergeInto")}</span>
                  <select
                    class="input select"
                    data-autofocus
                    value={target()}
                    onChange={(event) => setTarget(event.currentTarget.value)}
                  >
                    <For each={others()}>
                      {(o) => (
                        <option value={o.id}>
                          {o.archived ? t("lists.archivedOption", { name: o.name }) : o.name}
                        </option>
                      )}
                    </For>
                  </select>
                </label>
                <p class="confirm-body">
                  {(count(r()) ?? 0) > 0
                    ? t("lists.mergeBody", {
                        name: r().name,
                        target: targetRow()?.name ?? "",
                        entries: entriesText(count(r()) ?? 0),
                      })
                    : t("lists.mergeBodyNone", { name: r().name })}
                </p>
                {errorText()}
                <div class="confirm-actions">
                  <button type="button" class="btn btn-secondary" onClick={() => openEdit(r())}>
                    {t("lists.back")}
                  </button>
                  <button
                    type="submit"
                    class="btn btn-danger confirm-danger"
                    disabled={busy() || !targetRow()}
                  >
                    {t("lists.merge")}
                  </button>
                </div>
              </form>
            )}
          </Match>
          <Match when={view()?.kind === "delete" && row()}>
            {(r) => (
              <>
                <p class="confirm-body">{t("lists.deleteBody", { name: r().name })}</p>
                {errorText()}
                <div class="confirm-actions">
                  <button type="button" class="btn btn-secondary" onClick={close}>
                    {t("lists.cancel")}
                  </button>
                  <button
                    type="button"
                    class="btn btn-danger confirm-danger"
                    disabled={busy()}
                    onClick={() => remove(r())}
                  >
                    {t("lists.delete")}
                  </button>
                </div>
              </>
            )}
          </Match>
          <Match when={view()?.kind === "inUse" && row()}>
            {(r) => (
              <>
                <p class="confirm-body">
                  {t(r().archived ? "lists.inUseBodyArchived" : "lists.inUseBody", {
                    name: r().name,
                    entries: entriesText(count(r()) ?? 0),
                  })}
                </p>
                {errorText()}
                <div class="confirm-actions">
                  <button type="button" class="btn btn-secondary" onClick={close}>
                    {t("lists.cancel")}
                  </button>
                  <Show when={!r().archived}>
                    <button
                      type="button"
                      class="btn btn-secondary"
                      disabled={busy() || lastActive()}
                      onClick={() => toggleArchive(r())}
                    >
                      {t("lists.archive")}
                    </button>
                  </Show>
                  <button
                    type="button"
                    class="btn btn-primary"
                    disabled={others().length === 0 || lastActive()}
                    onClick={() => openMerge(r().id)}
                  >
                    {t("lists.mergeAction")}
                  </button>
                </div>
              </>
            )}
          </Match>
        </Switch>
      </Dialog>
    </>
  );
}
