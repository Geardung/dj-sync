import { Bot, Context, InlineKeyboard } from 'grammy';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API = process.env.API_URL || 'http://localhost:3000';
const WEB_APP_URL = process.env.WEB_APP_URL || 'http://localhost:8080';
const BOT_TOKEN = process.env.BOT_SHARED_TOKEN || '';

if (!TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN is required');
  process.exit(1);
}

const bot = new Bot(TOKEN);

function displayName(ctx: Context): string {
  const u = ctx.from;
  if (!u) return 'Guest';
  return u.username || [u.first_name, u.last_name].filter(Boolean).join(' ') || `tg${u.id}`;
}

async function api<T>(
  path: string,
  init?: RequestInit & { json?: unknown }
): Promise<T> {
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
    const text = await res.text();
    throw new Error(`${path} → ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

bot.command('start', async (ctx) => {
  const name = displayName(ctx);
  await api('/api/join', { method: 'POST', json: { nickname: name, guestId: `tg-${ctx.from!.id}` } });

  const kb = new InlineKeyboard();
  if (WEB_APP_URL.startsWith('https://')) {
    kb.webApp('Открыть очередь', WEB_APP_URL).row();
  }
  kb.text('Что умею?', 'help').text('Очередь', 'queue');

  await ctx.reply(
    [
      `Привет, ${name}! Я DJ Sync — общая очередь вечеринки.`,
      '',
      '• Пришли название трека, ссылку (YouTube / Spotify / Я.Музыка) или аудиофайл',
      '• /queue — что сейчас играет',
      '• /skip — проголосовать за пропуск',
      '',
      WEB_APP_URL.startsWith('https://')
        ? 'Или открой мини-апп кнопкой ниже.'
        : `Веб: ${WEB_APP_URL}`,
    ].join('\n'),
    { reply_markup: kb }
  );
});

bot.command('help', async (ctx) => {
  await ctx.reply(
    [
      'Как кинуть трек:',
      '1) Просто напиши название: `Daft Punk — One More Time`',
      '2) Или кинь ссылку на YouTube / Spotify / Я.Музыку',
      '3) Или отправь аудиофайл / голосовое',
      '',
      '/queue — очередь · /skip — голос за пропуск',
    ].join('\n'),
    { parse_mode: 'Markdown' }
  );
});

bot.command('queue', async (ctx) => {
  await sendQueue(ctx);
});

bot.command('skip', async (ctx) => {
  try {
    const votes = await api<{ count: number; threshold: number; needed: number }>('/api/skip', {
      method: 'POST',
      json: { guestId: `tg-${ctx.from!.id}`, action: 'vote' },
    });
    await ctx.reply(
      `Голос за пропуск учтён. ${votes.count}/${votes.threshold} (ещё ${votes.needed})`
    );
  } catch (err) {
    await ctx.reply(`Не вышло: ${err instanceof Error ? err.message : 'ошибка'}`);
  }
});

bot.callbackQuery('help', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply('Кинь название, ссылку или аудио — я добавлю в очередь.');
});

bot.callbackQuery('queue', async (ctx) => {
  await ctx.answerCallbackQuery();
  await sendQueue(ctx);
});

bot.on('message:text', async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;
  await handleSubmission(ctx, { title: undefined, url: undefined, text });
});

bot.on('message:audio', async (ctx) => {
  const audio = ctx.message.audio;
  await handleFileSubmission(ctx, audio.file_id, audio.file_name || `${audio.performer || ''} ${audio.title || ''}`.trim() || 'audio');
});

bot.on('message:voice', async (ctx) => {
  await handleFileSubmission(ctx, ctx.message.voice.file_id, 'voice');
});

bot.on('message:document', async (ctx) => {
  const doc = ctx.message.document;
  const mime = doc.mime_type || '';
  if (!mime.startsWith('audio/') && !/\.(mp3|m4a|ogg|wav|flac)$/i.test(doc.file_name || '')) {
    await ctx.reply('Нужен аудиофайл (mp3/m4a/ogg/wav).');
    return;
  }
  await handleFileSubmission(ctx, doc.file_id, doc.file_name || 'audio');
});

async function handleSubmission(
  ctx: Context,
  opts: { title?: string; url?: string; text: string }
) {
  const raw = opts.text;
  const url = extractUrl(raw);
  const title = url ? raw.replace(url, '').trim() || undefined : raw;

  try {
    await api('/api/internal/tracks', {
      method: 'POST',
      json: {
        title,
        url,
        requestedBy: displayName(ctx),
        guestId: `tg-${ctx.from!.id}`,
      },
    });
    await ctx.reply('✅ В очередь. Готовим трек…');
  } catch (err) {
    await ctx.reply(`❌ ${err instanceof Error ? err.message : 'ошибка'}`);
  }
}

async function handleFileSubmission(ctx: Context, fileId: string, name: string) {
  try {
    const file = await bot.api.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;
    const res = await fetch(fileUrl);
    if (!res.ok) throw new Error('tg file download failed');
    const buf = Buffer.from(await res.arrayBuffer());

    const form = new FormData();
    form.append('file', new Blob([buf]), name);
    form.append('title', name);
    form.append('requestedBy', displayName(ctx));
    form.append('guestId', `tg-${ctx.from!.id}`);

    const headers: Record<string, string> = {};
    if (BOT_TOKEN) headers.authorization = `Bearer ${BOT_TOKEN}`;

    const upload = await fetch(`${API}/api/internal/upload`, {
      method: 'POST',
      headers,
      body: form,
    });
    if (!upload.ok) throw new Error(await upload.text());
    await ctx.reply('✅ Файл в очереди.');
  } catch (err) {
    await ctx.reply(`❌ ${err instanceof Error ? err.message : 'ошибка'}`);
  }
}

async function sendQueue(ctx: Context) {
  try {
    const state = await api<{
      current: { title: string; requestedBy: string } | null;
      upcoming: { title: string; requestedBy: string; status: string }[];
      votes: { count: number; threshold: number };
      playerConnected: boolean;
      listeners: number;
    }>('/api/state');

    const lines: string[] = [];
    lines.push(
      state.playerConnected ? '🔊 Динамик подключён' : '⚠️ Динамик не подключён',
      `Гостей: ${state.listeners}`,
      ''
    );
    if (state.current) {
      lines.push(`▶️ ${state.current.title} — ${state.current.requestedBy}`);
    } else {
      lines.push('▶️ Ничего не играет');
    }
    if (state.upcoming.length) {
      lines.push('', 'Очередь:');
      state.upcoming.slice(0, 10).forEach((t, i) => {
        lines.push(`${i + 1}. ${t.title} — ${t.requestedBy}${t.status === 'resolving' ? ' …' : ''}`);
      });
    } else {
      lines.push('', 'Очередь пуста — кинь трек!');
    }
    lines.push('', `Скип: ${state.votes.count}/${state.votes.threshold}`);
    await ctx.reply(lines.join('\n'));
  } catch (err) {
    await ctx.reply(`Не удалось получить очередь: ${err instanceof Error ? err.message : 'ошибка'}`);
  }
}

function extractUrl(text: string): string | undefined {
  const m = /https?:\/\/\S+/i.exec(text);
  return m?.[0]?.replace(/[.,);]+$/, '');
}

bot.catch((err) => {
  console.error('bot error', err.error);
});

console.log('Telegram bot starting…');
await bot.start({
  onStart: (me) => console.log(`Telegram bot @${me.username} ready`),
  drop_pending_updates: true,
});
