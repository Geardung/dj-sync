import { spawn } from 'node:child_process';
import { nanoid } from 'nanoid';
import path from 'node:path';
import fs from 'node:fs/promises';
import { normalizeAudio } from './normalize.js';
import { mirrorRemoteImage, s3Enabled, makeKey, uploadBuffer } from './s3.js';

const YTDLP = process.env.YTDLP_BIN || 'yt-dlp';
const AUDIO_DIR = process.env.AUDIO_DIR || path.resolve('data/audio');
/** party tracks are capped at 5 minutes */
export const MAX_TRACK_DURATION_SEC = 300;

/**
 * YTDLP_PROXY включает туннель (напр. http://vpn-gateway:12334).
 * Без него yt-dlp ходит напрямую и намеренно НЕ наследует HTTP_PROXY контейнера:
 * googlevideo подписывает URL под IP запросившего, смешивать пути нельзя.
 */
function ytdlpEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.HTTP_PROXY;
  delete env.HTTPS_PROXY;
  delete env.http_proxy;
  delete env.https_proxy;
  const proxy = process.env.YTDLP_PROXY?.trim();
  if (proxy) {
    env.HTTP_PROXY = proxy;
    env.HTTPS_PROXY = proxy;
    env.http_proxy = proxy;
    env.https_proxy = proxy;
  }
  return env;
}

export interface ResolvedAudio {
  title: string;
  artist?: string;
  durationSec: number | null;
  coverUrl: string | null;
  fileName: string;
  /** public URL (S3) or local /audio/ path */
  audioUrl: string;
  origin: string;
  source: 'youtube' | 'search' | 'direct';
}

function run(
  cmd: string,
  args: string[],
  timeoutMs = 90_000,
  env?: NodeJS.ProcessEnv
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, ...(env ? { env } : {}) });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

function isYoutubeUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    const h = u.hostname.replace(/^www\./, '');
    return (
      h === 'youtube.com' ||
      h === 'm.youtube.com' ||
      h === 'music.youtube.com' ||
      h === 'youtu.be' ||
      h === 'youtube-nocookie.com'
    );
  } catch {
    return false;
  }
}

function isProbablyUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Mirror a finished audio file to S3 (if configured).
 * Playback always uses the same-origin /audio/ path: the Web Audio analyser
 * needs crossOrigin='anonymous', and the S3 bucket serves no CORS headers.
 */
export async function publishAudioFile(fileName: string): Promise<string> {
  const localPath = path.join(AUDIO_DIR, path.basename(fileName));
  const localUrl = `/audio/${path.basename(fileName)}`;
  if (s3Enabled()) {
    try {
      const buf = await fs.readFile(localPath);
      const ext = path.extname(fileName) || '.mp3';
      const key = makeKey('tracks', ext);
      await uploadBuffer(key, buf, ext === '.mp3' ? 'audio/mpeg' : 'audio/*');
    } catch (err) {
      console.error('[s3] track mirror failed', err instanceof Error ? err.message : err);
    }
  }
  return localUrl;
}

/**
 * Resolve a user submission (URL, Spotify/Yandex link, or free-text title)
 * into a downloadable audio target, download to AUDIO_DIR, return metadata.
 */
