import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { CACHE_DIR, config, requireClientId } from './config.ts';

const API = 'https://api.spotify.com/v1';
const ACCOUNTS = 'https://accounts.spotify.com';
const SCOPES = [
  'playlist-modify-public',
  'playlist-modify-private',
  'playlist-read-private',
  'user-read-private',
  'ugc-image-upload',
];
const TOKEN_PATH = join(CACHE_DIR, 'token.json');

export type SpotifyTrack = {
  uri: string;
  id: string;
  name: string;
  artists: string[];
  album: string;
  durationMs: number;
  url: string;
  playable: boolean;
};

type TokenSet = {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  scope?: string;
};

let cached: TokenSet | null = null;
let refreshing: Promise<TokenSet> | null = null;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function saveToken(token: TokenSet): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2), { mode: 0o600 });
  try {
    chmodSync(TOKEN_PATH, 0o600);
  } catch {
    /* ignore */
  }
  cached = token;
}

function loadToken(): TokenSet | null {
  if (cached) return cached;
  if (!existsSync(TOKEN_PATH)) return null;
  try {
    cached = JSON.parse(readFileSync(TOKEN_PATH, 'utf8')) as TokenSet;
    return cached;
  } catch {
    return null;
  }
}

async function tokenRequest(body: Record<string, string>): Promise<TokenSet> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  const form = new URLSearchParams(body);
  if (config.clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(
      `${config.clientId}:${config.clientSecret}`,
    ).toString('base64')}`;
  } else {
    form.set('client_id', config.clientId);
  }

  const res = await fetch(`${ACCOUNTS}/api/token`, { method: 'POST', headers, body: form });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`换取 token 失败（HTTP ${res.status}）：${text.slice(0, 400)}`);
  }
  const data = JSON.parse(text) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
  };
  const token: TokenSet = {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? loadToken()?.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
    scope: data.scope,
  };
  saveToken(token);
  return token;
}

async function refreshToken(): Promise<TokenSet> {
  const current = loadToken();
  if (!current?.refresh_token) {
    throw new Error('还没有登录（或 token 已失效）。请先运行：node src/cli.ts login');
  }
  if (!refreshing) {
    refreshing = tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: current.refresh_token,
    }).finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

export async function getAccessToken(): Promise<string> {
  const token = loadToken();
  if (!token) {
    throw new Error('还没有登录。请先运行：node src/cli.ts login');
  }
  requireClientId();
  if (token.expires_at - Date.now() < 60_000) {
    const refreshed = await refreshToken();
    return refreshed.access_token;
  }
  return token.access_token;
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  execFile(cmd, [url], () => {
    /* 打不开就让用户手动复制链接 */
  });
}

/**
 * Authorization Code + PKCE。回调走本机 127.0.0.1，token 只落在本地 .cache/token.json。
 * 如果 App 配了 Client Secret，会一并带上（Spotify 允许 confidential client）。
 */
export async function login(): Promise<TokenSet> {
  requireClientId();
  const redirect = new URL(config.redirectUri);
  const port = Number(redirect.port || 80);

  const verifier = base64url(randomBytes(64));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(randomBytes(16));

  const authUrl = new URL(`${ACCOUNTS}/authorize`);
  authUrl.searchParams.set('client_id', config.clientId);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', config.redirectUri);
  authUrl.searchParams.set('scope', SCOPES.join(' '));
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('code_challenge', challenge);

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (url.pathname !== new URL(config.redirectUri).pathname) {
        res.writeHead(404).end('not found');
        return;
      }
      const error = url.searchParams.get('error');
      const returnedState = url.searchParams.get('state');
      const returnedCode = url.searchParams.get('code');

      const finish = (html: string) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
        server.close();
      };

      if (error) {
        finish(`<h1>授权失败</h1><p>${error}</p>`);
        reject(new Error(`Spotify 授权被拒绝：${error}`));
        return;
      }
      if (returnedState !== state) {
        finish('<h1>state 不匹配</h1>');
        reject(new Error('OAuth state 校验失败，请重试'));
        return;
      }
      if (!returnedCode) {
        finish('<h1>没有拿到 code</h1>');
        reject(new Error('回调里没有 code 参数'));
        return;
      }
      finish('<h1>登录成功 ✅</h1><p>可以关闭这个页面，回到终端继续。</p>');
      resolve(returnedCode);
    });

    server.on('error', (err) => reject(err));
    server.listen(port, '127.0.0.1', () => {
      console.log('正在打开浏览器授权…\n如果没自动打开，手动访问：\n\n' + authUrl.toString() + '\n');
      openBrowser(authUrl.toString());
    });

    setTimeout(() => {
      server.close();
      reject(new Error('等待授权超时（5 分钟）'));
    }, 5 * 60 * 1000).unref();
  });

  return tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
    code_verifier: verifier,
  });
}

async function api<T>(path: string, init: RequestInit = {}, retriedAuth = false): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(API + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });

  if (res.status === 401 && !retriedAuth) {
    await refreshToken();
    return api<T>(path, init, true);
  }
  if (res.status === 429) {
    const wait = Number(res.headers.get('retry-after') ?? 2);
    console.warn(`  触发限流，等 ${wait}s…`);
    await sleep(wait * 1000);
    return api<T>(path, init, retriedAuth);
  }
  if (res.status >= 500) {
    await sleep(800);
    return api<T>(path, init, retriedAuth);
  }
  if (!res.ok) {
    const body = await res.text();
    let hint = '';
    if (res.status === 403) {
      hint =
        '\n  可能是：① App 所有者没有 Spotify Premium（2026-02 新规，Development Mode 直接不可用）；' +
        '② 当前登录账号没被加入 App 的 Users Management 白名单；③ 缺少对应 scope。';
    } else if (res.status === 401) {
      hint = '\n  提示：token 失效，删掉 .cache/token.json 后重新 login。';
    }
    throw new Error(`Spotify ${init.method ?? 'GET'} ${path} → ${res.status}：${body.slice(0, 400)}${hint}`);
  }
  if (res.status === 204 || res.status === 202) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

type RawSpotifyTrack = {
  id: string;
  uri: string;
  name: string;
  duration_ms: number;
  is_playable?: boolean;
  artists: { name: string }[];
  album: { name: string };
  external_urls?: { spotify?: string };
};

function toSpotifyTrack(raw: RawSpotifyTrack): SpotifyTrack {
  return {
    uri: raw.uri,
    id: raw.id,
    name: raw.name,
    artists: raw.artists.map((a) => a.name),
    album: raw.album.name,
    durationMs: raw.duration_ms,
    url: raw.external_urls?.spotify ?? `https://open.spotify.com/track/${raw.id}`,
    playable: raw.is_playable !== false,
  };
}

