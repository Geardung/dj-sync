import fs from 'node:fs';
import path from 'node:path';
import type { Track, PartyPhoto } from '@dj-sync/shared';

/** Serializable slice of the party — survives backend restarts. */
export interface StoreSnapshot {
  version: 1;
  savedAt: number;
  queue: Track[];
  current: Track | null;
  recent: Track[];
  guests: Array<{ id: string; nickname: string; joinedAt: number; lastSeenAt: number }>;
  volume: number;
  paused: boolean;
  position: number;
  fallbackEnabled: boolean;
  ambientPosition: number;
  queueLimit: number;
  maxDurationSec: number;
  photos: PartyPhoto[];
}

const STATE_FILE = process.env.STATE_FILE || path.resolve('data/state.json');
const SAVE_DEBOUNCE_MS = 1000;

let saveTimer: NodeJS.Timeout | null = null;
let lastJson = '';

export function stateFilePath(): string {
  return STATE_FILE;
}

export function loadSnapshot(): StoreSnapshot | null {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as StoreSnapshot;
    if (parsed?.version !== 1 || !Array.isArray(parsed.queue)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Debounced write — coalesces bursts of state emits (advance, votes, joins). */
export function scheduleSave(snapshot: StoreSnapshot): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void writeSnapshot(snapshot);
  }, SAVE_DEBOUNCE_MS);
}

export function flushSave(snapshot: StoreSnapshot): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  void writeSnapshot(snapshot);
}

function writeSnapshot(snapshot: StoreSnapshot): void {
  try {
    const json = JSON.stringify(snapshot);
    if (json === lastJson) return;
    lastJson = json;
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    console.error('[persist] save failed', err instanceof Error ? err.message : err);
  }
}

export function clearSnapshot(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    fs.rmSync(STATE_FILE, { force: true });
  } catch {
    /* ignore */
  }
}
