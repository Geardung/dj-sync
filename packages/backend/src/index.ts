import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import fs from 'node:fs';
import path from 'node:path';
import type {
  JoinRequest,
  JoinResponse,
  PartyState,
  SubmitTrackRequest,
  SubmitTrackResponse,
  Track,
} from '@dj-sync/shared';
import { store } from './store.js';
import { audioDir, resolveAndDownload, saveUploadedFile } from './resolve.js';
import { FallbackPlayer } from './fallback.js';
import { notifyPhoto, notifyToast, registerWs, requestPlayerPlay } from './ws.js';
import {
  ensurePhotosDir,
  photosDir,
  savePhoto,
  deletePhotoByMeta,
  loadPhotosFromDisk,
  createPresignedUpload,
  photoFromUpload,
} from './photos.js';
import { searchTracks } from './search.js';
import { s3Enabled } from './s3.js';

const fallback = new FallbackPlayer(store);
store.onNeedFallbackPlay(() => {
  void fallback.ensurePlaying();
});
store.onUserTrack(() => {
  fallback.notifyUserTrackReady();
  fallback.pruneRecent();
});

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const WEB_ORIGIN = process.env.WEB_ORIGIN || 'http://localhost:8080';
const BOT_TOKEN = process.env.BOT_SHARED_TOKEN || '';

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: true,
  credentials: true,
});
await app.register(multipart, {
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});
await app.register(websocket);

fs.mkdirSync(audioDir(), { recursive: true });
await ensurePhotosDir();
store.setPhotos(await loadPhotosFromDisk());

await app.register(fastifyStatic, {
  root: audioDir(),
  prefix: '/audio/',
  decorateReply: false,
});

await app.register(fastifyStatic, {
  root: photosDir(),
  prefix: '/photos/',
  decorateReply: false,
});

const imgDir = process.env.IMG_DIR || path.resolve('assets');
await app.register(fastifyStatic, {
  root: imgDir,
  prefix: '/img/',
  decorateReply: false,
});

registerWs(app);

function requireBot(req: { headers: Record<string, unknown> }) {
  if (!BOT_TOKEN) return true;
  const auth = req.headers.authorization || '';
  return auth === `Bearer ${BOT_TOKEN}` || req.headers['x-bot-token'] === BOT_TOKEN;
}

// ---------- REST ----------

app.get('/health', async () => ({ ok: true, now: Date.now() }));

app.get('/api/state', async (): Promise<PartyState> => store.state());

app.post('/api/join', async (req, reply) => {
  const body = req.body as JoinRequest;
  if (!body?.nickname || typeof body.nickname !== 'string') {
    return reply.code(400).send({ error: 'nickname required' });
  }
  const res = store.join(body.nickname, body.guestId);
  return res satisfies JoinResponse;
});

