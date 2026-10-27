import { useEffect, useRef, useState } from 'react';
import type { SearchHit } from '@dj-sync/shared';
import { searchTracks, submitFile } from '../api';

type Phase = 'idle' | 'searching' | 'results' | 'adding' | 'success' | 'error';

/** party cap — hide anything longer */
const MAX_DURATION_SEC = 300;

export function SearchAdd({
  onSubmitUrl,
  onSubmitTitle,
  queuePosition,
}: {
  onSubmitUrl: (url: string) => Promise<{ queueIndex?: number; queueTotal?: number } | void>;
  onSubmitTitle: (title: string) => Promise<{ queueIndex?: number; queueTotal?: number } | void>;
  queuePosition?: { index: number; total: number };
}) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [statusSub, setStatusSub] = useState('');
  const [statusCover, setStatusCover] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // seq: ignore stale search responses; busy: don't re-search while adding/success
  const searchSeq = useRef(0);
  const busyRef = useRef(false);
  const lastQuery = useRef('');
  const hasResultsRef = useRef(false);

  // collapse the expanded search when the queue sheet opens
  useEffect(() => {
    const collapse = () => {
      setFocused(false);
      inputRef.current?.blur();
    };
    window.addEventListener('dj-search-collapse', collapse);
    return () => window.removeEventListener('dj-search-collapse', collapse);
  }, []);

  // while the input is focused, expose keyboard inset + visual viewport height
  // so the results panel can sit above the on-screen keyboard (iOS overlays it)
  useEffect(() => {
    const root = document.documentElement;
    if (!focused) {
      root.style.removeProperty('--kb-inset');
      root.style.removeProperty('--vv-height');
      return;
    }
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      root.style.setProperty('--kb-inset', `${inset}px`);
      root.style.setProperty('--vv-height', `${vv.height}px`);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      root.style.removeProperty('--kb-inset');
      root.style.removeProperty('--vv-height');
    };
  }, [focused]);

  // after the keyboard opens / results arrive, pin the search zone to the
  // document bottom so the whole panel lands above the keyboard
  useEffect(() => {
    if (!focused) return;
    const t = window.setTimeout(() => {
      window.scrollTo({ top: document.documentElement.scrollHeight });
    }, 320);
    return () => window.clearTimeout(t);
  }, [focused, phase, hits.length]);

  useEffect(() => {
    const query = q.trim();
    if (timer.current) window.clearTimeout(timer.current);
    if (busyRef.current) return;

    if (query.length < 2) {
      lastQuery.current = '';
      hasResultsRef.current = false;
      setHits([]);
      setPhase('idle');
      return;
    }

    // same query already shown — don't refetch (this was the jitter)
    if (query === lastQuery.current && hasResultsRef.current) {
      setPhase('results');
      return;
    }

    setPhase('searching');
    const seq = ++searchSeq.current;
    timer.current = window.setTimeout(async () => {
      try {
        const res = await searchTracks(query);
        if (seq !== searchSeq.current) return; // stale response
        lastQuery.current = query;
        // stable source order; drop anything over 5 minutes
        const list = res.results.filter(
          (h) => h.durationSec == null || h.durationSec <= MAX_DURATION_SEC
        );
        hasResultsRef.current = list.length > 0;
        setHits(list);
        setPhase('results');
        setError(null);
      } catch {
        if (seq !== searchSeq.current) return;
        hasResultsRef.current = false;
        setHits([]);
        setPhase('error');
        setError('Поиск не ответил');
      }
    }, 350);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [q, focused]);

  const resetToSearch = () => {
    busyRef.current = false;
    setPhase('idle');
    setStatusText('');
    setStatusSub('');
    setStatusCover(null);
    setQ('');
    setHits([]);
    lastQuery.current = '';
    hasResultsRef.current = false;
  };

  const add = async (
    fn: () => Promise<{ queueIndex?: number; queueTotal?: number } | void>,
    cover?: string | null
  ) => {
    busyRef.current = true;
    setPhase('adding');
    setStatusText('Загружаем ваш трек…');
    setStatusSub('');
    setStatusCover(cover ?? null);
    setError(null);
    try {
      const res = await fn();
      const idx = res?.queueIndex;
      const tot = res?.queueTotal;
      const pos =
        idx && tot
          ? `Ваш трек в очереди ${idx} из ${tot}`
          : queuePosition
            ? `Ваш трек в очереди ${Math.min(queuePosition.index + 1, queuePosition.total)} из ${queuePosition.total}`
            : 'Ваш трек в очереди';
      setPhase('success');
      setStatusText('Успешно!');
      setStatusSub(pos);
      setQ('');
      setHits([]);
      lastQuery.current = '';
      hasResultsRef.current = false;
      window.setTimeout(() => {
        setPhase((p) => {
          if (p === 'success') {
            busyRef.current = false;
            return 'idle';
          }
          return p;
        });
        setStatusText('');
        setStatusSub('');
        setStatusCover(null);
      }, 3400);
    } catch (err) {
      busyRef.current = false;
      setPhase('error');
      setError(err instanceof Error ? err.message : 'Не удалось добавить');
      setStatusText('');
      setStatusSub('');
      setStatusCover(null);
    }
  };

  const expanded = focused || phase === 'results' || phase === 'searching' || phase === 'adding';

  return (
    <div
      className={`add-zone${expanded ? ' expanded' : ''}${phase === 'success' || phase === 'adding' ? ' status-mode' : ''}`}
    >
      {phase === 'adding' || phase === 'success' ? (
        <div className="add-status" onClick={resetToSearch}>
          {statusCover ? (
            <img className="add-status-cover" src={statusCover} alt="" />
          ) : (
            <div className={`add-status-icon ${phase}`}>{phase === 'success' ? '✓' : '♪'}</div>
          )}
          <div className="add-status-text">
            <div className="add-status-title">
              {phase === 'success' ? 'Успешно!' : statusText}
            </div>
            {phase === 'success' && statusSub ? (
              <div className="add-status-sub">{statusSub}</div>
            ) : null}
          </div>
        </div>
      ) : (
        <>
          <div className="search-bar">
            <input
              ref={inputRef}
              type="search"
              inputMode="search"
              placeholder="Добавить трек…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => {
                window.setTimeout(() => setFocused(false), 120);
              }}
              maxLength={120}
              autoComplete="off"
            />
            {expanded && q && (
              <button
                type="button"
                className="search-plus"
                onClick={resetToSearch}
                title="Очистить"
              >
                ✕
              </button>
            )}
            {!expanded && (
              <button
                type="button"
                className="search-plus"
                onClick={() => fileRef.current?.click()}
                title="Загрузить файл"
              >
                +
              </button>
            )}
          </div>
          <input
            ref={fileRef}
            className="file-input"
            type="file"
            accept="audio/*"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              void add(
                () =>
                  submitFile({ file: f, requestedBy: 'гость' }).then((r) => {
                    const body = r as { queueIndex?: number; queueTotal?: number };
                    return { queueIndex: body.queueIndex, queueTotal: body.queueTotal };
                  }),
                null
              );
              e.target.value = '';
            }}
          />

          {error && (
            <p className="hint" style={{ color: 'var(--danger)', marginTop: 8 }}>
              {error}
            </p>
          )}

          {(phase === 'searching' || hits.length > 0 || (focused && q.trim().length >= 2)) && (
            <div className="results">
              {phase === 'searching' && <div className="hint">Ищем…</div>}
              {hits.map((h) => (
                <button
                  key={h.id}
                  type="button"
                  className="result"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() =>
                    void add(
                      () =>
                        onSubmitUrl(h.url).then((r) => ({
                          queueIndex: r?.queueIndex,
                          queueTotal: r?.queueTotal,
                        })),
                      h.thumbnailUrl
                    )
                  }
                >
                  {h.thumbnailUrl ? (
                    <img src={h.thumbnailUrl} alt="" />
                  ) : (
                    <div className="thumb" />
                  )}
                  <div className="body">
                    <div className="t">{h.title}</div>
                    <div className="m">
                      {h.artist ? `${h.artist} · ` : ''}
                      {formatDur(h.durationSec)}
                    </div>
                  </div>
                </button>
              ))}
              {phase !== 'searching' && q.trim().length >= 2 && (
                <button
                  type="button"
                  className="result"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() =>
                    void add(() =>
                      onSubmitTitle(q.trim()).then((r) => ({
                        queueIndex: r?.queueIndex,
                        queueTotal: r?.queueTotal,
                      }))
                    )
                  }
                >
                  <div className="thumb" />
                  <div className="body">
                    <div className="t">Добавить «{q.trim()}»</div>
                    <div className="m">поиск по названию</div>
                  </div>
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function formatDur(sec: number | null): string {
  if (!sec || sec <= 0) return '';
  const s = Math.floor(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}
