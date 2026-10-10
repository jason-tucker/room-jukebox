import lockup from '../assets/developed-with-youtube.svg?raw';
import { watchUrl } from '../lib/youtube.ts';
import { S } from '../strings.ts';

/**
 * The one "developed with YouTube" lockup, shown wherever YouTube data is listed (results, Now
 * Playing, queue, admin lists). Clickable: opens the current video on youtube.com, or youtube.com.
 */
export function YouTubeAttribution({
  videoId,
  className = '',
  link = true,
}: {
  videoId?: string | null;
  className?: string;
  /** False on the TV, where clicking would navigate the kiosk window away. */
  link?: boolean;
}) {
  if (!link) {
    return (
      <span
        role="img"
        aria-label={S.attribution.label}
        data-testid="yt-attribution"
        className={`block h-7 w-[137px] [&>svg]:h-full [&>svg]:w-full ${className}`}
        dangerouslySetInnerHTML={{ __html: lockup }}
      />
    );
  }
  return (
    <a
      href={watchUrl(videoId)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={videoId ? S.attribution.openVideo : S.attribution.label}
      title={S.attribution.label}
      data-testid="yt-attribution"
      className={`inline-flex min-h-11 items-center text-fg ${className}`}
    >
      <span
        aria-hidden
        className="block h-7 w-[137px] [&>svg]:h-full [&>svg]:w-full"
        // Local, static asset (src/assets); no user content.
        dangerouslySetInnerHTML={{ __html: lockup }}
      />
    </a>
  );
}