export async function me(): Promise<{ id: string; display_name: string }> {
  return api<{ id: string; display_name: string }>('/me');
}

export async function searchTracks(query: string, limit = 10): Promise<SpotifyTrack[]> {
  // 2026-02 起 Development Mode 下 limit 上限为 10
  const safeLimit = Math.min(limit, 10);
  const data = await api<{ tracks?: { items: RawSpotifyTrack[] } }>(
    `/search?q=${encodeURIComponent(query)}&type=track&limit=${safeLimit}`,
  );
  return (data.tracks?.items ?? []).filter((t) => t?.id).map(toSpotifyTrack);
}

/** 上传歌单封面：body 是纯 base64 JPEG，上限 256KB。需要 ugc-image-upload scope。 */
export async function setPlaylistCover(playlistId: string, jpegBase64: string): Promise<void> {
  await api(`/playlists/${playlistId}/images`, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/jpeg' },
    body: jpegBase64,
  });
}

export async function createPlaylist(
  name: string,
  description: string,
  isPublic: boolean,
): Promise<{ id: string; url: string }> {
  const data = await api<{ id: string; external_urls?: { spotify?: string } }>('/me/playlists', {
    method: 'POST',
    body: JSON.stringify({ name, description, public: isPublic }),
  });
  return { id: data.id, url: data.external_urls?.spotify ?? `https://open.spotify.com/playlist/${data.id}` };
}

/** 2026-02 起 /playlists/{id}/tracks 改名为 /items，这里两者都兼容。 */
async function mutateItems(
  playlistId: string,
  method: 'POST' | 'PUT',
  uris: string[],
): Promise<void> {
  try {
    await api(`/playlists/${playlistId}/items`, {
      method,
      body: JSON.stringify({ uris }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/→ 404|→ 405/.test(message)) {
      await api(`/playlists/${playlistId}/tracks`, {
        method,
        body: JSON.stringify({ uris }),
      });
      return;
    }
    throw err;
  }
}

export async function addTracks(
  playlistId: string,
  uris: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  let added = 0;
  for (let i = 0; i < uris.length; i += 100) {
    await mutateItems(playlistId, 'POST', uris.slice(i, i + 100));
    added += Math.min(100, uris.length - i);
    onProgress?.(added, uris.length);
    if (i + 100 < uris.length) await sleep(300);
  }
  return added;
}

/** 整表替换：第一批发 PUT 清空重写，其余追加 */
export async function replaceTracks(
  playlistId: string,
  uris: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  if (!uris.length) return 0;
  let written = 0;
  for (let i = 0; i < uris.length; i += 100) {
    await mutateItems(playlistId, i === 0 ? 'PUT' : 'POST', uris.slice(i, i + 100));
    written += Math.min(100, uris.length - i);
    onProgress?.(written, uris.length);
    if (i + 100 < uris.length) await sleep(300);
  }
  return written;
}

export async function changePlaylistDetails(
  playlistId: string,
  details: { name?: string; description?: string; public?: boolean },
): Promise<void> {
  await api(`/playlists/${playlistId}`, { method: 'PUT', body: JSON.stringify(details) });
}
