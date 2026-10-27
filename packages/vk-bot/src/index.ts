/**
 * VK community bot via Bots Long Poll API (no extra deps).
 *
 * Env:
 *   VK_GROUP_TOKEN   — community token with messages permission
 *   VK_GROUP_ID      — numeric group id
 *   API_URL          — dj-sync backend (default http://localhost:3000)
 *   BOT_SHARED_TOKEN — optional shared secret for backend
 */

const VK_TOKEN = process.env.VK_GROUP_TOKEN;
const VK_GROUP_ID = Number(process.env.VK_GROUP_ID || 0);
const API = process.env.API_URL || 'http://localhost:3000';
const BOT_TOKEN = process.env.BOT_SHARED_TOKEN || '';

if (!VK_TOKEN || !VK_GROUP_ID) {
  console.error('VK_GROUP_TOKEN and VK_GROUP_ID are required');
  process.exit(1);
}

const API_VER = '5.199';

async function vk<T>(method: string, params: Record<string, string | number | undefined>): Promise<T> {
  const body = new URLSearchParams({ v: API_VER });
  body.set('access_token', VK_TOKEN!);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) body.set(k, String(v));
  }
  const res = await fetch(`https://api.vk.com/method/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = (await res.json()) as { response?: T; error?: { error_msg: string } };
  if (json.error) throw new Error(`VK ${method}: ${json.error.error_msg}`);
  return json.response as T;
}

async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (BOT_TOKEN) headers.authorization = `Bearer ${BOT_TOKEN}`;
  let body = init?.body;
  if (init?.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  const res = await fetch(`${API}${path}`, { ...init, headers, body });
  if (!res.ok) {
    throw new Error(`${path} → ${res.status} ${await res.text().then((t) => t.slice(0, 200))}`);
  }
  return res.json() as Promise<T>;
}

interface VkMessage {
  id: number;
  from_id: number;
  peer_id: number;
  text: string;
  attachments?: {
    type: string;
    audio?: { id: number; owner_id: number; artist?: string; title?: string; url?: string };
    doc?: { url?: string; title?: string };
    link?: { url?: string; title?: string };
  }[];
  action?: { type: string };
}

interface LongPoll {
  ts: string;
  updates: number[][];
  failed?: number;
}

let ts: string | undefined;

async function getLongPoll(): Promise<{ server: string; key: string; ts: string }> {
  const res = await vk<{ server: string; key: string; ts: string }>(
    'groups.getLongPollServer',
    { group_id: VK_GROUP_ID }
  );
  return res;
}

async function pollOnce(server: string, key: string): Promise<LongPoll> {
  const url = `${server}?act=a_check&key=${key}&ts=${ts}&wait=25`;
  const res = await fetch(url);
  return (await res.json()) as LongPoll;
}

function guestIdFor(userId: number): string {
  return `vk-${userId}`;
}

async function send(peerId: number, text: string) {
  await vk('messages.send', {
    peer_id: peerId,
    message: text,
    random_id: Date.now(),
  });
}

async function handleMessage(msg: VkMessage) {
  const from = msg.from_id;
  const text = (msg.text || '').trim();

  // join on first contact
  await api('/api/join', {
    method: 'POST',
    json: { nickname: `vk-${from}`, guestId: guestIdFor(from) },
  }).catch(() => {});

  if (msg.action?.type === 'chat_invite_user') {
    await send(
      msg.peer_id,
      'Я DJ Sync. Кидай название / ссылку / аудио — добавлю в очередь. Команды: очередь, скип'
    );
    return;
  }

  const lower = text.toLowerCase();
  if (lower === 'помощь' || lower === 'help' || lower === 'что ты умеешь') {
    await send(
      msg.peer_id,
      [
        'Кинь:',
        '• название: Daft Punk — One More Time',
        '• ссылку на YouTube / Spotify / Я.Музыку',
        '• аудиосообщение или файл',
        '',
        'Команды: «очередь», «скип»',
      ].join('\n')
    );
    return;
  }
  if (lower === 'очередь' || lower === 'queue') {
    await sendQueue(msg.peer_id);
    return;
  }
  if (lower === 'скип' || lower === 'skip') {
    try {
      const votes = await api<{ count: number; threshold: number; needed: number }>('/api/skip', {
        method: 'POST',
        json: { guestId: guestIdFor(from), action: 'vote' },
      });
      await send(
        msg.peer_id,
        `Голос за пропуск учтён. ${votes.count}/${votes.threshold} (ещё ${votes.needed})`
      );
    } catch (err) {
      await send(msg.peer_id, `Не вышло: ${err instanceof Error ? err.message : 'ошибка'}`);
    }
    return;
  }

  // attachments: audio / doc / link
  const attachments = msg.attachments || [];
  const audio = attachments.find((a) => a.type === 'audio' && a.audio);
  const doc = attachments.find((a) => a.type === 'doc' && a.doc);
  const link = attachments.find((a) => a.type === 'link' && a.link);

  if (audio?.audio) {
    // VK audio URLs are often tokenized/expiring; fall back to search by artist+title
    const a = audio.audio;
    const title = [a.artist, a.title].filter(Boolean).join(' — ');
    await submit({ title: title || 'VK audio', url: undefined, guestId: guestIdFor(from) });
    return;
  }

  if (doc?.doc?.url) {
    await submit({
      title: text || doc.doc.title,
      url: doc.doc.url,
      guestId: guestIdFor(from),
    });
    return;
  }

  const urlInText = extractUrl(text);
  const url = link?.link?.url || urlInText;
  const title = url ? text.replace(url, '').trim() || link?.link?.title : text;

  if (!title && !url) return;

  await submit({ title, url, guestId: guestIdFor(from) });
}

async function submit(opts: { title?: string; url?: string; guestId: string }) {
  await api('/api/internal/tracks', {
    method: 'POST',
    json: {
      title: opts.title,
      url: opts.url,
      requestedBy: `VK ${opts.guestId}`,
      guestId: opts.guestId,
    },
  });
}

async function sendQueue(peerId: number) {
  try {
    const state = await api<{
      current: { title: string; requestedBy: string } | null;
      upcoming: { title: string; requestedBy: string; status: string }[];
      votes: { count: number; threshold: number };
      playerConnected: boolean;
      listeners: number;
    }>('/api/state');

    const lines: string[] = [
      state.playerConnected ? 'Динамик подключён' : 'Динамик НЕ подключён',
      `Гостей: ${state.listeners}`,
      '',
      state.current
        ? `▶️ ${state.current.title} — ${state.current.requestedBy}`
        : '▶️ Ничего не играет',
    ];
    if (state.upcoming.length) {
      lines.push('', 'Очередь:');
      state.upcoming.slice(0, 10).forEach((t, i) => {
        lines.push(`${i + 1}. ${t.title} — ${t.requestedBy}`);
      });
    } else {
      lines.push('', 'Очередь пуста');
    }
    lines.push('', `Скип: ${state.votes.count}/${state.votes.threshold}`);
    await send(peerId, lines.join('\n'));
  } catch (err) {
    await send(peerId, `Ошибка очереди: ${err instanceof Error ? err.message : 'ошибка'}`);
  }
}

function extractUrl(text: string): string | undefined {
  const m = /https?:\/\/\S+/i.exec(text);
  return m?.[0]?.replace(/[.,);]+$/, '');
}

// ---------- long poll loop ----------

async function main() {
  console.log('VK bot starting…');
  let lp = await getLongPoll();
  ts = lp.ts;
  console.log('VK long poll ready');

  while (true) {
    try {
      const data = await pollOnce(lp.server, lp.key);
      if (data.ts) ts = data.ts;
      if (data.failed) {
        console.warn('long poll failed', data);
        lp = await getLongPoll();
        ts = lp.ts;
        continue;
      }
      for (const upd of data.updates) {
        const type = upd[0];
        if (type !== 4) continue;
        // 4 = message_new: [4, msg_id, flags, peer_id, ts, text, extra, payload]
        const [, msgId, , peerId, , text, extra] = upd;
        void extra;
        // extra may be object with attach1_type etc. when using getLongPollServer (not raw).
        // Safer: fetch message via messages.getById
        const full = await vk<{ items: VkMessage[] }>('messages.getById', {
          message_ids: msgId,
        }).catch(() => null);
        const message: VkMessage =
          full?.items?.[0] ??
          ({
            id: msgId,
            from_id: 0,
            peer_id: peerId,
            text: String(text || ''),
            attachments: [],
          } as VkMessage);

        if (message.from_id === 0) {
          message.from_id = (extra as any)?.from || -1;
        }
        // skip own messages
        if (message.from_id < 0) continue;
        await handleMessage(message).catch((err) => {
          console.error('handleMessage', err);
        });
      }
    } catch (err) {
      console.error('poll error', err);
      await new Promise((r) => setTimeout(r, 3000));
      try {
        lp = await getLongPoll();
        ts = lp.ts;
      } catch {
        /* retry later */
      }
    }
  }
}

await main();
