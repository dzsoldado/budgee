// Settings → Tags: every tag in use with its count. A tag is renamed, merged into another or
// deleted on every entry that carries it, in one repository write. Renaming onto another tag's
// name (ignoring case) asks to merge instead.
import {
  InvalidTagError,
  listTags,
  mergeTags,
  sameTag,
  type TagCount,
  type TagError,
  validateTag,
} from "@budgee/core";
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  Match,
  on,
  Show,
  Switch,
} from "solid-js";
import { Dialog } from "../../components/Dialog";
import { useApp } from "../../context";
import { createLiveQuery } from "../../db/live";
import { type MessageKey, t } from "../../i18n";
import {
  chartsFilteringOn,
  mergeTagInto,
  removeTag,
  renameTagEverywhere,
  tagCollision,
} from "../../settings/lists";
import { TagIcon } from "../../shell/icons";
import { Screen } from "../../shell/Screen";
import { createAnnouncer, createLiveEntries, entriesText, settingsBack } from "./common";

type View =
  | { kind: "edit"; tag: string }
  /** Renaming onto an existing tag: merge into it instead? */
  | { kind: "collide"; tag: string; into: string }
  | { kind: "merge"; tag: string }
  | { kind: "delete"; tag: string };

const TITLE: Record<View["kind"], MessageKey> = {
  edit: "tags.editTitle",
  collide: "tags.collideTitle",
  merge: "tags.mergeTitle",
  delete: "tags.deleteTitle",
};

const TAG_ERROR: Record<TagError, MessageKey> = {
  empty: "tags.errorEmpty",
  semicolon: "tags.errorSemicolon",
};

