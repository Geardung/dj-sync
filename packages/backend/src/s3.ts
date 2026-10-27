import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { nanoid } from 'nanoid';

const ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID || '';
const SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY || '';
const ENDPOINT = (process.env.S3_ENDPOINT || '').replace(/\/+$/, '');
const REGION = process.env.S3_REGION || 'ru-1';
const BUCKET = process.env.S3_BUCKET || 'dj-assets';
const PUBLIC_BASE = (process.env.S3_PUBLIC_BASE || '').replace(/\/+$/, '');
const FORCE_PATH_STYLE = process.env.S3_FORCE_PATH_STYLE !== '0';

export function s3Enabled(): boolean {
  return Boolean(ACCESS_KEY_ID && SECRET_ACCESS_KEY && ENDPOINT && BUCKET);
}

function client(): S3Client {
  return new S3Client({
    region: REGION,
    endpoint: ENDPOINT,
    forcePathStyle: FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
    },
  });
}

/** Public URL for an object key (CDN / public bucket domain). */
export function publicUrl(key: string): string {
  if (!key) return '';
  if (key.startsWith('http')) return key;
  const base = PUBLIC_BASE || `${ENDPOINT}/${BUCKET}`;
  return `${base}/${key.replace(/^\/+/, '')}`;
}

export function makeKey(prefix: string, ext: string): string {
  const safeExt = (ext || '.bin').replace(/[^a-z0-9.]/g, '').slice(0, 8) || '.bin';
  return `${prefix}/${nanoid(16)}${safeExt.startsWith('.') ? safeExt : `.${safeExt}`}`;
}

export async function uploadBuffer(
  key: string,
  body: Buffer,
  contentType: string
): Promise<string> {
  if (!s3Enabled()) throw new Error('S3 is not configured');
  await client().send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
    })
  );
  return publicUrl(key);
}

export async function presignPut(
  key: string,
  contentType: string,
  expiresSec = 600
): Promise<string> {
  if (!s3Enabled()) throw new Error('S3 is not configured');
  const cmd = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(client(), cmd, { expiresIn: expiresSec });
}

export async function deleteObject(key: string): Promise<void> {
  if (!s3Enabled()) return;
  await client().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

export async function exists(key: string): Promise<boolean> {
  if (!s3Enabled()) return false;
  try {
    await client().send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/** Download a remote image and mirror it into S3. Returns our public URL or original. */
export async function mirrorRemoteImage(
  remoteUrl: string,
  prefix: string
): Promise<string | null> {
  if (!remoteUrl || !s3Enabled()) return remoteUrl || null;
  try {
    const res = await fetch(remoteUrl, {
      signal: AbortSignal.timeout(15_000),
      headers: { 'User-Agent': 'dj-sync/1.0' },
    });
    if (!res.ok) return remoteUrl;
    const type = res.headers.get('content-type') || 'image/jpeg';
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > 8 * 1024 * 1024) return remoteUrl;
    const ext = type.includes('png')
      ? '.png'
      : type.includes('webp')
        ? '.webp'
        : type.includes('gif')
          ? '.gif'
          : '.jpg';
    const key = makeKey(prefix, ext);
    await uploadBuffer(key, buf, type);
    return publicUrl(key);
  } catch {
    return remoteUrl;
  }
}
