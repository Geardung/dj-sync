import { nanoid } from 'nanoid';
import type {
  PartyPhoto,
  PartyState,
  SkipVoteState,
  Track,
  TrackSource,
} from '@dj-sync/shared';
import { skipThreshold } from '@dj-sync/shared';

interface Guest {
  id: string;
  nickname: string;
  joinedAt: number;
  lastSeenAt: number;
}

type Listener = (state: PartyState) => void;

const RECENT_LIMIT = 20;

export class PartyStore {
  private guests = new Map<string, Guest>();
  private queue: Track[] = [];
  private current: Track | null = null;
  private recent: Track[] = [];
  private votes = new Set<string>();
  private playerConnected = false;
  private volume = 1;
  private paused = false;
  private position = 0;
  private listeners = new Set<Listener>();
  private advancing = false;
  private fallbackEnabled = true;
  private ambientPosition = 0;
  private onNeedFallback: (() => void) | null = null;
  private onUserTrackReady: (() => void) | null = null;
  private photos: PartyPhoto[] = [];
  private queueLimit = 1;
  private maxDurationSec = 300;

  join(nickname: string, guestId?: string): { guestId: string; nickname: string } {
    const trimmed = nickname.trim().slice(0, 32) || 'Guest';
    const id = guestId && /^[\w-]{6,40}$/.test(guestId) ? guestId : nanoid(12);
    const now = Date.now();
    const existing = this.guests.get(id);
    if (existing) {
      existing.nickname = trimmed;
      existing.lastSeenAt = now;
    } else {
      this.guests.set(id, { id, nickname: trimmed, joinedAt: now, lastSeenAt: now });
    }
    this.emit();
    return { guestId: id, nickname: trimmed };
  }

  touch(guestId: string) {
    const g = this.guests.get(guestId);
    if (g) g.lastSeenAt = Date.now();
  }

  getGuest(guestId: string): Guest | undefined {
    return this.guests.get(guestId);
  }

  guestCount(): number {
    return this.guests.size;
  }

  setPlayerConnected(connected: boolean) {
    if (this.playerConnected === connected) return;
    this.playerConnected = connected;
    this.emit();
  }

  isPlayerConnected(): boolean {
    return this.playerConnected;
  }

  addTrack(partial: Omit<Track, 'id' | 'createdAt' | 'status'> & { status?: Track['status'] }): Track {
    const track: Track = {
      id: nanoid(10),
      createdAt: Date.now(),
      status: partial.status ?? 'resolving',
      audioUrl: partial.audioUrl ?? null,
      durationSec: partial.durationSec ?? null,
      coverUrl: partial.coverUrl ?? null,
      error: partial.error ?? null,
      startedAt: null,
      title: partial.title,
      artist: partial.artist,
      origin: partial.origin,
      source: partial.source as TrackSource,
      requestedBy: partial.requestedBy,
      requestedByGuestId: partial.requestedByGuestId,
      isFallback: partial.isFallback ?? false,
    };
    this.queue.push(track);
    this.emit();
    return track;
  }

  /** Start an ambient filler track (never enters the guest queue). */
  startFallbackTrack(track: Track) {
    if (this.current && !this.current.isFallback) return;
    if (this.current?.isFallback) {
      // already on ambient — just swap the file, don't spam recent
      this.current = null;
    }
    track.status = 'playing';
    track.startedAt = Date.now();
    track.isFallback = true;
    this.current = track;
    this.paused = false;
    // resume the lo-fi mix where we left it (0 only after a full ~2h pass)
    this.position = this.ambientPosition;
    this.votes.clear();
    this.emit();
  }

  getAmbientPosition(): number {
    return this.ambientPosition;
  }

  setAmbientPosition(pos: number) {
    if (Number.isFinite(pos) && pos >= 0) {
      this.ambientPosition = pos;
    }
  }

  setFallbackEnabled(enabled: boolean) {
    this.fallbackEnabled = enabled;
    if (!enabled && this.current?.isFallback) {
      this.advance('manual');
    } else if (enabled && !this.current && this.queue.every((t) => t.status !== 'ready')) {
      this.onNeedFallback?.();
    }
    this.emit();
  }

