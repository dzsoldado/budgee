// A modal on the native <dialog>, like ConfirmDialog but with any content (a name field, a
// merge target). Each time it opens or its `view` changes, focus moves to the element marked
// `data-autofocus` (else the first button); Escape calls onClose; focus returns on close.
import { createEffect, createUniqueId, on, type ParentProps } from "solid-js";

export function Dialog(
  props: ParentProps<{
    open: boolean;
    title: string;
    /** Changes when the content is swapped (edit → merge), to move focus into the new one. */
    view?: string | undefined;
    onClose: () => void;
  }>,
) {
  const id = createUniqueId();
  let dialog!: HTMLDialogElement;

  createEffect(
    on(
      () => [props.open, props.view] as const,
      ([open]) => {
        if (!open) {
          if (dialog.open) dialog.close();
          return;
        }
        if (!dialog.open) dialog.showModal();
        const target =
          dialog.querySelector<HTMLElement>("[data-autofocus]") ?? dialog.querySelector("button");
        target?.focus();
      },
    ),
  );

  return (
    <dialog
      ref={dialog}
      class="confirm"
      aria-labelledby={`${id}-title`}
      onCancel={(event) => {
        event.preventDefault();
        props.onClose();
      }}
    >
      <h2 id={`${id}-title`} class="confirm-title">
        {props.title}
      </h2>
      {props.children}
    </dialog>
  );
}
