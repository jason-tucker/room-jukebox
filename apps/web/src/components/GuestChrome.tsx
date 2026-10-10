import { Link } from 'react-router';
import { LINKS, S } from '../strings.ts';
import { btn, Sheet } from './ui.tsx';

/** First-visit notice: both links, one Continue. A fixed overlay, so closing it shifts nothing. */
export function NoticeModal({ onContinue }: { onContinue: () => void }) {
  return (
    <Sheet title={S.notice.title} dismissable={false}>
      <p className="mb-5 text-lg">
        {S.notice.bodyBefore}
        <a
          className="font-semibold text-accent underline"
          href={LINKS.youtubeTerms}
          target="_blank"
          rel="noopener noreferrer"
        >
          {S.notice.terms}
        </a>
        {S.notice.bodyMiddle}
        <Link className="font-semibold text-accent underline" to="/privacy">
          {S.notice.privacy}
        </Link>
        {S.notice.bodyAfter}
      </p>
      <button type="button" className={`${btn.primary} w-full`} onClick={onContinue}>
        {S.notice.continue}
      </button>
    </Sheet>
  );
}

const footLink =
  'inline-flex min-h-11 items-center text-base text-muted underline underline-offset-4';

/** Footer on guest pages: YouTube Terms, Google privacy, our privacy; optional extra menu items. */
export function GuestFooter({ onForget }: { onForget?: () => void }) {
  return (
    <footer className="mt-6 flex flex-col gap-1 border-t border-line pt-4 pb-8">
      <nav aria-label="Legal" className="flex flex-wrap gap-x-5">
        <a className={footLink} href={LINKS.youtubeTerms} target="_blank" rel="noopener noreferrer">
          {S.footer.terms}
        </a>
        <a
          className={footLink}
          href={LINKS.googlePrivacy}
          target="_blank"
          rel="noopener noreferrer"
        >
          {S.footer.googlePrivacy}
        </a>
        <Link className={footLink} to="/privacy">
          {S.footer.privacy}
        </Link>
      </nav>
      {onForget && (
        <details className="text-base">
          <summary className="inline-flex min-h-11 cursor-pointer items-center text-muted">
            {S.footer.more}
          </summary>
          <div className="flex flex-col items-start gap-2 py-2">
            <button type="button" className={btn.danger} onClick={onForget}>
              {S.guest.forgetMe}
            </button>
          </div>
        </details>
      )}
      <Link to="/admin" className={`${footLink} mt-2 self-start`}>
        {S.footer.ownerLogin}
      </Link>
    </footer>
  );
}

export function ForgetDoneSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet title={S.guest.forgetMe} onClose={onClose}>
      <p className="mb-3 text-lg">{S.guest.forgetDone}</p>
      <p className="mb-5 text-lg">
        {S.guest.forgetYouTubeLine}.{' '}
        <a
          className="font-semibold text-accent underline"
          href={LINKS.googleActivity}
          target="_blank"
          rel="noopener noreferrer"
        >
          {S.guest.forgetYouTubeLink}
        </a>
      </p>
      <button type="button" className={`${btn.primary} w-full`} onClick={onClose}>
        {S.app.close}
      </button>
    </Sheet>
  );
}

/** The three request steps as simple pictures (generic icons, no YouTube marks). */
export function StepsStrip() {
  const icons = [
    // magnifier
    <path
      key="s"
      d="M10.5 3a7.5 7.5 0 0 1 5.96 12.05l4.25 4.24-1.42 1.42-4.24-4.25A7.5 7.5 0 1 1 10.5 3Zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z"
    />,
    // share arrow
    <path key="h" d="M14 4l7 7-7 7v-4.1c-5 0-8.5 1.6-11 5.1 1-5 4-10 11-11V4Z" />,
    // link
    <path
      key="l"
      d="M10.6 13.4a1 1 0 0 1 0-1.4l3.5-3.5a1 1 0 1 1 1.4 1.4L12 13.4a1 1 0 0 1-1.4 0ZM8.5 20a4.5 4.5 0 0 1-3.2-7.7l2.5-2.5 1.4 1.4-2.5 2.5a2.5 2.5 0 0 0 3.5 3.5l2.5-2.5 1.4 1.4-2.5 2.5A4.5 4.5 0 0 1 8.5 20Zm8.1-5.8-1.4-1.4 2.5-2.5a2.5 2.5 0 1 0-3.5-3.5l-2.5 2.5-1.4-1.4 2.5-2.5a4.5 4.5 0 0 1 6.4 6.3l-2.6 2.5Z"
    />,
  ];
  return (
    <ol className="grid grid-cols-1 gap-2 min-[520px]:grid-cols-3">
      {S.guest.steps.map((step, i) => (
        <li
          key={step.title}
          className="flex items-center gap-3 rounded-2xl bg-surface p-3 min-[520px]:flex-col min-[520px]:text-center"
        >
          <span
            aria-hidden
            className="grid size-12 shrink-0 place-items-center rounded-full bg-accent-soft text-accent"
          >
            <svg viewBox="0 0 24 24" className="size-7" fill="currentColor">
              {icons[i]}
            </svg>
          </span>
          <span className="flex flex-col gap-1">
            <span className="text-base font-bold">
              {i + 1}. {step.title}
            </span>
            <span className="text-base leading-snug text-muted">{step.body}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
