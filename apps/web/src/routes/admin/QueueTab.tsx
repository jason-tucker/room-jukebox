import type { EntryAdmin } from '@room-jukebox/shared';
import { QueueList } from '../../components/QueueList.tsx';
import { btn } from '../../components/ui.tsx';
import { api } from '../../lib/api.ts';
import { uuid } from '../../lib/uuid.ts';
import { S } from '../../strings.ts';
import type { TabProps } from './common.ts';

export function QueueTab({ state, run }: TabProps) {
  const queue = state.queue;

  const move = (e: EntryAdmin, toIndex: number) =>
    void run(api.admin.reorder({ id: e.id, toIndex, idempotencyKey: uuid() }));

  const remove = (e: EntryAdmin) => {
    if (window.confirm(S.admin.removeConfirm(e.title))) void run(api.admin.removeEntry(e.id));
  };

  const deleteGuest = (e: EntryAdmin) => {
    if (!e.requesterGuestId) return;
    if (!window.confirm(S.admin.deleteGuestConfirm(e.requesterName ?? e.requesterGuestId))) return;
    void run(api.admin.deleteGuest(e.requesterGuestId), S.admin.guestDeleted);
  };

  const guestButton = (e: EntryAdmin) =>
    e.requesterGuestId ? (
      <button type="button" className={btn.ghost} onClick={() => deleteGuest(e)}>
        {S.admin.deleteGuest}
      </button>
    ) : null;

  return (
    <>
      <QueueList
        entries={queue}
        title={S.admin.queue}
        empty={S.guest.queueEmpty}
        actions={(e, i) => (
          <>
            {guestButton(e)}
            <button
              type="button"
              className={btn.ghost}
              aria-label={`${S.admin.moveUp}: ${e.title}`}
              disabled={i === 0}
              onClick={() => move(e, i - 1)}
            >
              <svg aria-hidden viewBox="0 0 24 24" className="size-6" fill="currentColor">
                <path d="M12 7l6 6-1.4 1.4L12 9.8l-4.6 4.6L6 13z" />
              </svg>
            </button>
            <button
              type="button"
              className={btn.ghost}
              aria-label={`${S.admin.moveDown}: ${e.title}`}
              disabled={i === queue.length - 1}
              onClick={() => move(e, i + 1)}
            >
              <svg aria-hidden viewBox="0 0 24 24" className="size-6" fill="currentColor">
                <path d="M12 17l-6-6 1.4-1.4 4.6 4.6 4.6-4.6L18 11z" />
              </svg>
            </button>
            <button
              type="button"
              className={btn.danger}
              aria-label={`${S.app.remove}: ${e.title}`}
              onClick={() => remove(e)}
            >
              <svg aria-hidden viewBox="0 0 24 24" className="size-5" fill="currentColor">
                <path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L12 13.4l-6.3 6.3-1.4-1.4L10.6 12 4.3 5.7l1.4-1.4L12 10.6l6.3-6.3z" />
              </svg>
              <span aria-hidden>{S.app.remove}</span>
            </button>
          </>
        )}
      />
      <QueueList
        entries={state.recentHistory}
        title={S.admin.history}
        numbered={false}
        actions={(e) => guestButton(e)}
      />
    </>
  );
}
