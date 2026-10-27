import { useState, useEffect } from 'react';
import type { PartyState } from '@dj-sync/shared';
import type { PartyPlayer } from '../partyPlayer';

export function PlayerMode({
  state,
  connected,
  getPlayer,
  onCommand,
  onHello,
}: {
  state: PartyState | null;
  connected: boolean;
  getPlayer: () => PartyPlayer;
  onCommand: (action: string, extra?: Record<string, unknown>) => void;
  onHello: () => void;
}) {
  const [booting, setBooting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [volumePct, setVolumePct] = useState(() =>
    Math.round((state?.volume ?? 1) * 100)
  );
  const track = state?.current ?? null;
  const playerOn = state?.playerConnected ?? false;
  const isLoFi = Boolean(track?.isFallback);
  const fallbackOn = state?.fallbackEnabled ?? true;
  const playing = Boolean(track) && !state?.paused;

  useEffect(() => {
    if (state && typeof state.volume === 'number') {
      setVolumePct(Math.round(state.volume * 100));
    }
  }, [state?.volume]);

  const enablePlayer = async () => {
    setBooting(true);
    setStatus('Подключаем динамик…');
    try {
      const player = getPlayer();
      await player.resumeContext();
      onHello();
      onCommand('resume');
      setStatus('Динамик подключён. Кроссфейд включён.');
      window.setTimeout(() => setStatus(null), 2500);
    } catch {
      setStatus('Не удалось открыть аудио. Нажми ещё раз.');
    } finally {
      setBooting(false);
    }
  };

  return (
    <div className="player-hero card">
      <div className={`onair ${playerOn ? '' : 'off'}`}>
        <span
          className="dot on"
          style={{ background: playerOn ? 'var(--danger)' : 'var(--muted)' }}
        />
        {playerOn ? 'ON AIR' : 'STANDBY'}
      </div>

      <div className="big">
        {track ? track.title : 'Ничего не играет'}
      </div>
      <div className="sub">
        {track
          ? isLoFi
            ? `Lo-Fi фон · ${playing ? 'играет' : 'пауза'} · позиция ${formatTime(state?.position ?? 0)}`
            : `${track.requestedBy} · ${playing ? 'играет' : 'пауза'}`
          : 'Этот телефон — динамик. Подключи Bluetooth колонку.'}
      </div>

      {!playerOn ? (
        <div className="row" style={{ marginTop: 22 }}>
          <button className="btn btn-player" onClick={enablePlayer} disabled={booting}>
            {booting ? 'Включаю…' : 'Включить режим динамика'}
          </button>
        </div>
      ) : (
        <div className="row" style={{ marginTop: 22 }}>
          <button
            className="btn btn-player"
            onClick={() => {
              onCommand('resume');
            }}
          >
            {playing ? 'Играет · кроссфейд 2с' : 'Продолжить'}
          </button>
        </div>
      )}

      {status && (
        <p className="muted" style={{ marginTop: 12, color: 'var(--accent)' }}>
          {status}
        </p>
      )}

      <div className="row" style={{ marginTop: 12 }}>
        <button
          className="btn btn-ghost"
          disabled={!playerOn}
          onClick={() => {
            onCommand('pause');
            setStatus('Пауза');
          }}
        >
          Пауза
        </button>
        <button
          className="btn btn-danger"
          disabled={!playerOn}
          onClick={() => {
            onCommand('skip');
            setStatus('Скип');
          }}
        >
          Дальше
        </button>
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <button
          className="btn btn-ghost"
          onClick={() => onCommand('fallback', { enabled: !fallbackOn })}
        >
          {fallbackOn ? 'Lo-Fi: вкл' : 'Lo-Fi: выкл'}
        </button>
      </div>

      <div className="volume-block">
        <div className="volume-label">
          <span>Громкость</span>
          <strong>{volumePct}%</strong>
        </div>
        <input
          className="volume-slider"
          type="range"
          min={0}
          max={100}
          value={volumePct}
          disabled={!playerOn}
          onChange={(e) => {
            const pct = Number(e.target.value);
            setVolumePct(pct);
            const v = pct / 100;
            onCommand('volume', { volume: v });
          }}
        />
        <p className="muted" style={{ marginTop: 6, marginBottom: 0 }}>
          одна ручка и на треки, и на lo-fi
        </p>
      </div>

      <p className="muted" style={{ marginTop: 16 }}>
        WS: {connected ? 'подключено' : 'переподключение…'} · гостей: {state?.listeners ?? 0}
        {isLoFi ? ' · lo-fi с места, не с начала' : ''}
      </p>
    </div>
  );
}

function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}
