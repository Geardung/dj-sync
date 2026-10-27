import { useEffect } from 'react';
import type { PartyState, Track } from '@dj-sync/shared';

function statusLabel(t: Track): string {
  if (t.isFallback) return 'lo-fi';
  switch (t.status) {
    case 'resolving':
      return 'готовим';
    case 'ready':
      return 'готов';
    case 'playing':
      return 'играет';
    case 'paused':
      return 'пауза';
    case 'failed':
      return 'ошибка';
    default:
      return t.status;
  }
}

export function QueueSheet({
  state,
  onClose,
}: {
  state: PartyState | null;
  onClose: () => void;
}) {
  const upcoming = state?.upcoming ?? [];
  const recent = state?.recent ?? [];
  const limit = state?.queueLimit ?? 1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      className="sheet-backdrop"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="sheet"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Очередь"
      >
        <div className="sheet-top">
          <button type="button" className="sheet-handle" onClick={onClose} aria-label="Закрыть очередь" />
          <div className="sheet-head">
            <h2>Очередь</h2>
            <button
              type="button"
              className="sheet-close"
              onClick={onClose}
              aria-label="Закрыть"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="sheet-body">
          <div className="sheet-meta">
            {upcoming.length}/{limit} · играющий не в счёте
          </div>

          {upcoming.length === 0 ? (
            <div className="empty">Пусто. Кинь трек через поиск ниже.</div>
          ) : (
            <div className="queue">
              {upcoming.map((t, i) => (
                <div className="q-item" key={t.id}>
                  <div className="q-num">{i + 1}</div>
                  <div className="body">
                    <div className="t">{t.title}</div>
                    <div className="m">
                      {t.requestedBy} · {statusLabel(t)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {recent.length > 0 && (
            <>
              <div className="sheet-sub">Уже прозвучало</div>
              <div className="queue">
                {recent.slice(0, 12).map((t) => (
                  <div className="q-item" key={t.id} style={{ opacity: 0.7 }}>
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
      </div>
    </div>
  );
}

export function QueueButton({
  count,
  onClick,
}: {
  count: number;
  onClick: () => void;
}) {
  return (
    <button type="button" className="queue-btn" onClick={onClick} aria-label="Очередь">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M4 6h16M4 12h10M4 18h13"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <circle cx="19" cy="12" r="2.2" fill="currentColor" />
      </svg>
      <span>Очередь</span>
      {count > 0 && <em>{count}</em>}
    </button>
  );
}
