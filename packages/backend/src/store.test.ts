import { beforeEach, describe, expect, it } from 'vitest';
import { PartyStore } from './store.js';
import type { Track } from '@dj-sync/shared';

function readyTrack(store: PartyStore, title: string, requestedByGuestId: string | null = null): Track {
  return store.addTrack({
    title,
    origin: `search: ${title}`,
    source: 'search',
    requestedBy: 'tester',
    requestedByGuestId,
    audioUrl: '/audio/x.mp3',
    durationSec: 180,
    coverUrl: null,
    error: null,
    artist: undefined,
    status: 'ready',
  });
}

describe('PartyStore', () => {
  let store: PartyStore;
  beforeEach(() => {
    store = new PartyStore();
  });

  describe('join', () => {
    it('creates a guest and trims the nickname', () => {
      const g = store.join('  Кекс  ');
      expect(g.nickname).toBe('Кекс');
      expect(store.guestCount()).toBe(1);
    });

    it('rejoins the same guestId instead of duplicating', () => {
      store.join('A', 'guest-1');
      store.join('B', 'guest-1');
      expect(store.guestCount()).toBe(1);
      expect(store.getGuest('guest-1')?.nickname).toBe('B');
    });

    it('rejects a malformed guestId by generating a new one', () => {
      const g = store.join('A', 'bad id!!');
      expect(g.guestId).not.toBe('bad id!!');
    });
  });

  describe('pruneStaleGuests', () => {
    it('removes only guests older than the TTL', () => {
      store.join('old', 'guest-old');
      store.join('fresh', 'guest-fresh');
      // backdate one guest beyond the TTL
      const g = store.getGuest('guest-old')!;
      g.lastSeenAt = Date.now() - 60_000;
      const removed = store.pruneStaleGuests(30_000);
      expect(removed).toBe(1);
      expect(store.getGuest('guest-old')).toBeUndefined();
      expect(store.getGuest('guest-fresh')).toBeDefined();
    });

    it('keeps touched guests alive', () => {
      store.join('a', 'guest-a');
      store.getGuest('guest-a')!.lastSeenAt = Date.now() - 25_000;
      store.touch('guest-a');
      expect(store.pruneStaleGuests(30_000)).toBe(0);
    });
  });

  describe('queue', () => {
    it('enforces the queue limit', () => {
      store.setQueueLimit(1);
      readyTrack(store, 'one');
      expect(store.canAcceptTrack()).toBe(false);
      store.setQueueLimit(2);
      expect(store.canAcceptTrack()).toBe(true);
    });

    it('moves the first ready track to current on advance', () => {
      readyTrack(store, 'one');
      readyTrack(store, 'two');
      store.advance('auto');
      expect(store.state().current?.title).toBe('one');
      expect(store.state().upcoming).toHaveLength(1);
    });

    it('skips failed tracks when advancing', () => {
      const bad = readyTrack(store, 'bad');
      store.markTrackFailed(bad.id, 'boom');
      readyTrack(store, 'good');
      store.advance('auto');
      expect(store.state().current?.title).toBe('good');
    });

    it('moves tracks up and down', () => {
      const a = readyTrack(store, 'a');
      readyTrack(store, 'b');
      expect(store.moveTrack(a.id, 'down')).toBe(true);
      expect(store.state().upcoming[0]?.title).toBe('b');
      expect(store.moveTrack(a.id, 'up')).toBe(true);
      expect(store.state().upcoming[0]?.title).toBe('a');
    });

    it('removes a waiting track', () => {
      const a = readyTrack(store, 'a');
      expect(store.removeTrack(a.id)).toBe(true);
      expect(store.state().upcoming).toHaveLength(0);
    });

    it('pushes finished tracks into recent', () => {
      readyTrack(store, 'one');
      store.advance('auto');
      store.advance('manual');
      expect(store.state().recent[0]?.title).toBe('one');
      expect(store.state().current).toBeNull();
    });
  });

  describe('skip votes', () => {
    it('reaches threshold with floor(active/2)+1 votes', () => {
      for (const id of ['g1', 'g2', 'g3', 'g4']) store.join('n', id);
      readyTrack(store, 'track');
      store.advance('auto');
      store.voteSkip('g1');
      expect(store.state().current?.title).toBe('track');
      store.voteSkip('g2');
      expect(store.state().current?.title).toBe('track');
      store.voteSkip('g3');
      // 3 of 4 → threshold 3 → skipped
      expect(store.state().current).toBeNull();
    });

    it('lets the author veto-skip their own track', () => {
      store.join('author', 'g-author');
      store.join('other', 'g-other');
      const t = readyTrack(store, 'mine', 'g-author');
      expect(t.requestedByGuestId).toBe('g-author');
      store.advance('auto');
      store.voteSkip('g-author');
      expect(store.state().current).toBeNull();
    });

    it('unvote lowers the count', () => {
      // 3 guests → threshold 2, so a single vote does not skip the track
      store.join('a', 'g1');
      store.join('b', 'g2');
      store.join('c', 'g3');
      readyTrack(store, 't');
      store.advance('auto');
      store.voteSkip('g1');
      expect(store.votesState().count).toBe(1);
      store.unvoteSkip('g1');
      expect(store.votesState().count).toBe(0);
    });

    it('clears votes when the track changes', () => {
      store.join('a', 'g1');
      readyTrack(store, 't');
      store.advance('auto');
      store.voteSkip('g1');
      store.advance('manual');
      expect(store.votesState().count).toBe(0);
    });
  });

  describe('likes', () => {
    it('toggles a like on the current track', () => {
      const t = readyTrack(store, 't');
      store.advance('auto');
      expect(store.toggleLike(t.id, 'g1', true)).toEqual(['g1']);
      expect(store.toggleLike(t.id, 'g1', false)).toEqual([]);
    });

    it('rejects likes on ambient fallback', () => {
      const ambient: Track = {
        id: 'ambient-lofi',
        title: 'lofi',
        audioUrl: '/audio/lofi.mp3',
        origin: 'lofi',
        source: 'file',
        status: 'playing',
        durationSec: null,
        requestedBy: 'Lo-Fi',
        requestedByGuestId: null,
        createdAt: Date.now(),
        isFallback: true,
      };
      store.startFallbackTrack(ambient);
      expect(store.toggleLike('ambient-lofi', 'g1', true)).toBeNull();
    });

    it('returns null for unknown tracks', () => {
      expect(store.toggleLike('nope', 'g1', true)).toBeNull();
    });
  });

  describe('snapshot / restore', () => {
    it('round-trips queue, guests and settings', () => {
      store.join('alice', 'g-alice');
      readyTrack(store, 'one', 'g-alice');
      readyTrack(store, 'two');
      store.setQueueLimit(5);
      store.setMaxDuration(240);
      store.setVolume(0.5);
      store.advance('auto');
      store.toggleLike(store.state().current!.id, 'g-alice', true);

      const snap = store.snapshot();

      const fresh = new PartyStore();
      fresh.restore(snap);
      const st = fresh.state();
      expect(st.current?.title).toBe('one');
      expect(st.current?.likedBy).toEqual(['g-alice']);
      expect(st.upcoming.map((t) => t.title)).toEqual(['two']);
      expect(st.listeners).toBe(1);
      expect(st.queueLimit).toBe(5);
      expect(st.maxDurationSec).toBe(240);
      expect(st.volume).toBe(0.5);
    });

    it('drops transient skip votes on restore', () => {
      store.join('a', 'g1');
      readyTrack(store, 't');
      store.advance('auto');
      store.voteSkip('g1');
      const fresh = new PartyStore();
      fresh.restore(store.snapshot());
      expect(fresh.votesState().count).toBe(0);
    });
  });

  describe('fallback (ambient)', () => {
    it('never shows ambient in the guest queue', () => {
      store.startFallbackTrack({
        id: 'ambient-lofi',
        title: 'lofi',
        audioUrl: '/audio/lofi.mp3',
        origin: 'lofi',
        source: 'file',
        status: 'playing',
        durationSec: null,
        requestedBy: 'Lo-Fi',
        requestedByGuestId: null,
        createdAt: Date.now(),
        isFallback: true,
      });
      const st = store.state();
      expect(st.current?.isFallback).toBe(true);
      expect(st.upcoming).toHaveLength(0);
      expect(st.recent).toHaveLength(0);
    });

    it('a ready guest track interrupts ambient', () => {
      store.startFallbackTrack({
        id: 'ambient-lofi',
        title: 'lofi',
        audioUrl: '/audio/lofi.mp3',
        origin: 'lofi',
        source: 'file',
        status: 'playing',
        durationSec: null,
        requestedBy: 'Lo-Fi',
        requestedByGuestId: null,
        createdAt: Date.now(),
        isFallback: true,
      });
      readyTrack(store, 'guest hit');
      store.kickUserTracks();
      expect(store.state().current?.title).toBe('guest hit');
    });
  });
});
