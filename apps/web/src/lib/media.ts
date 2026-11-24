import { type Accessor, createSignal, onCleanup } from "solid-js";

/** Whether a media query matches, updated live. Call inside a component or root. */
export function createMediaQuery(query: string): Accessor<boolean> {
  const list = window.matchMedia(query);
  const [matches, setMatches] = createSignal(list.matches);
  const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
  list.addEventListener("change", onChange);
  onCleanup(() => list.removeEventListener("change", onChange));
  return matches;
}

/** Sidebar layout from here up; keep in step with the 1024px media queries in the CSS. */
export const WIDE_QUERY = "(min-width: 1024px)";
