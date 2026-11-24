// A modal confirmation on the native <dialog>: focus moves into it (to the safe choice) and
// back when it closes; Escape cancels. When it opens, or its `view` changes (a second, sterner
// step), focus goes to Cancel again and the confirm button ignores clicks for a moment, so a
// double tap on the previous step's button can't confirm the next one.
import { createEffect, createUniqueId, on } from "solid-js";

/** How long the confirm button ignores clicks after the dialog opens or changes step. */
export const CONFIRM_ARM_MS = 400;

export function ConfirmDialog(props: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  /** Draws the confirm button as destructive (Delete, Discard). */
  destructive?: boolean;
  /** Changes when the dialog moves to another step with the same buttons. */
  view?: string | undefined;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const id = createUniqueId();
  let dialog!: HTMLDialogElement;
  let cancel!: HTMLButtonElement;

  let armedAt = 0;

  createEffect(
    on(
      () => [props.open, props.view] as const,
      ([open]) => {
        if (open) {
          if (!dialog.open) dialog.showModal();
          cancel.focus();
          armedAt = Date.now() + CONFIRM_ARM_MS;
        } else if (dialog.open) dialog.close();
      },
    ),
  );

  return (
    <dialog
      ref={dialog}
      class="confirm"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-body`}
      onCancel={(event) => {
        event.preventDefault();
        props.onCancel();
      }}
    >
      <h2 id={`${id}-title`} class="confirm-title">
        {props.title}
      </h2>
      <p id={`${id}-body`} class="confirm-body">
        {props.body}
      </p>
      <div class="confirm-actions">
        <button type="button" ref={cancel} class="btn btn-secondary" onClick={props.onCancel}>
          {props.cancelLabel}
        </button>
        <button
          type="button"
          class={props.destructive ? "btn btn-danger confirm-danger" : "btn btn-primary"}
          onClick={() => {
            if (Date.now() >= armedAt) props.onConfirm();
          }}
        >
          {props.confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
