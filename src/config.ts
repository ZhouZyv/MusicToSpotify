import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const ROOT = process.cwd();
export const CACHE_DIR = join(ROOT, '.cache');
export const OUT_DIR = join(ROOT, 'out');

function loadDotEnv(): void {
  const path = join(ROOT, '.env');
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

export const config = {
  clientId: process.env.SPOTIFY_CLIENT_ID ?? '',
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET ?? '',
  redirectUri: process.env.SPOTIFY_REDIRECT_URI ?? 'http://127.0.0.1:8888/callback',
  neteaseCookie: process.env.NETEASE_COOKIE ?? '',
};

export function requireClientId(): string {
  if (!config.clientId) {
    throw new Error(
      '缺少 SPOTIFY_CLIENT_ID。请先复制 .env.example 为 .env，并填入 Spotify Developer App 的 Client ID（详见 README）。',
    );
  }
  return config.clientId;
}
