import fs from 'node:fs/promises';
import path from 'node:path';
import type { Track } from '@dj-sync/shared';
import { audioDir } from './resolve.js';
import type { PartyStore } from './store.js';

/**
 * Ambient lo-fi is a single pre-made mix (no yt-dlp).
 * The same file is looped until a guest track takes over.
 */
const AMBIENT_FILE = 'lo-fi-halloween.mp3';
const AMBIENT_TITLE = 'Lo-Fi Halloween';

export class FallbackPlayer {
  private starting = false;

  constructor(private store: PartyStore) {}

  private ambientTrack(): Track {
    return {
      // stable id — player can detect "same ambient" and keep looping
      id: 'ambient-lofi',
      title: AMBIENT_TITLE,
      artist: 'Lo-Fi',
      audioUrl: `/audio/${AMBIENT_FILE}`,
      origin: 'lofi: local playlist',
      source: 'file',
      status: 'ready',
      durationSec: null,
      requestedBy: 'Lo-Fi',
      requestedByGuestId: null,
      coverUrl: '/img/lofi-cover.jpg',
      error: null,
      createdAt: Date.now(),
      startedAt: Date.now(),
      isFallback: true,
    } satisfies Track;
  }

  async ensurePlaying(): Promise<void> {
    if (!this.store.isFallbackEnabled()) return;
    if (this.store.state().current) return;
    if (this.starting) return;

    this.starting = true;
    try {
      const file = path.join(audioDir(), AMBIENT_FILE);
      await fs.access(file);
      if (!this.store.state().current && this.store.isFallbackEnabled()) {
        const track = this.ambientTrack();
        console.log('[fallback] start', track.title, track.audioUrl);
        this.store.startFallbackTrack(track);
      }
    } catch (err) {
      console.error(
        '[fallback] ambient file missing, put lo-fi-halloween.mp3 into data/audio —',
        err instanceof Error ? err.message : err
      );
    } finally {
      this.starting = false;
    }
  }

  /** Restart the same ambient mix (used when the player ends without loop). */
  restart(): void {
    if (!this.store.isFallbackEnabled()) return;
    const cur = this.store.state().current;
    if (!cur?.isFallback) return;
    const track = this.ambientTrack();
    track.startedAt = Date.now();
    this.store.startFallbackTrack(track);
  }

  notifyUserTrackReady(): void {
    /* guest track wins — nothing to preload */
  }

  pruneRecent(): void {
    /* single ambient file — nothing to clean */
  }
}
