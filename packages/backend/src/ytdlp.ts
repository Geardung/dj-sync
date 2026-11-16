import { spawn } from 'node:child_process';

export const YTDLP = process.env.YTDLP_BIN || 'yt-dlp';

/**
 * YTDLP_PROXY включает туннель (напр. http://vpn-gateway:12334).
 * Без него yt-dlp ходит напрямую и намеренно НЕ наследует HTTP_PROXY контейнера:
 * googlevideo подписывает URL под IP запросившего, смешивать пути нельзя.
 */
export function ytdlpEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.HTTP_PROXY;
  delete env.HTTPS_PROXY;
  delete env.http_proxy;
  delete env.https_proxy;
  const proxy = process.env.YTDLP_PROXY?.trim();
  if (proxy) {
    env.HTTP_PROXY = proxy;
    env.HTTPS_PROXY = proxy;
    env.http_proxy = proxy;
    env.https_proxy = proxy;
  }
  return env;
}

export function runProcess(
  cmd: string,
  args: string[],
  timeoutMs = 90_000,
  env?: NodeJS.ProcessEnv
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, ...(env ? { env } : {}) });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
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