export async function resolveAndDownload(
  input: {
    url?: string;
    title?: string;
  },
  opts: {
    /** yt-dlp --match-filter, e.g. "duration <= 300" to skip long mixes */
    matchFilter?: string;
    /** how many yt-search candidates to consider (default 1) */
    searchCount?: number;
    /** max duration seconds; 0 or undefined = no limit */
    maxDurationSec?: number;
  } = {}
): Promise<ResolvedAudio> {
  await fs.mkdir(AUDIO_DIR, { recursive: true });

  const url = input.url?.trim();
  const title = input.title?.trim();
  if (!url && !title) throw new Error('url or title required');

  let target: string;
  let source: ResolvedAudio['source'];

  if (url && isYoutubeUrl(url)) {
    target = url;
    source = 'youtube';
  } else if (url && isProbablyUrl(url) && !isSpotifyLike(url) && !isYandexLike(url)) {
    // direct media URL (rare, e.g. a public mp3)
    target = url;
    source = 'direct';
  } else {
    // Spotify / Yandex Music / just a title → search on YouTube
    const q = title || titleFromUrl(url!) || url!;
    const n = Math.max(1, Math.min(opts.searchCount ?? 1, 10));
    target = `ytsearch${n}:${q}`;
    source = 'search';
  }

  const id = nanoid(12);
  const outTemplate = path.join(AUDIO_DIR, `${id}.%(ext)s`);

  const args = [
    '--no-playlist',
    '--no-warnings',
    '--newline',
    '-x',
    '--audio-format',
    'mp3',
    '--audio-quality',
    '0',
  ];
  // duration cap (0 = no limit)
  const maxDur = opts.maxDurationSec ?? 0;
  const matchFilter = opts.matchFilter || (maxDur > 0 ? `duration <= ${maxDur}` : '');
  if (matchFilter) args.push('--match-filter', matchFilter);
  // ytsearchN + match-filter would download every match — take just one
  if ((opts.searchCount ?? 1) > 1) {
    args.push('--max-downloads', '1');
  }
  args.push(
    '--print',
    '%(title)s',
    '--print',
    '%(duration)s',
    '--print',
    '%(thumbnail)s',
    '--print',
    'after_move:filepath',
    '-o',
    outTemplate,
    target
  );

  const { code, stdout, stderr } = await run(YTDLP, args, 90_000, ytdlpEnv());
  // 101 = --max-downloads hit; still a success if we printed a filepath
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const hasFile = lines.some((l) => /\.[a-z0-9]{2,5}$/i.test(l));
  if (code !== 0 && !(code === 101 && hasFile)) {
    const msg = stderr.slice(-400) || stdout.slice(-400) || 'unknown';
    if (/duration/i.test(msg) || /Filter/i.test(msg)) {
      throw new Error('Трек длиннее 5 минут — на тусовке только короткие');
    }
    throw new Error(`yt-dlp failed: ${msg}`);
  }

  // after_move:filepath is always printed last; other fields first in arg order
  const filePath = [...lines].reverse().find((l) => /\.[a-z0-9]{2,5}$/i.test(l) || l.includes(id));
  if (!filePath) throw new Error('yt-dlp produced no file');

  const metaLines = lines.filter((l) => l !== filePath);
  // title, duration, thumbnail
  const titleOut = metaLines[0] || title || 'Unknown';
  const durationRaw = metaLines[1];
  const thumb = metaLines[2];

  const durationSec = durationRaw && durationRaw !== 'NA' ? Number(durationRaw) : null;
  const fileName = path.basename(filePath);

  // ensure file exists on disk (yt-dlp after_move path)
  await fs.access(path.join(AUDIO_DIR, fileName)).catch(async () => {
    // fallback: maybe print path is absolute already
    await fs.access(filePath);
  });

  // level-match to the ambient playlist (~-14 LUFS)
  try {
    await normalizeAudio(path.join(AUDIO_DIR, fileName));
  } catch (err) {
    console.error('[normalize] skipped', err instanceof Error ? err.message : err);
  }

  // post-check duration (match-filter is best-effort)
  if (maxDur > 0 && durationSec != null && durationSec > maxDur) {
    throw new Error(`Трек длиннее ${Math.floor(maxDur / 60)} мин — на тусовке только короткие`);
  }

  // mirror audio to S3 when configured
  const audioUrl = await publishAudioFile(fileName);

  let artist: string | undefined;
  // "Artist - Title" convention
  const m = /^(.+?)\s+-\s+(.+)$/.exec(titleOut);
  if (m) {
    artist = m[1].trim();
  }

  return {
    title: titleOut,
    artist,
    durationSec: Number.isFinite(durationSec) ? durationSec : null,
    // mirror YouTube thumbs into our storage — no hotlinking i.ytimg.com
    coverUrl: thumb && thumb !== 'NA' ? await mirrorRemoteImage(thumb, 'covers') : null,
    fileName,
    audioUrl,
    origin: url || `search: ${title}`,
    source,
  };
}

export async function saveUploadedFile(
  originalName: string,
  buffer: Buffer
): Promise<{ fileName: string; title: string; audioUrl: string; durationSec: number | null }> {
  await fs.mkdir(AUDIO_DIR, { recursive: true });
  const ext = (path.extname(originalName) || '.mp3').toLowerCase().replace(/[^a-z0-9.]/g, '');
  const safeExt = ['.mp3', '.m4a', '.ogg', '.wav', '.aac', '.flac', '.webm', '.opus'].includes(ext)
    ? ext
    : '.mp3';
  const fileName = `${nanoid(12)}${safeExt}`;
  const abs = path.join(AUDIO_DIR, fileName);
  await fs.writeFile(abs, buffer);
  try {
    await normalizeAudio(abs);
  } catch (err) {
    console.error('[normalize] skipped', err instanceof Error ? err.message : err);
  }

  // best-effort duration check via ffprobe (optional)
  let durationSec: number | null = null;
  try {
    const { stdout } = await run(
      process.env.FFPROBE_BIN || 'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', abs],
      15_000
    );
    const d = Number(stdout.trim());
    if (Number.isFinite(d)) durationSec = Math.round(d);
  } catch {
    /* no ffprobe — skip */
  }
  if (durationSec != null && durationSec > 3600) {
    throw new Error('Трек слишком длинный');
  }

  const audioUrl = await publishAudioFile(fileName);
  const base = path.basename(originalName, path.extname(originalName));
  return { fileName, title: base || 'Uploaded track', audioUrl, durationSec };
}

function isSpotifyLike(u: string): boolean {
  return /(^|\/\/)(open\.)?spotify\.com/i.test(u) || u.includes('spotify:track:');
}

function isYandexLike(u: string): boolean {
  return /music\.yandex\.(ru|com|by|kz|ua)/i.test(u);
}

function titleFromUrl(u: string): string {
  try {
    const parsed = new URL(u);
    const last = parsed.pathname.split('/').filter(Boolean).pop() || parsed.hostname;
    return decodeURIComponent(last).replace(/[-_+]/g, ' ');
  } catch {
    return u;
  }
}

export function audioFilePath(fileName: string): string {
  // prevent path traversal
  const safe = path.basename(fileName);
  return path.join(AUDIO_DIR, safe);
}

export function audioDir(): string {
  return AUDIO_DIR;
}
