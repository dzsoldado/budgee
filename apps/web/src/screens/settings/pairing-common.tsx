// Shared by the Connect, Pair and Restore screens and the Sync section of Settings.
import { A } from "@solidjs/router";
import { createUniqueId, type JSX, Show } from "solid-js";
import type { BudgeeDb } from "../../db/db";
import { createLiveQuery } from "../../db/live";
import { t } from "../../i18n";
import { readPairing } from "../../sync/controller";

/** This device's pairing, live: undefined while loading, null when not paired. */
export function createLivePairing(db: BudgeeDb) {
  return createLiveQuery(async () => (await readPairing(db)) ?? null);
}

/** The host of a server address for messages ("budgee.example"), or the text as typed. */
export function hostOf(serverUrl: string): string {
  try {
    return new URL(serverUrl.trim()).host;
  } catch {
    return serverUrl.trim();
  }
}

/** A labelled text field with an optional hint under it. */
export function Field(
  props: {
    label: string;
    hint?: string;
    value: string;
    onInput: (value: string) => void;
    invalid?: boolean;
    /** Shown under the field, which is then marked invalid. */
    error?: string | undefined;
    /** Extra class on the input, e.g. `input-code`. */
    inputClass?: string;
  } & Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "value" | "onInput">,
) {
  const id = createUniqueId();
  return (
    <div class="field">
      <label class="field-label" for={id}>
        {props.label}
      </label>
      <input
        id={id}
        class={props.inputClass ? `input ${props.inputClass}` : "input"}
        type={props.type ?? "text"}
        required={props.required}
        autocomplete={props.autocomplete}
        autocapitalize={props.autocapitalize}
        spellcheck={props.spellcheck}
        inputmode={props.inputmode}
        maxLength={props.maxLength}
        data-autofocus={props.autofocus ? "" : undefined}
        aria-invalid={props.invalid || props.error ? "true" : undefined}
        aria-describedby={
          [props.hint ? `${id}-hint` : "", props.error ? `${id}-error` : ""].join(" ").trim() ||
          undefined
        }
        value={props.value}
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
      <Show when={props.hint}>
        {(hint) => (
          <p id={`${id}-hint`} class="hint">
            {hint()}
          </p>
        )}
      </Show>
      <Show when={props.error}>
        {(error) => (
          <p id={`${id}-error`} class="field-error">
            {error()}
          </p>
        )}
      </Show>
    </div>
  );
}

/**
 * The trimmed device name, or undefined after showing `setError` the reason it can't be used.
 * The server takes 1 to 100 characters.
 */
export function checkDeviceName(name: string, setError: (text: string | undefined) => void) {
  const trimmed = name.trim();
  if (trimmed === "") {
    setError(t("pairing.deviceNameEmpty"));
    return undefined;
  }
  setError(undefined);
  return trimmed;
}

/** Shown instead of a pairing form on a device that is already paired. */
export function AlreadyPaired(props: { serverUrl: string }) {
  return (
    <div class="card stack">
      <p class="pair-text">{t("pairing.alreadyPaired", { host: hostOf(props.serverUrl) })}</p>
      <p class="hint">{t("pairing.alreadyPairedHint")}</p>
      <A href="/settings" class="btn btn-secondary pair-wide">
        {t("pairing.backToSettings")}
      </A>
    </div>
  );
}
