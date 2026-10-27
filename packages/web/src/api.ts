const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) || '';

export function apiBase(): string {
  return API_BASE;
}

export function wsUrl(): string {
  if (API_BASE) {
    return API_BASE.replace(/^http/, 'ws') + '/ws';
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

export function audioUrl(path: string | null): string | null {
  if (!path) return null;
  if (path.startsWith('http')) return path;
  return `${API_BASE}${path}`;
}

export async function join(nickname: string, guestId?: string) {
  const res = await fetch(`${API_BASE}/api/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname, guestId }),
  });
  if (!res.ok) throw new Error('join failed');
  return res.json() as Promise<{ guestId: string; nickname: string }>;
}

export async function submitTrack(payload: {
  title?: string;
  url?: string;
  guestId?: string;
  requestedBy?: string;
}) {
  const res = await fetch(`${API_BASE}/api/tracks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'submit failed' }));
    throw new Error(err.error || 'submit failed');
  }
  return res.json() as Promise<{
    track: unknown;
    queueIndex?: number;
    queueTotal?: number;
  }>;
}

export async function submitFile(payload: {
  file: File;
  title?: string;
  guestId?: string;
  requestedBy?: string;
}) {
  const form = new FormData();
  form.append('file', payload.file);
  if (payload.title) form.append('title', payload.title);
  const q = new URLSearchParams();
  if (payload.guestId) q.set('guestId', payload.guestId);
  if (payload.requestedBy) q.set('requestedBy', payload.requestedBy);
  const res = await fetch(`${API_BASE}/api/tracks?${q.toString()}`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'upload failed' }));
    throw new Error(err.error || 'upload failed');
  }
  return res.json() as Promise<{
    track: unknown;
    queueIndex?: number;
    queueTotal?: number;
  }>;
}

export async function voteSkip(guestId: string, action: 'vote' | 'unvote' = 'vote') {
  const res = await fetch(`${API_BASE}/api/skip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ guestId, action }),
  });
  if (!res.ok) throw new Error('vote failed');
  return res.json();
}

export async function playerCommand(action: string, extra?: Record<string, unknown>) {
  const res = await fetch(`${API_BASE}/api/player/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...extra }),
  });
  return res.json();
}

export async function removeTrack(id: string) {
  const res = await fetch(`${API_BASE}/api/tracks/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('remove failed');
  return res.json();
}

export async function moveTrack(id: string, dir: 'up' | 'down') {
  const res = await fetch(`${API_BASE}/api/tracks/${encodeURIComponent(id)}/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir }),
  });
  if (!res.ok) throw new Error('move failed');
  return res.json();
}

export async function playTrackNow(id: string) {
  const res = await fetch(`${API_BASE}/api/tracks/${encodeURIComponent(id)}/play`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error('play failed');
  return res.json();
}

export async function searchTracks(q: string) {
  const res = await fetch(`${API_BASE}/api/search?q=${encodeURIComponent(q)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'search failed' }));
    throw new Error(err.error || 'search failed');
  }
  return res.json() as Promise<{ results: import('@dj-sync/shared').SearchHit[] }>;
}

export async function uploadPhoto(payload: {
  file: File;
  guestId?: string;
  uploadedBy?: string;
}) {
  // S3-провайдер не реализует PutBucketCors (501), поэтому браузер не может
  // делать PUT напрямую в бакет. Всегда грузим через API — backend кладёт в S3.
  const form = new FormData();
  form.append('file', payload.file);
  if (payload.guestId) form.append('guestId', payload.guestId);
  if (payload.uploadedBy) form.append('uploadedBy', payload.uploadedBy);
  const res = await fetch(`${API_BASE}/api/photos`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'upload failed' }));
    throw new Error(err.error || 'upload failed');
  }
  return res.json() as Promise<{ photo: import('@dj-sync/shared').PartyPhoto }>;
}

export async function deletePhoto(id: string) {
  const res = await fetch(`${API_BASE}/api/photos/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  return res.ok;
}
