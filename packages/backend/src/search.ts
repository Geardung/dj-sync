import type { SearchHit } from '@dj-sync/shared';
import { MAX_TRACK_DURATION_SEC } from '@dj-sync/shared';
import { YTDLP, ytdlpEnv, runProcess } from './ytdlp.js';

export { MAX_TRACK_DURATION_SEC };

function runYtdlp(args: string[], timeoutMs = 20_000): Promise<string> {
  return runProcess(YTDLP, args, timeoutMs, ytdlpEnv()).then(({ code, stdout, stderr }) => {
    // yt-dlp exits non-zero on some filter cases; parse what we got
    if (!stdout.trim() && code !== 0) {
      throw new Error(stderr.trim().slice(0, 200) || 'search failed');
    }
    return stdout;
  });
}

/**
 * Lightweight YouTube search — flat playlist metadata only, no download.
 * Order is stable (source order); tracks longer than 5 minutes are dropped.
 */
export async function searchTracks(query: string, limit = 6, maxDurationSec = 0): Promise<SearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  const n = Math.min(Math.max(limit, 1), 10);
  const stdout = await runYtdlp([
    '--flat-playlist',
    '--dump-json',
    '--no-warnings',
    `ytsearch${n}:${q}`,
  ]);

  const hits: SearchHit[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const raw = JSON.parse(trimmed) as {
        id?: string;
        title?: string;
        duration?: number;
        url?: string;
        webpage_url?: string;
        thumbnails?: Array<{ url?: string }>;
        artist?: string;
        channel?: string;
      };
      const id = raw.id;
      if (!id) continue;
      const durationSec = typeof raw.duration === 'number' ? Math.round(raw.duration) : null;
      // duration cap (0 = no limit)
      if (maxDurationSec > 0 && durationSec != null && durationSec > maxDurationSec) continue;
      const thumb = raw.thumbnails?.length
        ? raw.thumbnails[raw.thumbnails.length - 1]?.url ?? raw.thumbnails[0]?.url
        : null;
      hits.push({
        id,
        title: raw.title || id,
        artist: raw.artist || raw.channel || undefined,
        durationSec,
        thumbnailUrl: thumb ?? null,
        url: raw.webpage_url || raw.url || `https://www.youtube.com/watch?v=${id}`,
      });
    } catch {
      /* skip bad line */
    }
  }
  return hits;
}
