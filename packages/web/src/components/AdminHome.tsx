import type { PartyState } from '@dj-sync/shared';
import type { PartyPlayer } from '../partyPlayer';
import { PlayerMode } from './PlayerMode';
import { QueueList } from './QueueList';
import { MomentsStrip } from './MomentsStrip';

export type AdminMode = 'remote' | 'speaker';

export function AdminHome({
  state,
  connected,
  mode,
  onModeChange,
  getPlayer,
  onCommand,
  onHello,
  onUploadPhoto,
  onDeletePhoto,
  onMove,
  onRemove,
  onPlay,
}: {
  state: PartyState | null;
  connected: boolean;
  mode: AdminMode;
  onModeChange: (m: AdminMode) => void;
  getPlayer: () => PartyPlayer;
  onCommand: (action: string, extra?: Record<string, unknown>) => void;
  onHello: () => void;
  onUploadPhoto: (file: File) => Promise<void>;
  onDeletePhoto: (id: string) => void;
  onMove: (id: string, dir: 'up' | 'down') => void;
  onRemove: (id: string) => void;
  onPlay: (id: string) => void;
}) {
  const queueLimit = state?.queueLimit ?? 1;
  const isSpeaker = mode === 'speaker';

  return (
    <>
      <div className="mode-switch" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={!isSpeaker}
          className={!isSpeaker ? 'active' : ''}
          onClick={() => onModeChange('remote')}
        >
          Пульт
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={isSpeaker}
          className={isSpeaker ? 'active' : ''}
          onClick={() => onModeChange('speaker')}
        >
          Колонка
        </button>
      </div>

      {isSpeaker ? (
        <PlayerMode
          state={state}
          connected={connected}
          getPlayer={getPlayer}
          onCommand={onCommand}
          onHello={onHello}
        />
      ) : (
        <div className="card remote-panel">
          <div className={`onair ${state?.playerConnected ? '' : 'off'}`}>
            <span
              className="dot on"
              style={{
                background: state?.playerConnected ? 'var(--danger)' : 'var(--muted)',
              }}
            />
            {state?.playerConnected ? 'КОЛОНКА В ЭФИРЕ' : 'КОЛОНКА НЕ ПОДКЛЮЧЕНА'}
          </div>

          <div className="big" style={{ marginTop: 14 }}>
            {state?.current?.title ?? 'Ничего не играет'}
          </div>
          <div className="sub">
            {state?.current
              ? `${state.current.requestedBy} · ${state.paused ? 'пауза' : 'играет'}`
              : 'Открой /fleer-lox на телефоне-колонке и нажми «Включить режим динамика».'}
          </div>

          <div className="row" style={{ marginTop: 18 }}>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => onCommand(state?.paused ? 'resume' : 'pause')}
            >
              {state?.paused ? 'Продолжить' : 'Пауза'}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => onCommand('skip')}
            >
              Дальше
            </button>
          </div>

          <div className="volume-block">
            <div className="volume-label">
              <span>Громкость</span>
              <strong>{Math.round((state?.volume ?? 1) * 100)}%</strong>
            </div>
            <input
              className="volume-slider"
              type="range"
              min={0}
              max={100}
              value={Math.round((state?.volume ?? 1) * 100)}
              onChange={(e) => {
                const v = Number(e.target.value) / 100;
                onCommand('volume', { volume: v });
              }}
            />
            <p className="muted" style={{ marginTop: 6, marginBottom: 0 }}>
              одна ручка и на треки, и на lo-fi
            </p>
          </div>

          <div className="queue-limit">
            <div className="volume-label">
              <span>Треков в очереди</span>
              <strong>{queueLimit}</strong>
            </div>
            <input
              className="volume-slider"
              type="range"
              min={1}
              max={10}
              value={queueLimit}
              onChange={(e) => {
                onCommand('queue-limit', { limit: Number(e.target.value) });
              }}
            />
            <p className="muted" style={{ marginTop: 6, marginBottom: 0 }}>
              сколько треков гости могут держать в очереди. Тот, что играет, не считается.
            </p>
          </div>

          <div className="row" style={{ marginTop: 12 }}>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() =>
                onCommand('fallback', { enabled: !(state?.fallbackEnabled ?? true) })
              }
            >
              {state?.fallbackEnabled ? 'Lo-Fi: вкл' : 'Lo-Fi: выкл'}
            </button>
          </div>
                            <div className="queue-limit">
                <div className="volume-label">
                  <span>Макс. длина трека</span>
                  <strong>
                    {(() => {
                      const m = state?.maxDurationSec ?? 300;
                      return m === 0 ? 'без лимита' : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
                    })()}
                  </strong>
                </div>
                <input
                  className="volume-slider"
                  type="range"
                  min={0}
                  max={15}
                  step={1}
                  value={Math.round((state?.maxDurationSec ?? 300) / 60)}
                  onChange={(e) =>
                    onCommand('max-duration', { sec: Number(e.target.value) * 60 })
                  }
                />
                <div style={{ fontSize: 11, opacity: 0.6 }}>0 — без лимита, до 15 мин</div>
              </div>

        </div>
      )}

      <div>
        <div className="section-title">Очередь</div>
        <QueueList
          state={state}
          editable
          onMove={onMove}
          onRemove={onRemove}
          onPlay={onPlay}
        />
      </div>

      <div>
        <div className="section-title">Моменты</div>
        <MomentsStrip photos={state?.photos ?? []} onUpload={onUploadPhoto} />
        {(state?.photos?.length ?? 0) > 0 && (
          <div className="row" style={{ marginTop: 10 }}>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => {
                const first = state?.photos?.[0];
                if (first) onDeletePhoto(first.id);
              }}
            >
              Удалить последнее фото
            </button>
          </div>
        )}
      </div>

      <a className="btn btn-ghost" href="/" style={{ textDecoration: 'none' }}>
        Гостевой экран
      </a>
    </>
  );
}
