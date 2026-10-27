import type { PartyState, Track } from '@dj-sync/shared';

function statusLabel(t: Track): { text: string; cls: string } {
  if (t.isFallback) return { text: 'lo-fi', cls: 'ready' };
  switch (t.status) {
    case 'resolving':
      return { text: 'готовим', cls: 'resolving' };
    case 'ready':
      return { text: 'готов', cls: 'ready' };
    case 'playing':
      return { text: 'играет', cls: 'playing' };
    case 'paused':
      return { text: 'пауза', cls: 'ready' };
    case 'failed':
      return { text: 'ошибка', cls: 'failed' };
    default:
      return { text: t.status, cls: '' };
  }
}

export function QueueList({
  state,
  editable = false,
  onMove,
  onRemove,
  onPlay,
}: {
  state: PartyState | null;
  editable?: boolean;
  onMove?: (id: string, dir: 'up' | 'down') => void;
  onRemove?: (id: string) => void;
  onPlay?: (id: string) => void;
}) {
  const upcoming = state?.upcoming ?? [];
  const recent = state?.recent ?? [];
  const limit = state?.queueLimit ?? 1;

  return (
    <div className="card">
      <h2>
        Очередь · {upcoming.length}/{limit}
      </h2>
      {upcoming.length === 0 ? (
        <div className="empty">
          {editable
            ? 'Пусто. Гости могут добавить трек.'
            : `Пусто. Можно закинуть ${limit} трек(ов).`}
        </div>
      ) : (
        <div className="queue">
          {upcoming.map((t, i) => {
            const st = statusLabel(t);
            return (
              <div className="q-item" key={t.id}>
                <div className="q-num">{i + 1}</div>
                <div className="body">
                  <div className="t">{t.title}</div>
                  <div className="m">
                    {t.requestedBy}
                    {t.error ? ` · ${t.error.slice(0, 60)}` : ''}
                  </div>
                </div>
                <span className={`status-tag ${st.cls}`}>{st.text}</span>
                {editable && (
                  <div className="q-actions">
                    <button
                      type="button"
                      className="q-btn"
                      title="Вверх"
                      disabled={i === 0 || !onMove}
                      onClick={() => onMove?.(t.id, 'up')}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="q-btn"
                      title="Вниз"
                      disabled={i === upcoming.length - 1 || !onMove}
                      onClick={() => onMove?.(t.id, 'down')}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="q-btn"
                      title="Слушать сейчас"
                      disabled={!onPlay}
                      onClick={() => onPlay?.(t.id)}
                    >
                      ▶
                    </button>
                    <button
                      type="button"
                      className="q-btn danger"
                      title="Убрать"
                      disabled={!onRemove}
                      onClick={() => onRemove?.(t.id)}
                    >
                      ✕
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {recent.length > 0 && (
        <>
          <h2 style={{ marginTop: 18 }}>Недавно</h2>
          <div className="queue">
            {recent.slice(0, 8).map((t) => (
              <div className="q-item" key={t.id} style={{ opacity: 0.72 }}>
                <div className="q-num">✓</div>
                <div className="body">
                  <div className="t">{t.title}</div>
                  <div className="m">{t.requestedBy}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
