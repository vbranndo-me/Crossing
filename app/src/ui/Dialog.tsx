import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

interface Props {
  title: string;
  /** Escape, the backdrop or a cancel button. */
  onClose(): void;
  /** Room for side-by-side content (a preview next to its settings). */
  wide?: boolean;
  /** A press outside does not close it: for dialogs with work in them that a stray click should not throw away. */
  staysOpen?: boolean;
  children: ReactNode;
}

/** A modal window. Built on <dialog>, which keeps focus inside and closes on Escape. */
export function Dialog({ title, onClose, wide, staysOpen, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current!;
    if (!el.open) el.showModal();
    return () => el.close();
  }, []);

  return (
    <dialog
      ref={ref}
      className={wide ? 'dialog wide' : 'dialog'}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      // A press on the backdrop lands on the <dialog> element itself.
      onPointerDown={(e) => !staysOpen && e.target === ref.current && onClose()}
    >
      <header className="dialog-title">{title}</header>
      <div className="dialog-body">{children}</div>
    </dialog>
  );
}
