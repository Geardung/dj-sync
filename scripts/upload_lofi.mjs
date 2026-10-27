/**
 * Upload the ambient lo-fi mix to S3 so it can be served from a permanent LOFI_URL.
 * Reads S3_* from project .env. Never prints secrets.
 */
import { readFileSync, existsSync, createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function loadEnv() {
  const out = {};
  for (const p of [path.join(root, '.env'), path.join(root, 'packages', 'backend', '.env')]) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return { ...out, ...process.env };
}

const env = loadEnv();
const file = path.join(root, 'data', 'audio', 'lo-fi-halloween.mp3');
const key = 'ambient/lo-fi-halloween.mp3';

if (!existsSync(file)) {
  console.error('missing file:', file);
  process.exit(1);
}
if (!env.S3_ENDPOINT || !env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
  console.error('S3_ENDPOINT / S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY required');
  process.exit(1);
}

const client = new S3Client({
  region: env.S3_REGION || 'ru-1',
  endpoint: env.S3_ENDPOINT,
  forcePathStyle: env.S3_FORCE_PATH_STYLE === '1' || env.S3_FORCE_PATH_STYLE === 'true',
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },
});

await client.send(
  new PutObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: key,
    Body: createReadStream(file),
    ContentType: 'audio/mpeg',
    CacheControl: 'public, max-age=31536000, immutable',
  })
);

const base = (env.S3_PUBLIC_BASE || `${env.S3_ENDPOINT}/${env.S3_BUCKET}`).replace(/\/+$/, '');
console.log('uploaded', key);
console.log('LOFI_URL=' + `${base}/${key}`);
