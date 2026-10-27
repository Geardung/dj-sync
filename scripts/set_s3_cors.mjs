/**
 * PutBucketCors for dj-assets — allows browser PUT/GET from party UIs.
 * Reads S3_* from packages/backend env / project .env. Never prints secrets.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  S3Client,
  PutBucketCorsCommand,
  GetBucketCorsCommand,
} from '@aws-sdk/client-s3';

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
const endpoint = env.S3_ENDPOINT;
const region = env.S3_REGION || 'ru-1';
const bucket = env.S3_BUCKET;
const accessKeyId = env.S3_ACCESS_KEY_ID;
const secretAccessKey = env.S3_SECRET_ACCESS_KEY;

if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
  console.error('S3_ENDPOINT / S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY required');
  process.exit(1);
}

const client = new S3Client({
  endpoint,
  region,
  credentials: { accessKeyId, secretAccessKey },
  forcePathStyle: env.S3_FORCE_PATH_STYLE === '1' || env.S3_FORCE_PATH_STYLE === 'true',
});

const origins = [
  'https://dj.tedeshi.ru',
  'http://dj.tedeshi.ru',
  'http://localhost:8088',
  'http://127.0.0.1:8088',
  'http://localhost:80',
  'http://127.0.0.1:80',
  'https://localhost',
  'https://127.0.0.1',
];

const rules = [
  {
    AllowedOrigins: origins,
    AllowedMethods: ['GET', 'HEAD', 'PUT', 'POST', 'DELETE'],
    AllowedHeaders: ['*'],
    ExposeHeaders: ['ETag', 'Content-Length', 'Content-Type', 'x-amz-request-id'],
    MaxAgeSeconds: 3600,
  },
];

const input = {
  Bucket: bucket,
  CORSConfiguration: { CORSRules: rules },
};

try {
  const before = await client.send(new GetBucketCorsCommand({ Bucket: bucket }));
  console.log('existing rules:', before.CORSRules?.length ?? 0);
} catch {
  console.log('no existing CORS config');
}

await client.send(new PutBucketCorsCommand(input));
console.log('CORS updated for', origins.length, 'origins on bucket', bucket);
