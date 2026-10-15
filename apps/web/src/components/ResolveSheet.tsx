import type { ResolveReply } from '@room-jukebox/shared';
import { reasonText, type MessageContext } from '../lib/messages.ts';
import { durationText, S } from '../strings.ts';
import { btn, Notice, Sheet } from './ui.tsx';
import { thumbFor } from './VideoRow.tsx';
import { YouTubeAttribution } from './YouTubeAttribution.tsx';

/** "Request this song?" sheet: thumbnail, title, length, verdict, one confirm button. */
export function ResolveSheet({
  video,
  onConfirm,
  onClose,
  busy = false,
  checking = false,
  error = null,
  owner = false,
  ctx = {},
}: {
  video: ResolveReply;
  onConfirm: () => void;
  onClose: () => void;
  busy?: boolean;
  /** The verdict is still loading: show the title, hold the confirm button. */
  checking?: boolean;
  error?: string | null;
  owner?: boolean;
  ctx?: MessageContext;
}) {
  return (
    <Sheet title={owner ? S.sheet.ownerTitle : S.sheet.title} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <img
          src={thumbFor(video.videoId, video.thumbnail)}
          alt=""
          className={`aspect-video w-full rounded-2xl bg-surface-2 object-cover ${video.playable || checking ? '' : 'opacity-60 grayscale'}`}
        />
        <div className="flex flex-col gap-1">
          <div className="text-xl leading-snug font-bold break-words">{video.title}</div>
          {video.channelTitle && (
            <div className="text-base text-muted">{S.sheet.by(video.channelTitle)}</div>
          )}
          {!checking && (
            <div className="text-base text-muted">{durationText(video.durationSec)}</div>
          )}
        </div>
        {checking ? (
          <Notice>{S.sheet.checking}</Notice>
        ) : video.playable ? (
          <Notice>{S.sheet.playable}</Notice>
        ) : (
          <Notice tone="error">{reasonText(video, ctx)}</Notice>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        <button
          type="button"
          className={`${btn.primary} w-full`}
          disabled={checking || !video.playable || busy}
          onClick={onConfirm}
        >
          {busy ? S.app.working : owner ? S.sheet.ownerConfirm : S.sheet.confirm}
        </button>
        <div className="flex items-center justify-between gap-2">
          <button type="button" className={btn.ghost} onClick={onClose}>
            {S.app.cancel}
          </button>
          <YouTubeAttribution videoId={video.videoId} />
        </div>
      </div>
    </Sheet>
  );
}
