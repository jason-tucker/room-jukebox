import type { PrivacyReply } from '@room-jukebox/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { GuestFooter } from '../components/GuestChrome.tsx';
import { Notice, Spinner, TopBar } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { PRIVACY_FALLBACK, S } from '../strings.ts';

/** Turns bare https:// URLs in plain policy text into links. */
function linkify(text: string): ReactNode[] {
  return text.split(/(https?:\/\/[^\s)]+[^\s).,;])/g).map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a
        key={i}
        href={part}
        target="_blank"
        rel="noopener noreferrer"
        className="break-all text-accent underline"
      >
        {part}
      </a>
    ) : (
      part
    ),
  );
}

export function Privacy() {
  const [doc, setDoc] = useState<PrivacyReply | null>(null);
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    let live = true;
    void api.guest.privacy().then((r) => {
      if (!live) return;
      if (r.ok && r.data.sections.length > 0) setDoc(r.data);
      else {
        setDoc({ updatedAt: PRIVACY_FALLBACK.updatedAt, sections: [...PRIVACY_FALLBACK.sections] });
        setFallback(true);
      }
    });
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="min-h-screen bg-bg text-fg">
      <TopBar title={S.privacy.title} />
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-4">
        <Link
          to="/"
          className="inline-flex min-h-11 items-center self-start text-base text-accent underline"
        >
          {S.privacy.back}
        </Link>
        {!doc ? (
          <Spinner />
        ) : (
          <>
            {fallback && <Notice>{S.privacy.fallbackNote}</Notice>}
            <p className="text-base text-muted">{S.privacy.updated(doc.updatedAt)}</p>
            {doc.sections.map((s) => (
              <section key={s.heading} className="flex flex-col gap-2">
                <h2 className="text-xl font-bold">{s.heading}</h2>
                <p className="text-lg whitespace-pre-line">{linkify(s.body)}</p>
              </section>
            ))}
          </>
        )}
        <GuestFooter />
      </main>
    </div>
  );
}
