import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';
/** Target integrated loudness — same ballpark as streaming services. */
const TARGET_I = '-14';
const TARGET_TP = '-1.5';
const TARGET_LRA = '11';

function run(cmd: string, args: string[], timeoutMs = 120_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} timed out`));
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * EBU R128 loudness normalize an audio file in-place (mp3 output).
 * Single-pass loudnorm is good enough for a party queue.
 */
export async function normalizeAudio(filePath: string): Promise<void> {
  const ext = path.extname(filePath) || '.mp3';
  const tmp = path.join(
    path.dirname(filePath),
    `${path.basename(filePath, ext)}.norm${ext}`
  );
  const args = [
    '-y',
    '-i',
    filePath,
    '-af',
    `loudnorm=I=${TARGET_I}:TP=${TARGET_TP}:LRA=${TARGET_LRA}`,
    '-codec:a',
    'libmp3lame',
    '-q:a',
    '4',
    tmp,
  ];
  const { code, stderr } = await run(FFMPEG, args);
  if (code !== 0) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw new Error(`ffmpeg loudnorm failed: ${stderr.slice(-300)}`);
  }
  await fs.rm(filePath, { force: true }).catch(() => {});
  await fs.rename(tmp, filePath);
}
