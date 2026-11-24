import { A } from "@solidjs/router";
import { createEffect, onMount, type ParentProps, Show } from "solid-js";
import { t } from "../i18n";
import { ChevronLeftIcon } from "./icons";

/** Keeps the document title as "<title> · Budgee". */
export function useDocumentTitle(title: () => string): void {
  createEffect(() => {
    document.title = `${title()} · ${t("app.name")}`;
  });
}

/**
 * A ref for a full-screen form's heading (with tabindex="-1"): focused once the screen is shown,
 * so keyboard and screen reader users start at the new screen's title.
 */
export function focusOnArrival(el: HTMLElement): void {
  onMount(() => el.focus({ preventScroll: true }));
}

/**
 * A screen's frame: its title (also the document title) and content. A sub-screen (e.g.
 * Settings → Categories) has a back link before its title.
 */
export function Screen(
  props: ParentProps<{ title: string; back?: { href: string; label: string }; class?: string }>,
) {
  useDocumentTitle(() => props.title);
  return (
    <div class={props.class ? `screen ${props.class}` : "screen"}>
      <header class="screen-header" classList={{ "screen-header-back": !!props.back }}>
        <Show when={props.back}>
          {(back) => (
            <A href={back().href} class="screen-back" aria-label={back().label}>
              <ChevronLeftIcon size={20} />
            </A>
          )}
        </Show>
        <h1 class="screen-title">{props.title}</h1>
      </header>
      <div class="screen-body">{props.children}</div>
    </div>
  );
}