app.post('/api/tracks', async (req, reply) => {
  const ct = req.headers['content-type'] || '';

  // multipart upload (file or fields)
  if (ct.includes('multipart/form-data')) {
    const parts = req.parts();
    let title = '';
    let url = '';
    let fileBuf: Buffer | null = null;
    let fileName = '';

    for await (const part of parts) {
      if (part.type === 'file') {
        fileBuf = await part.toBuffer();
        fileName = part.filename || 'track.mp3';
      } else if (part.fieldname === 'title' && typeof part.value === 'string') {
        title = part.value;
      } else if (part.fieldname === 'url' && typeof part.value === 'string') {
        url = part.value;
      } else if (part.fieldname === 'requestedBy' && typeof part.value === 'string') {
        title = title; // no-op, keep
      }
    }

    const requestedBy = 'Web guest';
    // guest identity from query
    const q = req.query as { guestId?: string; requestedBy?: string };
    const guestId = q.guestId;
    const who = q.requestedBy || requestedBy;

    if (fileBuf && fileName) {
      if (!store.canAcceptTrack()) {
        return reply.code(409).send({
          error: `В очереди уже ${store.getQueueLimit()} трек(ов). Подожди, пока текущий начнёт играть.`,
          queueLimit: store.getQueueLimit(),
        });
      }
      const saved = await saveUploadedFile(fileName, fileBuf);
      const track = store.addTrack({
        title: title || saved.title,
        origin: `file: ${fileName}`,
        source: 'file',
        requestedBy: who,
        requestedByGuestId: guestId ?? null,
        audioUrl: saved.audioUrl,
        durationSec: saved.durationSec ?? null,
        coverUrl: null,
        error: null,
        status: 'ready',
      });
      if (!store.state().current) store.kickUserTracks();
      const pos = queuePosOf(track.id);
      const res: SubmitTrackResponse = { track, ...pos };
      return res;
    }

    // multipart but only title/url
    if (url || title) {
      return enqueueResolve({ url, title, who, guestId }, reply);
    }

    return reply.code(400).send({ error: 'file, url or title required' });
  }

  // JSON: title and/or url
  const body = (req.body ?? {}) as SubmitTrackRequest & {
    requestedBy?: string;
    guestId?: string;
  };
  const title = body.title?.trim();
  const url = body.url?.trim();
  if (!title && !url) {
    return reply.code(400).send({ error: 'title or url required' });
  }
  return enqueueResolve(
    {
      url,
      title,
      who: body.requestedBy || 'Web guest',
      guestId: body.guestId,
    },
    reply
  );
});

