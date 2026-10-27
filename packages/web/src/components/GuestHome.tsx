import { useEffect, useState } from 'react';
import type { PartyState } from '@dj-sync/shared';
import { audioUrl } from '../api';
import { MomentsStrip } from './MomentsStrip';
import { SearchAdd } from './SearchAdd';

export function GuestHome({
  state,
  position,
  audioLevel = 0,
  votes,
  onVote,
  onSubmitUrl,
  onSubmitTitle,
  onUploadPhoto,
}: {
  state: PartyState | null;
  position: number;
  audioLevel?: number;
  votes: { count: number; activeGuests: number; voted: boolean };
  onVote: () => void;
  onSubmitUrl: (url: string) => Promise<{ queueIndex?: number; queueTotal?: number } | void>;
  onSubmitTitle: (title: string) => Promise<{ queueIndex?: number; queueTotal?: number } | void>;
  onUploadPhoto: (file: File, onProgress?: (pct: number) => void) => Promise<void>;
}) {
  const track = state?.current ?? null;
  const isLoFi = Boolean(track?.isFallback);
  const [lofiMoment, setLofiMoment] = useState<import('@dj-sync/shared').PartyPhoto | null>(null);

  // during Lo-Fi show random moments (photos / short videos) instead of the plain cover
  useEffect(() => {
    if (!isLoFi) {
      setLofiMoment(null);
      return;
    }
    const list = (state?.photos ?? []).filter(
      (ph) => ph.kind === 'image' || ph.kind === 'video'
    );
    if (list.length === 0) {
      setLofiMoment(null);
      return;
    }
    const pick = () => setLofiMoment(list[Math.floor(Math.random() * list.length)]!);
    pick();
    const id = window.setInterval(pick, 12000);
    return () => window.clearInterval(id);
  }, [isLoFi, state?.photos]);
  const dur = track?.durationSec || 0;
  const pct = dur > 0 ? Math.min(100, (position / dur) * 100) : 0;
  const cover = track?.coverUrl ? audioUrl(track.coverUrl) : null;
  const next = state?.upcoming?.[0] ?? null;
  const pulse = 0.35 + Math.min(1, audioLevel * 1.5) * 1.15;

  return (
    <>
      <div className="player">
        <div
          className={`cover-shell ${audioLevel > 0.02 ? 'is-live' : 'is-idle'}`}
          style={{ ['--pulse' as string]: String(pulse) }}
        >
          <div className="cover">
            {cover ? (
              <img src={cover} alt="" />
            ) : lofiMoment ? (
              lofiMoment.kind === 'video' ? (
                <video
                  src={lofiMoment.url}
                  muted
                  playsInline
                  loop
                  autoPlay
                  style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit' }}
                />
              ) : (
                <img
                  src={lofiMoment.url}
                  alt=""
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              )
            ) : (
              <div className="cover-fallback" />
            )}
            <button
              type="button"
              className={`skip-btn${votes.voted ? ' voted' : ''}`}
              onClick={onVote}
              title="Проголосовать за скип"
            >
              <span className="lbl">СКИП</span>
              <span className="votes">
                за {votes.count}/{votes.activeGuests}
              </span>
            </button>
          </div>
        </div>

        <div className="progress-wrap">
          <div className="progress">
            <span style={{ width: `${pct}%` }} />
          </div>
          <div className="progress-times">
            <span>{formatTime(position)}</span>
            <span>{dur ? formatTime(dur) : isLoFi ? 'lo-fi' : '—'}</span>
          </div>
        </div>

        <div className="track-meta">
          <div className="title">{track ? track.title : 'Пока тишина'}</div>
          {(track?.artist || isLoFi || !track) && (
            <div className="artist">
              {track
                ? track.artist || (isLoFi ? 'Lo-Fi фон · не в очереди' : '')
                : 'Добавь трек — он встанет в очередь'}
            </div>
          )}
          {track && !isLoFi && (
            <div className="who">
              заказал {track.requestedBy}
              {state?.paused ? ' · на паузе' : ''}
            </div>
          )}
          {next && (
            <div className="who">
              далее: {next.title}
              {next.artist ? ` — ${next.artist}` : ''}
            </div>
          )}
        </div>

        <MomentsStrip photos={state?.photos ?? []} onUpload={onUploadPhoto} />
      </div>

      <SearchAdd
        onSubmitUrl={onSubmitUrl}
        onSubmitTitle={onSubmitTitle}
        queuePosition={{
          index: state?.upcoming?.length ?? 0,
          total: state?.queueLimit ?? 1,
        }}
      />
    </>
  );
}

function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}
