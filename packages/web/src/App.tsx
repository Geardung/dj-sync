import { useCallback, useEffect, useRef, useState } from 'react';
import type { ServerMessage, ClientMessage } from '@dj-sync/shared';
import {
  join,
  playerCommand,
  submitTrack,
  voteSkip,
  uploadPhoto,
  deletePhoto,
  audioUrl,
  moveTrack,
  playTrackNow,
  removeTrack,
} from './api';
import {
  usePartySocket,
  isTgRoute,
  loadTgUser,
  tgDisplayName,
  tgGuestId,
  type TgUser,
} from './ws';
import { AdminHome, type AdminMode } from './components/AdminHome';
import { GuestHome } from './components/GuestHome';
import { QueueButton, QueueSheet } from './components/QueueSheet';
import { PartyPlayer } from './partyPlayer';

const GUEST_KEY = 'dj-sync.guest';
const NICK_KEY = 'dj-sync.nickname';

/** crossfade length in seconds — lo-fi → track should be a real fade */
const FADE_SEC = 3.0;

function loadGuest() {
  try {
    const raw = localStorage.getItem(GUEST_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as { guestId: string; nickname: string; avatarUrl?: string };
  } catch {
    return null;
  }
}

function isAdminRoute() {
  return window.location.pathname.replace(/\/+$/, '').endsWith('/fleer-lox');
}

export function App() {
  const [isAdmin, setIsAdmin] = useState(() => isAdminRoute());
  const [guest, setGuest] = useState(() => loadGuest());
  const [nickname, setNickname] = useState(() => guest?.nickname || localStorage.getItem(NICK_KEY) || '');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(() => loadGuest()?.avatarUrl ?? null);
  const [joining, setJoining] = useState(false);
  const [tgLoading, setTgLoading] = useState(() => isTgRoute() && !loadGuest());
  const [error, setError] = useState<string | null>(null);
  const [livePosition, setLivePosition] = useState(0);
  const [queueOpen, setQueueOpen] = useState(false);
  const [adminMode, setAdminMode] = useState<AdminMode>(() => {
    return localStorage.getItem('dj-sync.admin-mode') === 'speaker' ? 'speaker' : 'remote';
  });

  const playerRef = useRef<PartyPlayer | null>(null);
  const sendRef = useRef<((msg: ClientMessage) => void) | null>(null);
  const volumeRef = useRef(1);

  const getPlayer = useCallback(() => {
    if (!playerRef.current) {
      playerRef.current = new PartyPlayer();
    }
    return playerRef.current;
  }, []);

  useEffect(() => {
    const onPop = () => setIsAdmin(isAdminRoute());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // /tg → Mini App identity; plain / stays with the name form
  useEffect(() => {
    if (!isTgRoute() || guest) return;
    let cancelled = false;
    void (async () => {
      const user: TgUser | null = await loadTgUser();
      if (cancelled) return;
      if (!user) {
        setTgLoading(false);
        return;
      }
      try {
        const res = await join(tgDisplayName(user), tgGuestId(user));
        const next = { ...res, avatarUrl: user.photo_url || undefined };
        if (cancelled) return;
        setGuest(next);
        setNickname(res.nickname);
        setAvatarUrl(user.photo_url || null);
        localStorage.setItem(GUEST_KEY, JSON.stringify(next));
        localStorage.setItem(NICK_KEY, res.nickname);
      } catch {
        if (!cancelled) setError('Не удалось войти через Telegram');
      } finally {
        if (!cancelled) setTgLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [guest]);

  const role = isAdmin && adminMode === 'speaker' ? 'player' : 'guest';

  const onMessage = useCallback(
    (msg: ServerMessage) => {
      const player = getPlayer();
      if (msg.type === 'player:play') {
        const src = audioUrl(msg.track.audioUrl);
        if (!src) return;
        const isAmbient = Boolean(msg.track.isFallback);
        void player.play({
          src,
          trackId: msg.track.id,
          position: msg.position,
          loop: isAmbient,
          fadeSec: FADE_SEC,
        });
        player.setVolume(volumeRef.current);
      } else if (msg.type === 'player:pause') {
        player.pause();
      } else if (msg.type === 'player:resume') {
        if (!player.currentTrackId) {
          sendRef.current?.({ type: 'player:ready' });
          return;
        }
        void player.resume();
      } else if (msg.type === 'player:seek') {
        player.seek(msg.position);
      } else if (msg.type === 'player:stop') {
        player.stop();
      } else if (msg.type === 'player:volume') {
        volumeRef.current = msg.volume;
        player.setVolume(msg.volume);
      }
    },
    [getPlayer]
  );

  useEffect(() => {
    localStorage.setItem('dj-sync.admin-mode', adminMode);
  }, [adminMode]);

  // Only the speaker phone is allowed to emit audio.
  // Switching to remote (or leaving admin) must kill local playback.
  useEffect(() => {
    const shouldPlay = isAdmin && adminMode === 'speaker';
    if (!shouldPlay) {
      playerRef.current?.stop();
    }
  }, [isAdmin, adminMode]);

  const { state, connected, lastToast, send, audioLevel } = usePartySocket({
    role,
    guestId: guest?.guestId,
    nickname: guest?.nickname,
    onMessage: isAdmin && adminMode === 'speaker' ? onMessage : undefined,
  });
  sendRef.current = send;

  useEffect(() => {
    if (state && typeof state.volume === 'number') {
      volumeRef.current = state.volume;
    }
    playerRef.current?.setVolume(volumeRef.current);
  }, [state?.volume]);

  useEffect(() => {
    if (!isAdmin || adminMode !== 'speaker') return;
    const player = getPlayer();
    player.onTime = (_id, position) => {
      send({ type: 'player:progress', position, duration: null });
    };
    player.onEnded = () => {
      send({ type: 'player:ended', reason: 'natural' });
    };
    const levelTimer = window.setInterval(() => {
      send({ type: 'player:level', level: player.getLevel() });
    }, 120);
    return () => {
      player.onTime = null;
      player.onEnded = null;
      window.clearInterval(levelTimer);
    };
  }, [isAdmin, adminMode, send, getPlayer]);

  useEffect(() => {
    setLivePosition(state?.position ?? 0);
    if (!state || state.paused) return;
    const start = Date.now();
    const base = state.position ?? 0;
    const id = window.setInterval(() => {
      setLivePosition(base + (Date.now() - start) / 1000);
    }, 500);
    return () => window.clearInterval(id);
  }, [state?.position, state?.paused, state?.current?.id]);

  useEffect(() => {
    if (state && state.ambientPosition > 0) {
      getPlayer().setAmbientPosition(state.ambientPosition);
    }
  }, [state?.ambientPosition, getPlayer]);

  const handleJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    const nick = nickname.trim();
    if (!nick) return;
    setJoining(true);
    setError(null);
    try {
      const res = await join(nick, guest?.guestId);
      setGuest(res);
      localStorage.setItem(GUEST_KEY, JSON.stringify(res));
      localStorage.setItem(NICK_KEY, res.nickname);
    } catch {
      setError('Не удалось войти. Проверьте, что бэкенд поднят.');
    } finally {
      setJoining(false);
    }
  };

  const handleVote = async () => {
    if (!guest || !state) return;
    const voted = Boolean(state.votes.votes[guest.guestId]);
    try {
      await voteSkip(guest.guestId, voted ? 'unvote' : 'vote');
    } catch {
      /* ignore */
    }
  };

  const handleSubmitUrl = async (url: string) => {
    if (!guest) return;
    const res = await submitTrack({ url, guestId: guest.guestId, requestedBy: guest.nickname });
    return { queueIndex: res.queueIndex, queueTotal: res.queueTotal };
  };

  const handleSubmitTitle = async (title: string) => {
    if (!guest) return;
    const res = await submitTrack({ title, guestId: guest.guestId, requestedBy: guest.nickname });
    return { queueIndex: res.queueIndex, queueTotal: res.queueTotal };
  };

  const handleUploadPhoto = async (file: File, onProgress?: (pct: number) => void) => {
    await uploadPhoto({
      file,
      guestId: guest?.guestId,
      uploadedBy: guest?.nickname || 'гость',
      onProgress,
    });
  };

  const voted = Boolean(guest && state?.votes.votes[guest.guestId]);
  const queueCount = state?.upcoming?.length ?? 0;

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <h1>ТУСОВКА</h1>
          <div className="sub">{isAdmin ? 'пульt' : ''}</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {!isAdmin && guest && (
            <QueueButton
              count={queueCount}
              onClick={() => {
                setQueueOpen(true);
                window.dispatchEvent(new CustomEvent('dj-search-collapse'));
              }}
            />
          )}
          {isAdmin && (
            <>
              {!connected && (
                <span className="pill">
                  <span className="dot" /> нет связи
                </span>
              )}
              <a className="pill" href="/" style={{ textDecoration: 'none', color: 'var(--ink)' }}>
                гости
              </a>
            </>
          )}
          {avatarUrl && !isAdmin && (
            <img className="avatar" src={avatarUrl} alt="" />
          )}
        </div>
      </header>

      {isAdmin ? (
        <AdminHome
          state={state}
          connected={connected}
          mode={adminMode}
          onModeChange={setAdminMode}
          getPlayer={getPlayer}
          onCommand={(action, extra) => {
            if (action === 'volume' && typeof extra?.volume === 'number') {
              volumeRef.current = extra.volume;
              getPlayer().setVolume(extra.volume);
            }
            if (action === 'resume' && adminMode === 'speaker') {
              void getPlayer().resume();
            }
            if (action === 'pause' && adminMode === 'speaker') {
              getPlayer().pause();
            }
            void playerCommand(action, extra);
          }}
          onHello={() => {
            void getPlayer().resumeContext();
            send({ type: 'hello', role: 'player' });
          }}
          onUploadPhoto={handleUploadPhoto}
          onDeletePhoto={(id) => {
            void deletePhoto(id);
          }}
          onMove={(id, dir) => {
            void moveTrack(id, dir).catch(() => {});
          }}
          onRemove={(id) => {
            void removeTrack(id).catch(() => {});
          }}
          onPlay={(id) => {
            void playTrackNow(id).catch(() => {});
          }}
        />
      ) : !guest ? (
        tgLoading ? (
          <div className="join-wrap">
            <div className="join-visual">
              <div className="cover-fallback" />
            </div>
            <p className="hint" style={{ textAlign: 'center' }}>
              Заходим через Telegram…
            </p>
          </div>
        ) : (
          <form className="join-wrap" onSubmit={handleJoin}>
            <div className="join-visual">
              {state?.current?.coverUrl ? (
                <img src={audioUrl(state.current.coverUrl) ?? ''} alt="" />
              ) : (
                <div className="cover-fallback" />
              )}
            </div>
            <div className="card">
              <h2>Войти на вечеринку</h2>
              <div className="field">
                <label htmlFor="nick">Твоё имя</label>
                <input
                  id="nick"
                  type="text"
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  placeholder="например, Кекс"
                  maxLength={32}
                  autoComplete="off"
                />
              </div>
              <p className="hint">Нужно, чтобы добавлять треки, фотки и голосовать за скип.</p>
              <button
                className="btn btn-primary"
                type="submit"
                disabled={joining || !nickname.trim()}
              >
                {joining ? 'Входим…' : 'Я в деле'}
              </button>
              {error && (
                <p className="hint" style={{ color: 'var(--danger)' }}>
                  {error}
                </p>
              )}
            </div>
            {!isTgRoute() && (
              <p className="hint" style={{ textAlign: 'center' }}>
                <a href="/tg" style={{ color: 'var(--accent-2)' }}>
                  Открыть как Mini App
                </a>
              </p>
            )}
          </form>
        )
      ) : (
        <GuestHome
          state={state}
          position={livePosition}
          audioLevel={audioLevel}
          votes={{
            count: state?.votes.count ?? 0,
            activeGuests: state?.votes.activeGuests ?? 1,
            voted,
          }}
          onVote={handleVote}
          onSubmitUrl={handleSubmitUrl}
          onSubmitTitle={handleSubmitTitle}
          onUploadPhoto={handleUploadPhoto}
        />
      )}

      {queueOpen && !isAdmin && (
        <QueueSheet state={state} onClose={() => setQueueOpen(false)} />
      )}

      {lastToast && <div className={`toast ${lastToast.level}`}>{lastToast.text}</div>}
    </div>
  );
}
