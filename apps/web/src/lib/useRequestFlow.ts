import type { RequestReply, ResolveReply } from '@room-jukebox/shared';
import { useCallback, useState } from 'react';
import { S } from '../strings.ts';
import { api, type ApiResult } from './api.ts';
import { failureText, type MessageContext } from './messages.ts';
import { uuid } from './uuid.ts';
import { parseYouTubeInput } from './youtube.ts';

interface Pending {
  video: ResolveReply;
  /** One key per sheet, so a retried tap never queues the song twice. */
  idempotencyKey: string;
}

/**
 * Paste/resolve → "Request this song?" → POST, shared by the guest page and the admin "Add a
 * song". The caller renders `<ResolveSheet>` while `pending` is set.
 */
export function useRequestFlow({
  submit,
  onDone,
  ctx,
}: {
  submit: (videoId: string, idempotencyKey: string) => Promise<ApiResult<RequestReply>>;
  onDone: (reply: RequestReply) => void;
  ctx: MessageContext;
}) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [resolving, setResolving] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sheetError, setSheetError] = useState<string | null>(null);

  const open = useCallback((video: ResolveReply) => {
    setSheetError(null);
    setInputError(null);
    setPending({ video, idempotencyKey: uuid() });
  }, []);

  const openFromInput = useCallback(
    async (text: string): Promise<boolean> => {
      setInputError(null);
      const id = parseYouTubeInput(text);
      if (!id) {
        setInputError(S.guest.notYouTube);
        return false;
      }
      setResolving(true);
      const r = await api.guest.resolve(id);
      setResolving(false);
      if (!r.ok) {
        setInputError(failureText(r.error, ctx));
        return false;
      }
      open(r.data);
      return true;
    },
    [ctx, open],
  );

  const close = useCallback(() => {
    setPending(null);
    setSheetError(null);
    setBusy(false);
  }, []);

  const confirm = useCallback(async () => {
    if (!pending) return;
    setBusy(true);
    setSheetError(null);
    const r = await submit(pending.video.videoId, pending.idempotencyKey);
    setBusy(false);
    if (!r.ok) {
      setSheetError(failureText(r.error, ctx));
      return;
    }
    setPending(null);
    onDone(r.data);
  }, [ctx, onDone, pending, submit]);

  return {
    pending,
    resolving,
    inputError,
    setInputError,
    busy,
    sheetError,
    open,
    openFromInput,
    close,
    confirm,
  };
}
