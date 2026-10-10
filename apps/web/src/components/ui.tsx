import { useEffect, useId, useRef, type ReactNode } from 'react';
import { S } from '../strings.ts';

/** Shared class strings: every interactive element is at least 44 px tall (min-h-11 = 49.5 px). */
export const btn = {
  primary:
    'inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-accent px-6 py-2 text-lg font-semibold text-accent-fg hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50',
  secondary:
    'inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-full bg-surface-2 px-5 whitespace-nowrap py-2 text-base font-semibold text-fg hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50',
  ghost:
    'inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-full px-3 py-2 text-base text-fg hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40',
  danger:
    'inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-danger px-5 py-2 text-base font-semibold text-danger hover:bg-surface-2 disabled:opacity-50',
};

export const input =
  'min-h-11 w-full rounded-xl border border-line bg-bg px-4 py-2 text-base text-fg placeholder:text-muted focus:border-accent focus:outline-none';

export function TopBar({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <header className="sticky top-0 z-10 flex min-h-14 items-center gap-3 border-b border-line bg-bg/95 px-4 py-2 backdrop-blur">
      <span
        aria-hidden
        className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent text-accent-fg"
      >
        <svg viewBox="0 0 24 24" className="size-5" fill="currentColor">
          <path d="M9 18.5a2.5 2.5 0 1 1-2-2.45V5.5l11-2v11.5a2.5 2.5 0 1 1-2-2.45V7.1l-7 1.27Z" />
        </svg>
      </span>
      <h1 className="min-w-0 flex-1 truncate text-xl font-bold">{title}</h1>
      {right}
    </header>
  );
}

export function Section({
  title,
  children,
  right,
}: {
  title: string;
  children: ReactNode;
  right?: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id={id} className="text-xl font-bold">
          {title}
        </h2>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Chip({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'danger';
}) {
  const cls =
    tone === 'accent'
      ? 'bg-accent-soft text-fg'
      : tone === 'danger'
        ? 'bg-surface-2 text-danger'
        : 'bg-surface-2 text-fg';
  return (
    <span
      className={`inline-flex items-center rounded-lg px-2 py-0.5 text-base font-medium ${cls}`}
    >
      {children}
    </span>
  );
}

export function Notice({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn' | 'error';
  children: ReactNode;
}) {
  const cls =
    tone === 'warn'
      ? 'bg-warn-soft text-warn-fg'
      : tone === 'error'
        ? 'border border-danger text-fg'
        : 'bg-surface text-fg';
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`rounded-xl px-4 py-3 text-base ${cls}`}
    >
      {tone === 'error' && (
        <span
          aria-hidden
          className="mr-2 inline-block size-2.5 rounded-full bg-danger align-middle"
        />
      )}
      {children}
    </div>
  );
}

/**
 * Bottom sheet on phones, centred dialog on wide screens. Fixed overlay, so opening or closing it
 * never shifts the page underneath.
 */
export function Sheet({
  title,
  onClose,
  children,
  dismissable = true,
}: {
  title: string;
  onClose?: () => void;
  children: ReactNode;
  dismissable?: boolean;
}) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panel.current?.focus();
    if (!dismissable || !onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dismissable, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-backdrop sm:items-center">
      {dismissable && onClose && (
        <button
          type="button"
          aria-label={S.app.close}
          className="absolute inset-0 cursor-default"
          onClick={onClose}
        />
      )}
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        tabIndex={-1}
        className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-bg p-5 shadow-xl outline-none sm:rounded-3xl"
      >
        <h2 id={id} className="mb-4 text-2xl font-bold">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-base font-semibold">{label}</span>
      {children}
      {hint && <span className="text-base text-muted">{hint}</span>}
    </label>
  );
}

export function Spinner({ label = S.app.loading }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-3 py-4 text-base text-muted">
      <span
        aria-hidden
        className="size-5 animate-spin rounded-full border-2 border-line border-t-accent"
      />
      {label}
    </div>
  );
}