  isFallbackEnabled(): boolean {
    return this.fallbackEnabled;
  }

  onNeedFallbackPlay(fn: () => void) {
    this.onNeedFallback = fn;
  }

  onUserTrack(fn: () => void) {
    this.onUserTrackReady = fn;
  }

  pruneFallbackRecent(keep: number) {
    let kept = 0;
    this.recent = this.recent.filter((t) => {
      if (!t.isFallback) return true;
      kept += 1;
      return kept <= keep;
    });
    this.emit();
  }

  patchTrack(id: string, patch: Partial<Track>): Track | null {
    const t = this.queue.find((x) => x.id === id) || (this.current?.id === id ? this.current : null);
    if (!t) return null;
    Object.assign(t, patch);
    this.emit();
    return t;
  }

  markTrackReady(id: string, audioUrl: string, meta: Partial<Track>) {
    const t = this.patchTrack(id, {
      ...meta,
      audioUrl,
      status: 'ready',
      error: null,
    });
    if (!t) return t;
    // user queue takes priority over ambient lo-fi
    this.kickUserTracks();
    return t;
  }

  markTrackFailed(id: string, error: string) {
    this.patchTrack(id, { status: 'failed', error });
    // keep in queue so guests can see the error; advance() skips non-ready heads
    if (this.current?.id === id) {
      this.current.status = 'failed';
      this.pushRecent(this.current);
      this.current = null;
      this.votes.clear();
      this.advance('auto');
    } else if (!this.current) {
      this.advance('auto');
    }
    this.emit();
  }

  /** A guest track became playable — interrupt ambient if needed. */
  kickUserTracks() {
    if (this.current?.isFallback) {
      this.advance('auto');
    } else if (!this.current) {
      this.advance('auto');
    }
    this.onUserTrackReady?.();
  }

  /** Move next ready guest track to current. Fallback is never queued. */
  advance(reason: 'auto' | 'skip' | 'manual'): Track | null {
    if (this.advancing) return this.current;
    this.advancing = true;
    try {
      if (this.current) {
        if (this.current.isFallback) {
          // ambient slot — don't pollute guest history
          this.current = null;
        } else if (this.current.status === 'playing' || this.current.status === 'paused') {
          this.current.status = 'done';
          this.pushRecent(this.current);
          this.current = null;
        } else {
          this.current = null;
        }
      }
      this.votes.clear();
      this.paused = false;
      this.position = 0;

      // find next ready user track (skip resolving/failed)
      let next: Track | undefined;
      while (this.queue.length > 0) {
        const cand = this.queue[0]!;
        if (cand.status === 'ready') {
          next = this.queue.shift()!;
          break;
        }
        if (cand.status === 'resolving') {
          // guest track not ready yet — lo-fi fills the gap
          break;
        }
        this.queue.shift();
      }

      if (next && !next.isFallback) {
        next.status = 'playing';
        next.startedAt = Date.now();
        this.current = next;
      } else if (this.fallbackEnabled) {
        this.emit();
        this.onNeedFallback?.();
        return this.current;
      }
      this.emit();
      return this.current;
    } finally {
      this.advancing = false;
    }
  }

  private pushRecent(t: Track) {
    this.recent.unshift(t);
    if (this.recent.length > RECENT_LIMIT) this.recent.pop();
  }

  voteSkip(guestId: string): SkipVoteState {
    this.votes.add(guestId);
    // author veto: whoever queued this track can skip it alone
    const cur = this.current;
    if (
      cur &&
      !cur.isFallback &&
      cur.requestedByGuestId &&
      cur.requestedByGuestId === guestId
    ) {
      this.advance('skip');
      return this.votesState();
    }
    const state = this.votesState();
    if (state.count >= state.threshold && this.current) {
      this.advance('skip');
      return this.votesState();
    }
    this.emit();
    return state;
  }

  unvoteSkip(guestId: string): SkipVoteState {
    this.votes.delete(guestId);
    this.emit();
    return this.votesState();
  }

  votesState(): SkipVoteState {
    const activeGuests = Math.max(this.guests.size, 1);
    const threshold = skipThreshold(activeGuests);
    return {
      votes: Object.fromEntries([...this.votes].map((id) => [id, true as const])),
      count: this.votes.size,
      threshold,
      activeGuests,
      needed: Math.max(threshold - this.votes.size, 0),
    };
  }

