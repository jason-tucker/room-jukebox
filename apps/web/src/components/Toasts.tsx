import { useCallback, useEffect, useRef, useState } from 'react';

export interface ToastItem {
  id: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  const push = useCallback((message: string, level: ToastItem['level'] = 'info', ttlMs = 4000) => {
    const id = next.current++;
    setToasts((t) => [...t.slice(-2), { id, level, message }]);
    const timer = setTimeout(
      () => {
        timers.current.delete(timer);
        setToasts((t) => t.filter((x) => x.id !== id));
      },
      Math.max(1500, ttlMs),
    );
    timers.current.add(timer);
  }, []);

  useEffect(() => {
    const set = timers.current;
    return () => {
      for (const t of set) clearTimeout(t);
    };
  }, []);

  return { toasts, push };
}

/** Bottom-centred, fixed (no layout shift), announced politely to screen readers. */
export function ToastHost({ toasts }: { toasts: ToastItem[] }) {
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex flex-col items-center gap-2 px-4"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className="flex max-w-md items-center gap-2 rounded-2xl bg-fg px-4 py-3 text-base text-bg shadow-lg"
        >
          {t.level !== 'info' && (
            <span
              aria-hidden
              className={`size-2.5 shrink-0 rounded-full ${t.level === 'error' ? 'bg-danger' : 'bg-amber-400'}`}
            />
          )}
          {t.message}
        </div>
      ))}
    </div>
  );
}
