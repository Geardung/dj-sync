import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage, ClientRole, PartyPhoto } from '@dj-sync/shared';
import { store } from './store.js';

interface Client {
  socket: WebSocket;
  role: ClientRole;
  guestId?: string;
  alive: boolean;
}

const clients = new Set<Client>();

function send(socket: WebSocket, msg: ServerMessage) {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

function broadcast(msg: ServerMessage, filter?: (c: Client) => boolean) {
  for (const c of clients) {
    if (filter && !filter(c)) continue;
    send(c.socket, msg);
  }
}

function broadcastState() {
  const state = store.state();
  broadcast({ type: 'state', state });
}

function playerClients(): Client[] {
  return [...clients].filter((c) => c.role === 'player');
}

function pushToPlayers(msg: ServerMessage) {
  for (const c of playerClients()) send(c.socket, msg);
}

let lastPlayedTrackId: string | null = null;
let lastPaused = false;

export function registerWs(app: FastifyInstance) {
  app.get('/ws', { websocket: true }, (socket /* , req */) => {
    const client: Client = {
      socket: socket as unknown as WebSocket,
      role: 'guest',
      alive: true,
    };
    clients.add(client);

    socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        return;
      }
      handleMessage(client, msg);
    });

    socket.on('close', () => {
      clients.delete(client);
      if (client.role === 'player' && playerClients().length === 0) {
        store.setPlayerConnected(false);
      }
      broadcastState();
    });

    socket.on('error', () => {
      clients.delete(client);
    });

    // greet with current state
    send(client.socket, {
      type: 'hello',
      state: store.state(),
      role: client.role,
    });
  });

  store.onChange((state) => {
    broadcast({ type: 'state', state });

    const cur = state.current;
    if (!cur) {
      if (lastPlayedTrackId) {
        pushToPlayers({ type: 'player:stop' });
        lastPlayedTrackId = null;
        lastPaused = false;
      }
      return;
    }

    // new track → tell player to play once
    if (cur.id !== lastPlayedTrackId && cur.status === 'playing') {
      lastPlayedTrackId = cur.id;
      lastPaused = false;
      const pos = cur.isFallback ? state.ambientPosition : 0;
      pushToPlayers({ type: 'player:play', track: cur, position: pos });
    }

    // pause / resume transitions
    if (state.paused !== lastPaused) {
      lastPaused = state.paused;
      pushToPlayers(state.paused ? { type: 'player:pause' } : { type: 'player:resume' });
    }

    pushToPlayers({ type: 'vote:update', votes: state.votes });
  });
}

function handleMessage(client: Client, msg: ClientMessage) {
  switch (msg.type) {
    case 'hello': {
      client.role = msg.role === 'player' ? 'player' : 'guest';
      client.guestId = msg.guestId;
      if (msg.nickname && msg.guestId) {
        store.join(msg.nickname, msg.guestId);
      } else if (msg.guestId) {
        store.touch(msg.guestId);
      }
      if (client.role === 'player') {
        store.setPlayerConnected(true);
        // kick whatever is current so the speaker phone starts immediately
        const cur = store.state().current;
        if (cur) {
          const pos = cur.isFallback ? store.getAmbientPosition() : store.state().position;
          send(client.socket, {
            type: 'player:play',
            track: cur,
            position: pos,
          });
        }
      }
      send(client.socket, {
        type: 'hello',
        state: store.state(),
        role: client.role,
      });
      broadcastState();
      break;
    }
    case 'player:ready': {
      if (client.role !== 'player') return;
      store.setPlayerConnected(true);
      const cur = store.state().current;
      if (cur) {
        const pos = cur.isFallback ? store.getAmbientPosition() : store.state().position;
        send(client.socket, {
          type: 'player:play',
          track: cur,
          position: pos,
        });
      }
      break;
    }
    case 'player:started': {
      if (client.role !== 'player') return;
      store.setPosition(msg.position || 0);
      break;
    }
    case 'player:progress': {
      if (client.role !== 'player') return;
      store.setPosition(msg.position);
      break;
    }
    case 'player:ended': {
      if (client.role !== 'player') return;
      if (msg.reason === 'natural' || msg.reason === 'error') {
        store.advance('auto');
      }
      break;
    }
    case 'player:paused': {
      store.setPaused(true);
      break;
    }
    case 'player:resumed': {
      store.setPaused(false);
      break;
    }
    case 'player:level': {
      if (client.role !== 'player') return;
      const level = Math.max(0, Math.min(1, Number(msg.level) || 0));
      broadcast({ type: 'audio:level', level }, (c) => c.role !== 'player');
      break;
    }
    case 'guest:ping': {
      if (client.guestId) store.touch(client.guestId);
      break;
    }
    default:
      break;
  }
}

export function notifyToast(level: 'info' | 'error' | 'success', text: string) {
  broadcast({ type: 'toast', level, text });
}

export function notifyPhoto(photo: PartyPhoto) {
  broadcast({ type: 'photo:new', photo });
}

export function requestPlayerPlay(trackId: string) {
  const state = store.state();
  if (state.current?.id === trackId) {
    pushToPlayers({
      type: 'player:play',
      track: state.current,
      position: 0,
    });
  }
}
