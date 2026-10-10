import QRCode from 'qrcode';
import { useEffect, useState } from 'react';

/** SVG markup for `value` (qrcode's own SVG renderer; no canvas, no network). */
export function qrSvg(value: string): Promise<string> {
  return QRCode.toString(value, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 2,
    color: { dark: '#000000', light: '#ffffff' },
  });
}

/**
 * A QR code drawn as inline SVG on a white tile (phone cameras need dark-on-light, also in dark
 * mode). `label` is the accessible name and the caption.
 */
export function QrCode({
  value,
  label,
  size = 220,
}: {
  value: string;
  label: string;
  size?: number | string;
}) {
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    qrSvg(value).then(
      (s) => {
        if (live) setSvg(s);
      },
      () => {
        if (live) setSvg(null);
      },
    );
    return () => {
      live = false;
    };
  }, [value]);

  return (
    <figure className="flex flex-col items-center gap-2">
      <div
        role="img"
        aria-label={label}
        className="rounded-xl bg-white p-1 [&>svg]:h-full [&>svg]:w-full"
        style={{ width: size, height: size }}
        // qrcode's output is generated locally from `value`; it contains no user markup.
        dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
      />
      <figcaption className="text-center font-semibold">{label}</figcaption>
    </figure>
  );
}