  setPaused(paused: boolean) {
    this.paused = paused;
    if (this.current) {
      this.current.status = paused ? 'paused' : 'playing';
    }
    this.emit();
  }

  setPosition(position: number) {
    this.position = position;
    if (this.current?.isFallback) {
      this.ambientPosition = position;
    }
  }

  setVolume(volume: number) {
    this.volume = Math.min(1, Math.max(0, volume));
    this.emit();
  }

  addPhoto(photo: PartyPhoto) {
    this.photos.unshift(photo);
    if (this.photos.length > 40) this.photos.length = 40;
    this.emit();
    return photo;
  }

  setPhotos(photos: PartyPhoto[]) {
    this.photos = photos.slice(0, 40);
    this.emit();
  }

  setQueueLimit(n: number) {
    const v = Math.floor(Number(n));
    if (!Number.isFinite(v)) return;
    this.queueLimit = Math.max(1, Math.min(20, v));
    this.emit();
  }

  getQueueLimit(): number {
    return this.queueLimit;
  }

  setMaxDuration(sec: number): void {
    this.maxDurationSec = Math.max(0, Math.min(900, Math.round(sec)));
  }

  getMaxDuration(): number {
    return this.maxDurationSec;
  }

  /** How many guest tracks may still be added (current playing track is not counted). */
  queueSlotsLeft(): number {
    return Math.max(0, this.queueLimit - this.queue.length);
  }

  canAcceptTrack(): boolean {
    return this.queueSlotsLeft() > 0;
  }

  /** Remove a waiting track (never the one currently playing). */
  removeTrack(id: string): boolean {
    const idx = this.queue.findIndex((t) => t.id === id);
    if (idx < 0) return false;
    this.queue.splice(idx, 1);
    this.emit();
    return true;
  }

  /** Reorder a waiting track. */
  moveTrack(id: string, dir: 'up' | 'down'): boolean {
    const idx = this.queue.findIndex((t) => t.id === id);
    if (idx < 0) return false;
    const to = dir === 'up' ? idx - 1 : idx + 1;
    if (to < 0 || to >= this.queue.length) return false;
    const [t] = this.queue.splice(idx, 1);
    if (!t) return false;
    this.queue.splice(to, 0, t);
    this.emit();
    return true;
  }

  /** Jump a waiting track to the front and start it (skips whatever is current). */
  playTrackNow(id: string): Track | null {
    const idx = this.queue.findIndex((t) => t.id === id);
    if (idx < 0) return null;
    const [t] = this.queue.splice(idx, 1);
    if (!t) return null;
    this.queue.unshift(t);
    if (t.status !== 'ready' && t.status !== 'playing' && t.status !== 'paused') {
      // still resolving/failed — just move it forward
      this.emit();
      return t;
    }
    this.advance('manual');
    return t;
  }

  removePhoto(id: string): boolean {
    const before = this.photos.length;
    this.photos = this.photos.filter((p) => p.id !== id);
    if (this.photos.length !== before) this.emit();
    return this.photos.length !== before;
  }

  listPhotos(): PartyPhoto[] {
    return this.photos;
  }

  state(): PartyState {
    return {
      current: this.current,
      // guest queue only — ambient lo-fi is never listed here
      upcoming: this.queue.filter((t) => !t.isFallback),
      recent: this.recent.filter((t) => !t.isFallback),
      votes: this.votesState(),
      playerConnected: this.playerConnected,
      listeners: this.guests.size,
      volume: this.volume,
      paused: this.paused,
      position: this.current?.isFallback ? this.ambientPosition : this.position,
      fallbackEnabled: this.fallbackEnabled,
      ambientPosition: this.ambientPosition,
      queueLimit: this.queueLimit,
      maxDurationSec: this.maxDurationSec,
      photos: this.photos,
    };
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    const state = this.state();
    for (const fn of this.listeners) {
      try {
        fn(state);
      } catch {
        /* ignore listener errors */
      }
    }
  }
}

export const store = new PartyStore();
