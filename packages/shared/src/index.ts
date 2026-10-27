export type TrackStatus =
  | 'resolving'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'done'
  | 'failed';

export type TrackSource = 'youtube' | 'file' | 'search' | 'direct';

export interface Track {
  id: string;
  title: string;
  artist?: string;
  /** HTTP path the player streams from, e.g. /audio/abc.mp3 */
  audioUrl: string | null;
  /** Original submission (URL or "search: name") */
  origin: string;
  source: TrackSource;
  status: TrackStatus;
  durationSec: number | null;
  requestedBy: string;
  requestedByGuestId: string | null;
  coverUrl?: string | null;
  error?: string | null;
  createdAt: number;
  startedAt?: number | null;
  /** true for ambient lo-fi filler while the guest queue is empty */
  isFallback?: boolean;
}

export interface SkipVoteState {
  /** guestId → true */
  votes: Record<string, true>;
  count: number;
  threshold: number;
  activeGuests: number;
  needed: number;
}

export interface PartyPhoto {
  id: string;
  url: string;
  /** object key in S3 (or local/… for local disk) */
  key?: string | null;
  kind: 'image' | 'video';
  width: number | null;
  height: number | null;
  uploadedBy: string;
  uploadedByGuestId: string | null;
  createdAt: number;
}

export interface SearchHit {
  id: string;
  title: string;
  artist?: string;
  durationSec: number | null;
  thumbnailUrl?: string | null;
  url: string;
}

export interface PartyState {
  current: Track | null;
  upcoming: Track[];
  recent: Track[];
  votes: SkipVoteState;
  playerConnected: boolean;
  listeners: number;
  volume: number;
  paused: boolean;
  /** playback position in seconds (from last player progress) */
  position: number;
  /** ambient lo-fi while the guest queue is empty */
  fallbackEnabled: boolean;
  /** last known lo-fi playback position (seconds) — survives guest tracks */
  ambientPosition: number;
  /** max tracks waiting in the guest queue (current playing track is not counted) */
  queueLimit: number;
  /** latest party moment photos (newest first) */
  photos: PartyPhoto[];
  /** max track duration in seconds; 0 = no limit */
  maxDurationSec: number;
}

export type ServerMessage =
  | { type: 'hello'; state: PartyState; role: ClientRole }
  | { type: 'state'; state: PartyState }
  | { type: 'player:play'; track: Track; position: number }
  | { type: 'player:pause' }
  | { type: 'player:resume' }
  | { type: 'player:seek'; position: number }
  | { type: 'player:stop' }
  | { type: 'player:volume'; volume: number }
  | { type: 'vote:update'; votes: SkipVoteState }
  | { type: 'photo:new'; photo: PartyPhoto }
  | { type: 'audio:level'; level: number }
  | { type: 'toast'; level: 'info' | 'error' | 'success'; text: string };

export type ClientRole = 'guest' | 'player';

export type ClientMessage =
  | { type: 'hello'; role: ClientRole; guestId?: string; nickname?: string }
  | { type: 'player:ready' }
  | { type: 'player:started'; position: number }
  | { type: 'player:progress'; position: number; duration: number | null }
  | { type: 'player:ended'; reason: 'natural' | 'error' | 'skipped' }
  | { type: 'player:paused' }
  | { type: 'player:resumed' }
  | { type: 'player:level'; level: number }
  | { type: 'guest:ping' };

export interface JoinRequest {
  nickname: string;
  /** optional sticky id from localStorage */
  guestId?: string;
}

export interface JoinResponse {
  guestId: string;
  nickname: string;
}

export interface SubmitTrackRequest {
  title?: string;
  url?: string;
}

export interface SubmitTrackResponse {
  track: Track;
  /** 1-based position of the new track in the waiting queue */
  queueIndex?: number;
  /** total tracks waiting after the add (including the new one) */
  queueTotal?: number;
}

export const SKIP_VOTE_MIN_GUESTS = 2;

/** party tracks are capped at 5 minutes */
export const MAX_TRACK_DURATION_SEC = 300;

/** votes needed = floor(active/2)+1, but at least 1 */
export function skipThreshold(activeGuests: number): number {
  if (activeGuests <= 1) return 1;
  return Math.floor(activeGuests / 2) + 1;
}

export function isActiveGuestCount(n: number): boolean {
  return n >= SKIP_VOTE_MIN_GUESTS;
}
