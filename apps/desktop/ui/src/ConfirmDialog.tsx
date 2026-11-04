import { useEffect, useRef, type ReactNode } from 'react';

/** Explicit consent, never an automatic approval or a hidden default. */
export function ConfirmDialog({ open, title, children, approve, busy, onApprove, onCancel }: { open: boolean; title: string; children: ReactNode; approve: string; busy: boolean; onApprove(): void; onCancel(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; if (open && dialog && !dialog.open) dialog.showModal(); return () => { if (dialog?.open) dialog.close(); }; }, [open]);
  return <dialog ref={ref} className="confirm-dialog" aria-label={title} onCancel={e => { e.preventDefault(); if (!busy) onCancel(); }}>
    <h2>{title}</h2>{children}<div className="confirm-actions"><button disabled={busy} onClick={onCancel}>취소</button><button className="primary-action" disabled={busy} onClick={onApprove}>{busy ? '처리 중…' : approve}</button></div>
  </dialog>;
}