async function enqueueResolve(
  input: { url?: string; title?: string; who: string; guestId?: string },
  reply: any
): Promise<SubmitTrackResponse | unknown> {
  if (!store.canAcceptTrack()) {
    return reply.code(409).send({
      error: `В очереди уже ${store.getQueueLimit()} трек(ов). Подожди, пока текущий начнёт играть.`,
      queueLimit: store.getQueueLimit(),
      queueSlotsLeft: 0,
    });
  }
  const origin = input.url || `search: ${input.title}`;
  const provisionalTitle = input.title || prettyFromUrl(input.url || '');
  const track = store.addTrack({
    title: provisionalTitle,
    origin,
    source: input.url ? 'youtube' : 'search',
    requestedBy: input.who,
    requestedByGuestId: input.guestId ?? null,
    audioUrl: null,
    durationSec: null,
    coverUrl: null,
    error: null,
    status: 'resolving',
  });

  // fire and forget resolve
  void (async () => {
    try {
      const resolved = await resolveAndDownload({ url: input.url, title: input.title }, { maxDurationSec: store.getMaxDuration() });
      store.markTrackReady(track.id, resolved.audioUrl, {
        title: resolved.title,
        artist: resolved.artist,
        durationSec: resolved.durationSec,
        coverUrl: resolved.coverUrl,
        source: resolved.source,
      });
      notifyToast('success', `Готово: ${resolved.title}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'resolve failed';
      store.markTrackFailed(track.id, message);
      notifyToast('error', `Не удалось подготовить трек: ${message.slice(0, 160)}`);
    }
  })();

  const pos = queuePosOf(track.id);
  return reply.code(202).send({ track, ...pos } satisfies SubmitTrackResponse);
}

/** 1-based position of a track in the waiting queue + total waiting. */
function queuePosOf(trackId: string): { queueIndex: number; queueTotal: number } {
  const upcoming = store.state().upcoming;
  const idx = upcoming.findIndex((t) => t.id === trackId);
  return {
    queueIndex: idx >= 0 ? idx + 1 : upcoming.length,
    queueTotal: upcoming.length || 1,
  };
}

app.post('/api/skip', async (req, reply) => {
  const body = req.body as { guestId?: string; action?: 'vote' | 'unvote' };
  if (!body?.guestId) return reply.code(400).send({ error: 'guestId required' });
  if (body.action === 'unvote') {
    return store.unvoteSkip(body.guestId);
  }
  return store.voteSkip(body.guestId);
});

app.delete('/api/tracks/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const ok = store.removeTrack(id);
  if (!ok) return reply.code(404).send({ error: 'not found in queue' });
  return store.state();
});

app.post('/api/tracks/:id/move', async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = (req.body ?? {}) as { dir?: 'up' | 'down' };
  const dir = body.dir === 'up' || body.dir === 'down' ? body.dir : null;
  if (!dir) return reply.code(400).send({ error: "dir must be 'up' or 'down'" });
  const ok = store.moveTrack(id, dir);
  if (!ok) return reply.code(400).send({ error: 'cannot move' });
  return store.state();
});

app.post('/api/tracks/:id/play', async (req, reply) => {
  const { id } = req.params as { id: string };
  const t = store.playTrackNow(id);
  if (!t) return reply.code(404).send({ error: 'not found in queue' });
  requestPlayerPlay(t.id);
  return store.state();
});

app.post('/api/player/command', async (req, reply) => {
  if (!requireBot(req as never) && req.headers.authorization) {
    // allow web player UI commands without bot token
  }
  const body = req.body as { action: string; volume?: number; trackId?: string };
  switch (body.action) {
    case 'pause':
      store.setPaused(true);
      break;
    case 'resume':
      store.setPaused(false);
      break;
    case 'skip':
      store.advance('manual');
      break;
    case 'volume':
      if (typeof body.volume === 'number') store.setVolume(body.volume);
      break;
    case 'fallback':
      store.setFallbackEnabled(Boolean((body as { enabled?: boolean }).enabled ?? true));
      break;
    case 'max-duration': {
      const sec = Number((req.body as any)?.sec ?? 0);
      store.setMaxDuration(sec);
      return store.state();
    }
    case 'queue-limit': {
      const raw = (body as { limit?: number }).limit;
      if (typeof raw !== 'number') return reply.code(400).send({ error: 'limit required' });
      store.setQueueLimit(raw);
      break;
    }
    case 'play-track':
      if (body.trackId) {
        // move track to front and play
        const t = store.patchTrack(body.trackId, { status: 'ready' });
        if (t) requestPlayerPlay(t.id);
      }
      break;
    default:
      return reply.code(400).send({ error: 'unknown action' });
  }
  return store.state();
});

// used by bots to push tracks
app.post('/api/internal/tracks', async (req, reply) => {
  if (!requireBot(req as never)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const body = req.body as {
    title?: string;
    url?: string;
    requestedBy?: string;
    guestId?: string;
  };
  return enqueueResolve(
    {
      url: body.url,
      title: body.title,
      who: body.requestedBy || 'Bot user',
      guestId: body.guestId,
    },
    reply
  );
});

app.post('/api/internal/upload', async (req, reply) => {
  if (!requireBot(req as never)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const ct = req.headers['content-type'] || '';
  if (!ct.includes('multipart/form-data')) {
    return reply.code(400).send({ error: 'multipart required' });
  }
  let fileBuf: Buffer | null = null;
  let fileName = 'track.mp3';
  let title = '';
  let who = 'Bot user';
  let guestId: string | undefined;
  for await (const part of req.parts()) {
    if (part.type === 'file') {
      fileBuf = await part.toBuffer();
      fileName = part.filename || fileName;
    } else if (typeof part.value === 'string') {
      if (part.fieldname === 'title') title = part.value;
      if (part.fieldname === 'requestedBy') who = part.value;
      if (part.fieldname === 'guestId') guestId = part.value;
    }
  }
  if (!fileBuf) return reply.code(400).send({ error: 'file required' });
  const saved = await saveUploadedFile(fileName, fileBuf);
  const track = store.addTrack({
    title: title || saved.title,
    origin: `file: ${fileName}`,
    source: 'file',
    requestedBy: who,
    requestedByGuestId: guestId ?? null,
    audioUrl: saved.audioUrl,
    durationSec: null,
    coverUrl: null,
    error: null,
    status: 'ready',
  });
  if (!store.state().current) store.kickUserTracks();
  return { track } satisfies SubmitTrackResponse;
});

// list audio files for debugging
app.get('/api/tracks/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const state = store.state();
  const all = [state.current, ...state.upcoming, ...state.recent].filter(Boolean) as Track[];
  const t = all.find((x) => x.id === id);
  if (!t) return reply.code(404).send({ error: 'not found' });
  return t;
});

app.get('/api/search', async (req, reply) => {
  const q = (req.query as { q?: string }).q?.trim() || '';
  if (!q) return reply.code(400).send({ error: 'q required' });
  try {
    const results = await searchTracks(q, 6, store.getMaxDuration());
    return { results };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'search failed';
    return reply.code(502).send({ error: message.slice(0, 200) });
  }
});

app.get('/api/photos', async () => ({ photos: store.listPhotos() }));

/** Presigned PUT straight to S3 — client uploads the bytes itself. */
app.post('/api/photos/presign', async (req, reply) => {
  const body = (req.body ?? {}) as { fileName?: string; contentType?: string };
  if (!s3Enabled()) {
    return reply.code(501).send({ error: 'S3 is not configured' });
  }
  try {
    const presign = await createPresignedUpload({
      fileName: body.fileName || 'photo.jpg',
      contentType: body.contentType || 'application/octet-stream',
    });
    return presign;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'presign failed';
    return reply.code(500).send({ error: message });
  }
});

/** Register a moment after the client finished the presigned PUT. */
app.post('/api/photos/register', async (req, reply) => {
  const body = (req.body ?? {}) as {
    id?: string;
    key?: string;
    url?: string;
    kind?: 'image' | 'video';
    uploadedBy?: string;
    guestId?: string;
  };
  if (!body.id || !body.key) return reply.code(400).send({ error: 'id and key required' });
  const photo = photoFromUpload({
    id: body.id,
    key: body.key,
    url: body.url || '',
    kind: body.kind === 'video' ? 'video' : 'image',
    uploadedBy: body.uploadedBy || 'Guest',
    uploadedByGuestId: body.guestId ?? null,
  });
  store.addPhoto(photo);
  notifyPhoto(photo);
  return { photo };
});

app.post('/api/photos', async (req, reply) => {
  const ct = req.headers['content-type'] || '';
  if (!ct.includes('multipart/form-data')) {
    return reply.code(400).send({ error: 'multipart required' });
  }
  let fileBuf: Buffer | null = null;
  let fileName = 'photo.jpg';
  let uploadedBy = 'Guest';
  let guestId: string | undefined;
  for await (const part of req.parts()) {
    if (part.type === 'file') {
      fileBuf = await part.toBuffer();
      fileName = part.filename || fileName;
    } else if (typeof part.value === 'string') {
      if (part.fieldname === 'uploadedBy') uploadedBy = part.value;
      if (part.fieldname === 'guestId') guestId = part.value;
    }
  }
  if (!fileBuf) return reply.code(400).send({ error: 'file required' });
  try {
    const photo = await savePhoto(fileName, fileBuf, {
      uploadedBy,
      uploadedByGuestId: guestId ?? null,
    });
    store.addPhoto(photo);
    notifyPhoto(photo);
    return { photo };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'upload failed';
    return reply.code(400).send({ error: message });
  }
});

app.delete('/api/photos/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const photo = store.listPhotos().find((p) => p.id === id);
  if (!photo) return reply.code(404).send({ error: 'not found' });
  await deletePhotoByMeta(photo);
  store.removePhoto(id);
  return { ok: true };
});

function prettyFromUrl(u: string): string {
  try {
    const parsed = new URL(u);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return u || 'Track';
  }
}

await app.listen({ port: PORT, host: HOST });
app.log.info(`dj-sync backend on ${HOST}:${PORT}`);
// start ambient lo-fi if the guest queue is empty
void fallback.ensurePlaying();
