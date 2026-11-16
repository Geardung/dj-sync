import { describe, expect, it } from 'vitest';
import { skipThreshold, isActiveGuestCount, MAX_TRACK_DURATION_SEC } from '@dj-sync/shared';
import { SlidingWindow } from './rateLimit.js';

describe('skipThreshold', () => {
  it('needs 1 vote alone', () => {
    expect(skipThreshold(1)).toBe(1);
    expect(skipThreshold(0)).toBe(1);
  });

  it('is floor(active/2)+1', () => {
    expect(skipThreshold(2)).toBe(2);
    expect(skipThreshold(3)).toBe(2);
    expect(skipThreshold(4)).toBe(3);
    expect(skipThreshold(10)).toBe(6);
  });

  it('always leaves the minority unable to skip', () => {
    for (let n = 1; n <= 50; n++) {
      expect(skipThreshold(n)).toBeGreaterThan(n / 2 - 1);
    }
  });
});

describe('isActiveGuestCount', () => {
  it('needs at least 2 guests', () => {
    expect(isActiveGuestCount(1)).toBe(false);
    expect(isActiveGuestCount(2)).toBe(true);
  });
});

describe('constants', () => {
  it('caps party tracks at 5 minutes', () => {
    expect(MAX_TRACK_DURATION_SEC).toBe(300);
  });
});

describe('SlidingWindow', () => {
  it('allows up to the limit, then rejects', () => {
    const lim = new SlidingWindow(3, 60_000);
    expect(lim.attempt('a')).toBe(true);
    expect(lim.attempt('a')).toBe(true);
    expect(lim.attempt('a')).toBe(true);
    expect(lim.attempt('a')).toBe(false);
  });

  it('tracks keys independently', () => {
    const lim = new SlidingWindow(1, 60_000);
    expect(lim.attempt('a')).toBe(true);
    expect(lim.attempt('a')).toBe(false);
    expect(lim.attempt('b')).toBe(true);
  });

  it('reports retry-after when over budget', () => {
    const lim = new SlidingWindow(1, 60_000);
    lim.attempt('a');
    expect(lim.retryAfterSec('a')).toBeGreaterThan(0);
    expect(lim.retryAfterSec('b')).toBe(0);
  });
});
