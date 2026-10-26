import { config } from '../config.ts';
import type { MusicSource, SourcePlaylist, SourceTrack } from './types.ts';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const PLAYLIST_URL = 'https://music.163.com/#/playlist?id=';

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    'User-Agent': UA,
    Referer: 'https://music.163.com/',
    Accept: 'application/json, text/plain, */*',
  };
  if (config.neteaseCookie) h.Cookie = config.neteaseCookie;
  return h;
}

function idFromUrl(url: string): string {
  const decoded = decodeURIComponent(url);
  const match = /[?&#/]id=(\d+)/.exec(decoded) ?? /\/playlist\/(\d+)/.exec(decoded);
  if (!match?.[1]) {
    throw new Error(`无法从链接里解析歌单 id：${url}`);
  }
  return match[1];
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

function toTrack(raw: RawTrack): SourceTrack {
  return {
    id: String(raw.id),
    name: raw.name,
    artists: (raw.ar ?? raw.artists ?? []).map((a) => a.name).filter(Boolean),
    album: (raw.al ?? raw.album)?.name ?? '',
    durationMs: raw.dt ?? raw.duration ?? 0,
  };
}

async function fetchSongDetails(ids: number[]): Promise<SourceTrack[]> {
  const out: SourceTrack[] = [];
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

async function resolveId(input: string): Promise<string> {
  const raw = input.trim();
  if (/^\d+$/.test(raw)) return raw;

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

async function fetchPlaylist(input: string): Promise<SourcePlaylist> {
  const id = await resolveId(input);
  const res = await fetch(`https://music.163.com/api/v6/playlist/detail?id=${id}&n=1000&s=0`, {
    headers: headers(),
  });
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
    const missing = orderedIds.filter((raw) => !known.has(String(raw)));
    if (missing.length) {
      for (const track of await fetchSongDetails(missing)) known.set(track.id, track);
    }
    const ordered: SourceTrack[] = [];
    for (const raw of orderedIds) {
      const track = known.get(String(raw));
      if (track) ordered.push(track);
    }
    if (ordered.length) tracks = ordered;
    const lost = playlist.trackCount ? playlist.trackCount - tracks.length : 0;
    if (lost > 0) {
      console.warn(`注意：有 ${lost} 首曲目在网易云已下架/失效，已跳过。`);
    }
  }

  return {
    sourceId: 'netease',
    sourceLabel: '网易云音乐',
    id: String(playlist.id),
    name: playlist.name,
    description: playlist.description ?? '',
    coverUrl: playlist.coverImgUrl ?? '',
    creator: playlist.creator?.nickname ?? '',
    url: PLAYLIST_URL + playlist.id,
    trackCount: playlist.trackCount ?? tracks.length,
    tracks,
  };
}

export const neteaseSource: MusicSource = {
  id: 'netease',
  label: '网易云音乐',
  canHandle(input) {
    return /\d+/.test(input) || /music\.163\.com|163cn\.tv/.test(input);
  },
  resolveId,
  fetchPlaylist,
  // 网易云图床支持 ?param=WxH 直接出指定尺寸
  coverSize(url, size) {
    return `${url}${url.includes('?') ? '&' : '?'}param=${size}y${size}`;
  },
  playlistUrl(id) {
    return PLAYLIST_URL + id;
  },
};