export function TagsScreen() {
  const { db, repo } = useApp();
  const entries = createLiveEntries(db);
  const charts = createLiveQuery(() => db.chart_configs.toArray());
  /** Charts limited to `tag`: they show nothing once it is deleted. */
  const chartCount = (tag: string) => chartsFilteringOn(charts() ?? [], tag);
  const tags = createMemo((): TagCount[] | undefined => {
    const rows = entries();
    return rows && listTags(rows);
  });
  const { region, announce } = createAnnouncer();
  const errorId = createUniqueId();

  const [view, setView] = createSignal<View>();
  const [name, setName] = createSignal("");
  const [target, setTarget] = createSignal("");
  const [error, setError] = createSignal<MessageKey>();
  const [busy, setBusy] = createSignal(false);

  /** The tag the dialog is about, as listed now. */
  const current = createMemo(() => {
    const v = view();
    return v && tags()?.find((c) => sameTag(c.tag, v.tag));
  });
  const others = createMemo(() => (tags() ?? []).filter((c) => !sameTag(c.tag, view()?.tag ?? "")));
  /** How many entries a merge of the current tag into `into` changes. */
  const mergeCount = (into: string) => {
    const v = view();
    return v ? mergeTags(entries() ?? [], [v.tag], into).length : 0;
  };

  const show = (next: View) => {
    setError(undefined);
    setView(next);
  };
  const close = () => {
    setError(undefined);
    setView(undefined);
  };
  // The tag went away elsewhere (its last entry deleted or edited): close its dialog.
  createEffect(() => {
    if (view() && tags() && !current()) close();
  });
  // A merge target that went away elsewhere is never used: the merge picks another one, the
  // collision prompt goes back to editing the name.
  createEffect(() => {
    const v = view();
    if (v?.kind === "merge" && !others().some((o) => o.tag === target())) {
      setTarget(others()[0]?.tag ?? "");
    }
    if (v?.kind === "collide" && tags() && !tags()?.some((c) => c.tag === v.into)) {
      show({ kind: "edit", tag: v.tag });
    }
  });
  const isTag = (tag: string) => !!tags()?.some((c) => c.tag === tag);

  // After a change the list re-renders: once it shows, focus goes to the tag the change landed
  // on, else to the row now at the old place, else to the back link.
  let refocus:
    | { tag: string | undefined; index: number; before: TagCount[] | undefined }
    | undefined;
  const applyRefocus = () => {
    if (!refocus || view() || tags() === refocus.before) return;
    const { tag, index } = refocus;
    refocus = undefined;
    const rows = [...document.querySelectorAll<HTMLButtonElement>(".settings .settings-item-main")];
    const byTag =
      tag === undefined ? undefined : rows.find((r) => sameTag(r.dataset.tag ?? "", tag));
    (
      byTag ??
      rows[Math.min(index, rows.length - 1)] ??
      document.querySelector<HTMLElement>(".screen-back")
    )?.focus();
  };
  createEffect(on(tags, applyRefocus, { defer: true }));
  const indexOf = (tag: string) =>
    Math.max(
      0,
      (tags() ?? []).findIndex((c) => sameTag(c.tag, tag)),
    );

  const openEdit = (tag: string) => {
    setName(tag);
    show({ kind: "edit", tag });
  };
  const openMerge = (tag: string) => {
    setTarget(others()[0]?.tag ?? "");
    show({ kind: "merge", tag });
  };

  const run = async (
    write: () => Promise<number>,
    done: (changed: number) => string,
    land: { tag: string | undefined; index: number },
  ) => {
    if (busy()) return;
    setBusy(true);
    setError(undefined);
    const before = tags();
    try {
      const changed = await write();
      refocus = { ...land, before };
      close();
      applyRefocus();
      announce(done(changed));
    } catch (failure) {
      if (failure instanceof InvalidTagError) setError(TAG_ERROR[failure.reason]);
      else {
        console.error("Saving the tag change failed", failure);
        setError("tags.errorSave");
      }
    } finally {
      setBusy(false);
    }
  };

  const save = (from: string) => {
    const checked = validateTag(name());
    if (!checked.ok) {
      setError(TAG_ERROR[checked.error]);
      return;
    }
    const to = checked.tag;
    if (to === from) {
      close();
      return;
    }
    const into = tagCollision(
      (tags() ?? []).map((c) => c.tag),
      from,
      to,
    );
    if (into !== undefined) {
      show({ kind: "collide", tag: from, into });
      return;
    }
    void run(
      () => renameTagEverywhere(db, repo, from, to),
      (n) => t("tags.renamedStatus", { name: to, entries: entriesText(n) }),
      { tag: to, index: indexOf(from) },
    );
  };
  const merge = (from: string, into: string) => {
    if (!isTag(into)) return;
    return run(
      () => mergeTagInto(db, repo, from, into),
      (n) => t("tags.mergedStatus", { name: from, target: into, entries: entriesText(n) }),
      { tag: into, index: indexOf(from) },
    );
  };
  const remove = (tag: string) =>
    run(
      () => removeTag(db, repo, tag),
      (n) => t("tags.deletedStatus", { name: tag, entries: entriesText(n) }),
      { tag: undefined, index: indexOf(tag) },
    );

  const errorText = () => (
    <p id={errorId} class="field-error" role="alert">
      {error() ? t(error() as MessageKey) : ""}
    </p>
  );
  const actions = (props: { back?: () => void; confirm: MessageKey; danger?: boolean }) => (
    <div class="confirm-actions">
      <button type="button" class="btn btn-secondary" onClick={props.back ?? close}>
        {t(props.back ? "lists.back" : "lists.cancel")}
      </button>
      <button
        type="submit"
        class={props.danger ? "btn btn-danger confirm-danger" : "btn btn-primary"}
        disabled={busy()}
      >
        {t(props.confirm)}
      </button>
    </div>
  );
  const submit = (handler: () => void) => (event: SubmitEvent) => {
    event.preventDefault();
    handler();
  };

  return (
    <Screen title={t("settings.tags")} back={settingsBack()} class="settings">
      <p class="settings-intro">{t("tags.intro")}</p>
      <Show when={tags()}>
        {(list) => (
          <Show
            when={list().length > 0}
            fallback={
              <div class="settings-card settings-empty">
                <p class="settings-empty-title">{t("tags.empty")}</p>
                <p class="hint">{t("tags.emptyHint")}</p>
              </div>
            }
          >
            <div class="settings-card">
              <ul class="settings-list" aria-label={t("settings.tags")}>
                <For each={list()}>
                  {(c) => (
                    <li class="settings-item">
                      <button
                        type="button"
                        class="settings-item-main settings-item-tag"
                        data-tag={c.tag}
                        aria-haspopup="dialog"
                        onClick={() => openEdit(c.tag)}
                      >
                        <span class="settings-item-icon">
                          <TagIcon size={16} />
                        </span>
                        <span class="settings-item-text">
                          <span class="settings-item-name">{c.tag}</span>
                          <span class="settings-item-meta">{entriesText(c.count)}</span>
                        </span>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </div>
          </Show>
        )}
      </Show>
      {region}

      <Dialog
        open={!!view()}
        view={view()?.kind}
        title={(() => {
          const v = view();
          if (!v) return "";
          return t(TITLE[v.kind], { name: v.tag, target: v.kind === "collide" ? v.into : "" });
        })()}
        onClose={close}
      >
        <Switch>
          <Match when={view()?.kind === "edit" && current()}>
            {(c) => (
              <form class="dialog-form" onSubmit={submit(() => save(c().tag))}>
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
                <p class="hint">{t("tags.renameHint", { entries: entriesText(c().count) })}</p>
                {errorText()}
                {actions({ confirm: "lists.save" })}
                <div class="dialog-more">
                  <button
                    type="button"
                    class="btn btn-secondary"
                    disabled={others().length === 0}
                    onClick={() => openMerge(c().tag)}
                  >
                    {t("lists.mergeAction")}
                  </button>
                  <button
                    type="button"
                    class="btn btn-danger"
                    onClick={() => show({ kind: "delete", tag: c().tag })}
                  >
                    {t("lists.delete")}
                  </button>
                </div>
              </form>
            )}
          </Match>
          <Match
            when={(() => {
              const v = view();
              return v?.kind === "collide" ? v : undefined;
            })()}
          >
            {(v) => (
              <form class="dialog-form" onSubmit={submit(() => merge(v().tag, v().into))}>
                <p class="confirm-body">
                  {t("tags.collideBody", {
                    name: v().tag,
                    target: v().into,
                    entries: entriesText(mergeCount(v().into)),
                  })}
                </p>
                {errorText()}
                {actions({
                  back: () => show({ kind: "edit", tag: v().tag }),
                  confirm: "lists.merge",
                  danger: true,
                })}
              </form>
            )}
          </Match>
          <Match when={view()?.kind === "merge" && current()}>
            {(c) => (
              <form class="dialog-form" onSubmit={submit(() => merge(c().tag, target()))}>
                <label class="field">
                  <span class="field-label">{t("lists.mergeInto")}</span>
                  <select
                    class="input select"
                    data-autofocus
                    value={target()}
                    onChange={(event) => setTarget(event.currentTarget.value)}
                  >
                    <For each={others()}>{(o) => <option value={o.tag}>{o.tag}</option>}</For>
                  </select>
                </label>
                <p class="confirm-body">
                  {t("tags.mergeBody", {
                    name: c().tag,
                    target: target(),
                    entries: entriesText(mergeCount(target())),
                  })}
                </p>
                {errorText()}
                {actions({ back: () => openEdit(c().tag), confirm: "lists.merge", danger: true })}
              </form>
            )}
          </Match>
          <Match when={view()?.kind === "delete" && current()}>
            {(c) => (
              <form class="dialog-form" onSubmit={submit(() => remove(c().tag))}>
                <p class="confirm-body">
                  {t("tags.deleteBody", { name: c().tag, entries: entriesText(c().count) })}
                </p>
                <Show when={chartCount(c().tag) > 0}>
                  <p class="confirm-body">
                    {chartCount(c().tag) === 1
                      ? t("tags.deleteChartsOne")
                      : t("tags.deleteChartsMany", { count: chartCount(c().tag) })}
                  </p>
                </Show>
                {errorText()}
                {actions({ confirm: "tags.deleteConfirm", danger: true })}
              </form>
            )}
          </Match>
        </Switch>
      </Dialog>
    </Screen>
  );
}
