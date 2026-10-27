import fs from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type { PartyPhoto } from '@dj-sync/shared';
import {
  s3Enabled,
  makeKey,
  uploadBuffer,
  presignPut,
  deleteObject,
  publicUrl,
} from './s3.js';

const PHOTOS_DIR = process.env.PHOTOS_DIR || path.resolve('data/photos');

export function photosDir(): string {
  return PHOTOS_DIR;
}

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.m4v']);
const MAX_BYTES = 25 * 1024 * 1024;

export async function ensurePhotosDir(): Promise<void> {
  await fs.mkdir(PHOTOS_DIR, { recursive: true });
}

export function kindFromContentType(ct: string, fileName = ''): 'image' | 'video' {
  const c = (ct || '').toLowerCase();
  const n = (fileName || '').toLowerCase();
  if (c.startsWith('video/') || n.endsWith('.mp4') || n.endsWith('.webm') || n.endsWith('.mov')) {
    return 'video';
  }
  return 'image';
}

function sniff(buf: Buffer): { ext: string; kind: 'image' | 'video' } | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: '.jpg', kind: 'image' };
  }
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e) {
    return { ext: '.png', kind: 'image' };
  }
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return { ext: '.webp', kind: 'image' };
  }
  if (buf.length >= 6 && buf.toString('ascii', 0, 3) === 'GIF') {
    return { ext: '.gif', kind: 'image' };
  }
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') {
    return { ext: '.mp4', kind: 'video' };
  }
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return { ext: '.webm', kind: 'video' };
  }
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'moov') {
    return { ext: '.mov', kind: 'video' };
  }
  return null;
}

function extFromName(fileName: string): { ext: string; kind: 'image' | 'video' } | null {
  const ext = path.extname(fileName).toLowerCase();
  if (IMAGE_EXT.has(ext)) return { ext, kind: 'image' };
  if (VIDEO_EXT.has(ext)) return { ext, kind: 'video' };
  return null;
}

export async function savePhoto(
  fileName: string,
  buf: Buffer,
  meta: { uploadedBy: string; uploadedByGuestId?: string | null }
): Promise<PartyPhoto> {
  const sniffed = sniff(buf);
  const fromName = extFromName(fileName);
  const picked = sniffed || fromName;
  if (!picked) throw new Error('unsupported image or video type');
  if (buf.length > MAX_BYTES) throw new Error('file too large');

  const id = nanoid(12);

  if (s3Enabled()) {
    const key = makeKey('moments', picked.ext);
    const url = await uploadBuffer(
      key,
      buf,
      picked.kind === 'video' ? `video/${picked.ext.slice(1)}` : `image/${picked.ext.slice(1)}`
    );
    return {
      id,
      url,
      key,
      kind: picked.kind,
      width: null,
      height: null,
      uploadedBy: meta.uploadedBy.slice(0, 32) || 'Guest',
      uploadedByGuestId: meta.uploadedByGuestId ?? null,
      createdAt: Date.now(),
    };
  }

  await ensurePhotosDir();
  const file = `${id}${picked.ext}`;
  await fs.writeFile(path.join(PHOTOS_DIR, file), buf);
  return {
    id,
    url: `/photos/${file}`,
    key: `local/${file}`,
    kind: picked.kind,
    width: null,
    height: null,
    uploadedBy: meta.uploadedBy.slice(0, 32) || 'Guest',
    uploadedByGuestId: meta.uploadedByGuestId ?? null,
    createdAt: Date.now(),
  };
}

/** Presigned direct-to-bucket upload (S3 only). */
export async function createPresignedUpload(opts: {
  fileName: string;
  contentType: string;
}): Promise<{ id: string; key: string; url: string; uploadUrl: string; kind: 'image' | 'video' }> {
  if (!s3Enabled()) throw new Error('S3 is not configured');
  const kind = kindFromContentType(opts.contentType, opts.fileName);
  const fromName = extFromName(opts.fileName);
  const ext = fromName?.ext || (kind === 'video' ? '.mp4' : '.jpg');
  const key = makeKey('moments', ext);
  const id = nanoid(12);
  const uploadUrl = await presignPut(key, opts.contentType || 'application/octet-stream');
  return {
    id,
    key,
    url: publicUrl(key),
    uploadUrl,
    kind,
  };
}

export function photoFromUpload(opts: {
  id: string;
  key: string;
  url: string;
  kind: 'image' | 'video';
  uploadedBy: string;
  uploadedByGuestId?: string | null;
}): PartyPhoto {
  return {
    id: opts.id,
    url: opts.url || publicUrl(opts.key),
    key: opts.key,
    kind: opts.kind,
    width: null,
    height: null,
    uploadedBy: opts.uploadedBy.slice(0, 32) || 'Guest',
    uploadedByGuestId: opts.uploadedByGuestId ?? null,
    createdAt: Date.now(),
  };
}

export async function deletePhotoByMeta(photo: { id: string; key?: string | null }): Promise<void> {
  if (photo.key && !photo.key.startsWith('local/')) {
    await deleteObject(photo.key).catch(() => {});
    return;
  }
  const files = await fs.readdir(PHOTOS_DIR).catch(() => [] as string[]);
  const match = files.find((f) => f.startsWith(`${photo.id}.`));
  if (match) await fs.unlink(path.join(PHOTOS_DIR, match)).catch(() => {});
}

/** Rebuild photo list from local disk (S3-only mode skips this). */
export async function loadPhotosFromDisk(): Promise<PartyPhoto[]> {
  if (s3Enabled()) return [];
  await ensurePhotosDir();
  const files = await fs.readdir(PHOTOS_DIR).catch(() => [] as string[]);
  const out: PartyPhoto[] = [];
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    const kind: 'image' | 'video' = VIDEO_EXT.has(ext) ? 'video' : 'image';
    if (!IMAGE_EXT.has(ext) && !VIDEO_EXT.has(ext)) continue;
    const id = path.basename(f, ext);
    const st = await fs.stat(path.join(PHOTOS_DIR, f)).catch(() => null);
    out.push({
      id,
      url: `/photos/${f}`,
      key: `local/${f}`,
      kind,
      width: null,
      height: null,
      uploadedBy: '—',
      uploadedByGuestId: null,
      createdAt: st?.mtimeMs ?? Date.now(),
    });
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out.slice(0, 40);
}
