import { config } from './config.ts';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export type NeteaseTrack = {
  id: number;
  name: string;
  artists: string[];
  album: string;
  durationMs: number;
};

export type NeteasePlaylist = {
  id: number;
  name: string;
  description: string;
  cover: string;
  creator: string;
  trackCount: number;
  tracks: NeteaseTrack[];
};

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    'User-Agent': UA,
    Referer: 'https://music.163.com/',
    Accept: 'application/json, text/plain, */*',
  };
  if (config.neteaseCookie) h.Cookie = config.neteaseCookie;
  return h;
}

function idFromUrl(url: string): number {
  const decoded = decodeURIComponent(url);
  const match = /[?&#/]id=(\d+)/.exec(decoded) ?? /\/playlist\/(\d+)/.exec(decoded);
  if (!match?.[1]) {
    throw new Error(`无法从链接里解析歌单 id：${url}`);
  }
  return Number(match[1]);
}

export async function resolvePlaylistId(input: string): Promise<number> {
  const raw = input.trim();
  if (/^\d+$/.test(raw)) return Number(raw);

  const url = /https?:\/\/\S+/.exec(raw)?.[0];
  if (!url) throw new Error(`无法识别歌单：${input}`);

  if (url.includes('163cn.tv')) {
    const res = await fetch(url, { redirect: 'manual', headers: headers() });
    const location = res.headers.get('location');
    if (!location) throw new Error('网易云短链接跳转失败（可能已过期）');
    return idFromUrl(location);
  }
  return idFromUrl(url);
}

type RawTrack = {
  id: number;
  name: string;
  ar?: { name: string }[];
  artists?: { name: string }[];
  al?: { name: string };
  album?: { name: string };
  dt?: number;
  duration?: number;
};

function toTrack(raw: RawTrack): NeteaseTrack {
  return {
    id: raw.id,
    name: raw.name,
    artists: (raw.ar ?? raw.artists ?? []).map((a) => a.name).filter(Boolean),
    album: (raw.al ?? raw.album)?.name ?? '',
    durationMs: raw.dt ?? raw.duration ?? 0,
  };
}

async function fetchSongDetails(ids: number[]): Promise<NeteaseTrack[]> {
  const out: NeteaseTrack[] = [];
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 200) {
    const chunk = unique.slice(i, i + 200);
    const encoded = encodeURIComponent(`[${chunk.join(',')}]`);
    const res = await fetch(`https://music.163.com/api/song/detail?ids=${encoded}`, {
      headers: headers(),
    });
    const text = await res.text();
    if (!text.trim()) {
      throw new Error('网易云 song/detail 返回空响应（可能是请求过于频繁，稍后重试）');
    }
    const json = JSON.parse(text) as { songs?: RawTrack[] };
    out.push(...(json.songs ?? []).map(toTrack));
  }
  return out;
}

/**
 * 取歌单封面并转成 Spotify 要的 base64 JPEG。
 * 网易云图床支持 ?param=WxH 直接出指定尺寸，尺寸太大时逐步降级。
 */
export async function fetchCover(playlist: NeteasePlaylist, sizes = [640, 512, 320]): Promise<string> {
  if (!playlist.cover) throw new Error('这个歌单没有封面图');
  let lastError: Error | null = null;

  for (const size of sizes) {
    const url = `${playlist.cover}${playlist.cover.includes('?') ? '&' : '?'}param=${size}y${size}`;
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) {
      lastError = new Error(`下载封面失败 HTTP ${res.status}`);
      continue;
    }
    const type = res.headers.get('content-type') ?? '';
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!/jpe?g/i.test(type)) {
      throw new Error(`封面是 ${type || '未知格式'}，Spotify 只接受 JPEG`);
    }
    const base64 = buffer.toString('base64');
    // Spotify 限制 base64 payload ≤ 256KB
    if (base64.length <= 256 * 1024) return base64;
    lastError = new Error(`封面 ${size}px 转 base64 后 ${(base64.length / 1024).toFixed(0)}KB，超过 256KB`);
  }
  throw lastError ?? new Error('取封面失败');
}

export async function fetchPlaylist(input: string): Promise<NeteasePlaylist> {
  const id = await resolvePlaylistId(input);
  const res = await fetch(
    `https://music.163.com/api/v6/playlist/detail?id=${id}&n=1000&s=0`,
    { headers: headers() },
  );
  if (!res.ok) throw new Error(`网易云接口返回 HTTP ${res.status}`);

  const json = (await res.json()) as {
    code: number;
    message?: string;
    playlist?: {
      id: number;
      name: string;
      description?: string;
      coverImgUrl?: string;
      creator?: { nickname?: string };
      trackCount?: number;
      tracks?: RawTrack[];
      trackIds?: { id: number }[];
    };
  };

  const playlist = json.playlist;
  if (json.code !== 200 || !playlist) {
    throw new Error(
      `拿不到歌单 ${id}（code=${json.code}${json.message ? `, ${json.message}` : ''}）。` +
        '常见原因：歌单是私密的（请在网易云里设为公开，或在 .env 配置 NETEASE_COOKIE）、歌单已删除、或 id 不正确。',
    );
  }

  let tracks = (playlist.tracks ?? []).map(toTrack);

  // detail 接口只返回前若干首，trackIds 才是完整且有序的曲目列表
  const orderedIds = (playlist.trackIds ?? []).map((t) => t.id);
  if (orderedIds.length) {
    const known = new Map(tracks.map((t) => [t.id, t]));
    const missing = orderedIds.filter((id) => !known.has(id));
    if (missing.length) {
      for (const track of await fetchSongDetails(missing)) known.set(track.id, track);
    }
    const ordered: NeteaseTrack[] = [];
    for (const id of orderedIds) {
      const track = known.get(id);
      if (track) ordered.push(track);
    }
    if (ordered.length) tracks = ordered;
    const lost = playlist.trackCount ? playlist.trackCount - tracks.length : 0;
    if (lost > 0) {
      console.warn(`注意：有 ${lost} 首曲目在网易云已下架/失效，已跳过。`);
    }
  }

  return {
    id: playlist.id,
    name: playlist.name,
    description: playlist.description ?? '',
    cover: playlist.coverImgUrl ?? '',
    creator: playlist.creator?.nickname ?? '',
    trackCount: playlist.trackCount ?? tracks.length,
    tracks,
  };
}
