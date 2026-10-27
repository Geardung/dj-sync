import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMessage, ClientRole, PartyState, ServerMessage } from '@dj-sync/shared';
import { wsUrl } from './api';

export function usePartySocket(opts: {
  role: ClientRole;
  guestId?: string;
  nickname?: string;
  onMessage?: (msg: ServerMessage) => void;
}) {
  const [state, setState] = useState<PartyState | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastToast, setLastToast] = useState<{ level: string; text: string } | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);

  const onMessageRef = useRef(opts.onMessage);
  onMessageRef.current = opts.onMessage;
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const socketRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef<ClientMessage[]>([]);

  const flush = useCallback(() => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    while (pendingRef.current.length) {
      const msg = pendingRef.current.shift();
      if (msg) ws.send(JSON.stringify(msg));
    }
  }, []);

  const send = useCallback(
    (msg: ClientMessage) => {
      pendingRef.current.push(msg);
      flush();
    },
    [flush]
  );

  useEffect(() => {
    let closed = false;
    let retry = 0;
    let timer: number | undefined;

    const connect = () => {
      const ws = new WebSocket(wsUrl());
      socketRef.current = ws;

      ws.onopen = () => {
        retry = 0;
        setConnected(true);
        const o = optsRef.current;
        ws.send(
          JSON.stringify({
            type: 'hello',
            role: o.role,
            guestId: o.guestId,
            nickname: o.nickname,
          } satisfies ClientMessage)
        );
        flush();
      };

      ws.onmessage = (ev) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(ev.data) as ServerMessage;
        } catch {
          return;
        }
        if (msg.type === 'hello' || msg.type === 'state') {
          setState(msg.state);
        } else if (msg.type === 'vote:update') {
          setState((prev) => (prev ? { ...prev, votes: msg.votes } : prev));
        } else if (msg.type === 'toast') {
          setLastToast({ level: msg.level, text: msg.text });
          window.setTimeout(() => setLastToast(null), 4000);
        } else if (msg.type === 'audio:level') {
          setAudioLevel(msg.level);
        } else if (msg.type === 'player:play') {
          setState((prev) =>
            prev
              ? {
                  ...prev,
                  current: msg.track,
                  paused: false,
                  position: msg.position,
                }
              : prev
          );
        }
        onMessageRef.current?.(msg);
      };

      ws.onclose = () => {
        setConnected(false);
        if (socketRef.current === ws) socketRef.current = null;
        if (closed) return;
        const delay = Math.min(8000, 500 * 2 ** retry);
        retry += 1;
        timer = window.setTimeout(connect, delay);
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();
    return () => {
      closed = true;
      if (timer) window.clearTimeout(timer);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [opts.role, opts.guestId, opts.nickname, flush]);

  return { state, connected, lastToast, setState, send, audioLevel };
}

/* ——— Telegram Mini App: only on /tg ——— */

export function isTgRoute(): boolean {
  return window.location.pathname.replace(/\/+$/, '') === '/tg'
    || window.location.pathname.startsWith('/tg/');
}

export function telegramWebApp() {
  return (window as unknown as { Telegram?: { WebApp?: Record<string, unknown> } }).Telegram?.WebApp ?? null;
}

export function isTma(): boolean {
  return Boolean(telegramWebApp());
}

export function loadTelegramScript(): Promise<void> {
  return new Promise((resolve) => {
    if (telegramWebApp()) {
      resolve();
      return;
    }
    const existing = document.querySelector('script[data-tg-webapp]');
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => resolve());
      return;
    }
    const s = document.createElement('script');
    s.src = 'https://telegram.org/js/telegram-web-app.js';
    s.async = true;
    s.setAttribute('data-tg-webapp', '1');
    s.onload = () => resolve();
    s.onerror = () => resolve();
    document.head.appendChild(s);
  });
}

export type TgUser = {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
};

export async function loadTgUser(): Promise<TgUser | null> {
  if (!isTgRoute()) return null;
  await loadTelegramScript();
  // give the script a tick to attach Telegram.WebApp
  await new Promise((r) => setTimeout(r, 50));
  const tg = telegramWebApp() as unknown as {
    ready?: () => void;
    expand?: () => void;
    setHeaderColor?: (c: string) => void;
    setBackgroundColor?: (c: string) => void;
    initDataUnsafe?: { user?: TgUser };
  } | null;
  if (!tg) return null;
  try {
    tg.ready?.();
    tg.expand?.();
    tg.setHeaderColor?.('#120810');
    tg.setBackgroundColor?.('#120810');
  } catch {
    /* older clients */
  }
  return tg.initDataUnsafe?.user ?? null;
}

export function tgGuestId(user: TgUser): string {
  return `tg-${user.id}`;
}

export function tgDisplayName(user: TgUser): string {
  return user.first_name || user.username || 'Гость';
}
