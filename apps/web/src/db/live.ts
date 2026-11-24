import { liveQuery } from "dexie";
import { type Accessor, createEffect, createSignal, on, onCleanup } from "solid-js";

/**
 * A Dexie live query as a Solid signal: undefined until the first result, then updated
 * whenever the tables it read change. With a `source`, the query re-subscribes when the
 * source changes (the last result stays until the new one arrives). Unsubscribes on dispose.
 */
export function createLiveQuery<T>(querier: () => T | Promise<T>): Accessor<T | undefined>;
export function createLiveQuery<S, T>(
  source: Accessor<S>,
  querier: (source: S) => T | Promise<T>,
): Accessor<T | undefined>;
export function createLiveQuery<S, T>(
  sourceOrQuerier: Accessor<S> | (() => T | Promise<T>),
  maybeQuerier?: (source: S) => T | Promise<T>,
): Accessor<T | undefined> {
  const [value, setValue] = createSignal<T | undefined>(undefined);
  const source = maybeQuerier ? (sourceOrQuerier as Accessor<S>) : () => undefined as S;
  const querier = maybeQuerier ?? (sourceOrQuerier as () => T | Promise<T>);

  createEffect(
    on(source, (current) => {
      const subscription = liveQuery(() => querier(current)).subscribe({
        next: (result) => setValue(() => result),
        error: (error) => console.error("Live query failed", error),
      });
      onCleanup(() => subscription.unsubscribe());
    }),
  );
  return value;
}
