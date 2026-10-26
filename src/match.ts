import { readFileSync } from 'node:fs';
import type { SourceTrack } from './sources/types.ts';
import type { SpotifyTrack } from './spotify.ts';
import { searchTracks, sleep } from './spotify.ts';

export type MatchStatus = 'auto' | 'review' | 'missing';

export type Candidate = {
  track: SpotifyTrack;
  score: number;
  titleSim: number;
  artistSim: number;
  durationScore: number;
  versionPenalty: number;
  /** 靠「中文标题补偿」救回来的：艺人名对不上，但标题+时长高度一致 */
  boosted: boolean;
};

export type MatchResult = {
  index: number;
  source: SourceTrack;
  status: MatchStatus;
  best: Candidate | null;
  alternatives: Candidate[];
  queries: string[];
};

const AUTO_THRESHOLD = 0.82;
const REVIEW_THRESHOLD = 0.5;
/** 艺人相似度到这个程度，才允许「自动导入」 */
const ARTIST_TRUST = 0.75;
const CJK = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/;

const BRACKETS = /[[(（【{]([^\])）】}]*)[\])）】}]/g;
const NOISE_SUFFIX =
  /\s*[-–—|/]\s*(single version|album version|radio edit|remaster(ed)?(\s+\d{4})?|explicit|clean|mv|完整版)\s*$/i;

/* ---------- 繁简 / 别名 ---------- */

let t2s: Record<string, string> | null = null;
function t2sMap(): Record<string, string> {
  if (!t2s) {
    try {
      t2s = JSON.parse(readFileSync(new URL('../data/t2s.json', import.meta.url), 'utf8')) as Record<string, string>;
    } catch {
      t2s = {};
    }
  }
  return t2s;
}

/** 网易云用简体、Spotify 的中文目录常用繁体（坠/墜、张/張），比对前先统一 */
export function toSimplified(text: string): string {
  const map = t2sMap();
  let out = '';
  for (const ch of text) out += map[ch] ?? ch;
  return out;
}

let aliasTable: Record<string, string[]> | null = null;
function aliasMap(): Record<string, string[]> {
  if (!aliasTable) {
    try {
      aliasTable = JSON.parse(
        readFileSync(new URL('../data/artist-aliases.json', import.meta.url), 'utf8'),
      ) as Record<string, string[]>;
    } catch {
      aliasTable = {};
    }
  }
  return aliasTable;
}

export function aliasesFor(artist: string): string[] {
  return aliasMap()[artist] ?? [];
}

/* ---------- 归一化 ---------- */

export function cleanTitle(raw: string): string {
  let s = raw.normalize('NFKC');
  s = s.replace(BRACKETS, ' ');
  s = s.replace(/\b(?:feat|ft)\.?\s+[^,;/]+/gi, ' ');
  s = s.replace(NOISE_SUFFIX, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

export function compact(s: string): string {
  return toSimplified(s)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

export function dice(a: string, b: string): number {
  const x = compact(a);
  const y = compact(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;

  const bigrams = (s: string): Map<string, number> => {
    const map = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const gram = s.slice(i, i + 2);
      map.set(gram, (map.get(gram) ?? 0) + 1);
    }
    return map;
  };

  const bx = bigrams(x);
  const by = bigrams(y);
  let overlap = 0;
  for (const [gram, count] of bx) {
    overlap += Math.min(count, by.get(gram) ?? 0);
  }
  return (2 * overlap) / (x.length - 1 + (y.length - 1));
}

export function nameSim(a: string, b: string): number {
  const x = compact(a);
  const y = compact(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length >= 2 && y.length >= 2 && (x.includes(y) || y.includes(x))) return 0.88;
  return dice(a, b);
}

function artistSim(sourceArtists: string[], targetArtists: string[]): number {
  if (!sourceArtists.length || !targetArtists.length) return 0;
  let best = 0;
  for (const artist of sourceArtists) {
    const variants = [artist, ...aliasesFor(artist)];
    for (const variant of variants) {
      for (const other of targetArtists) {
        best = Math.max(best, nameSim(variant, other));
        if (best === 1) return 1;
      }
    }
  }
  const joined = Math.max(
    nameSim(sourceArtists.join(' '), targetArtists.join(' ')),
    nameSim(sourceArtists.join(''), targetArtists.join('')),
  );
  return Math.max(best, joined * 0.95);
}

/* ---------- 版本识别 ---------- */

const VERSION_PATTERNS: [string, RegExp][] = [
  ['live', /\blive\b|现场|演唱会|unplugged/i],
  ['remix', /\bremix\b|\bmix\b|混音|\bdj\b/i],
  ['acoustic', /\bacoustic\b|不插电/i],
  ['instrumental', /\binstrumental\b|伴奏|纯音乐|\bkaraoke\b|卡拉\s*ok/i],
  ['demo', /\bdemo\b/i],
  ['cover', /\bcover\b|翻唱/i],
  ['sped', /sped up|slowed|加速版|降速版/i],
  ['sequel', /\bpt\.?\s*2\b|\bpart\s*2\b|\b2\.0\b/i],
];

export function versionFlags(raw: string): Set<string> {
  const flags = new Set<string>();
  for (const [name, pattern] of VERSION_PATTERNS) {
    if (pattern.test(raw)) flags.add(name);
  }
  return flags;
}

function versionPenalty(sourceName: string, spotifyName: string): number {
  const a = versionFlags(sourceName);
  const b = versionFlags(spotifyName);
  let diff = 0;
  for (const flag of a) if (!b.has(flag)) diff++;
  for (const flag of b) if (!a.has(flag)) diff++;
  return Math.min(diff * 0.1, 0.2);
}

function durationScore(sourceMs: number, spotifyMs: number): number {
  if (!sourceMs || !spotifyMs) return 0.5;
  const diff = Math.abs(sourceMs - spotifyMs) / 1000;
  if (diff <= 2) return 1;
  if (diff <= 5) return 0.9;
  if (diff <= 10) return 0.6;
  if (diff <= 15) return 0.3;
  if (diff <= 25) return 0.1;
  return 0;
}

/* ---------- 打分 ---------- */

export function scoreCandidate(track: SourceTrack, candidate: SpotifyTrack): Candidate {
  const sourceTitle = cleanTitle(track.name);
  const spotifyTitle = cleanTitle(candidate.name);
  const tSim = Math.max(dice(sourceTitle, spotifyTitle), nameSim(sourceTitle, spotifyTitle));
  const aSim = artistSim(track.artists, candidate.artists);
  const dScore = durationScore(track.durationMs, candidate.durationMs);
  const albSim = dice(track.album, candidate.album);
  const penalty = versionPenalty(track.name, candidate.name);

  let score = 0.5 * tSim + 0.32 * aSim + 0.15 * dScore + 0.03 * albSim;
  let boosted = false;

  // 中文歌在 Spotify 上艺人名常被罗马化（林俊杰 → JJ Lin）。
  // 只有「我们不知道该艺人的罗马化写法」时才敢用标题+时长兜底；
  // 已知别名的艺人，就老老实实按艺人匹配结果判定，避免把翻唱当原唱。
  const knownAlias = track.artists.some((a) => aliasesFor(a).length > 0);
  const sameTitle = tSim >= 0.98 && CJK.test(sourceTitle);
  const closeDuration = Math.abs(track.durationMs - candidate.durationMs) <= 4000;
  if (sameTitle && closeDuration && aSim < 0.3 && penalty === 0 && !knownAlias) {
    score = Math.max(score, 0.86);
    boosted = true;
  }
  score -= penalty;
  if (!candidate.playable) score -= 0.05;

  return {
    track: candidate,
    score: Math.max(0, Math.min(1, Number(score.toFixed(4)))),
    titleSim: Number(tSim.toFixed(4)),
    artistSim: Number(aSim.toFixed(4)),
    durationScore: dScore,
    versionPenalty: penalty,
    boosted,
  };
}

function escapeQuery(value: string): string {
  return value.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function buildQueries(track: SourceTrack): string[] {
  const raw = escapeQuery(track.name);
  const clean = escapeQuery(cleanTitle(track.name));
  const artist = escapeQuery(track.artists[0] ?? '');
  const aliasQueries = track.artists
    .flatMap((a) => aliasesFor(a))
    .slice(0, 2)
    .map((alias) => (clean ? `track:"${clean}" artist:"${escapeQuery(alias)}"` : ''));

  const queries = [
    artist ? `track:"${raw}" artist:"${artist}"` : `track:"${raw}"`,
    ...aliasQueries,
    clean !== raw && artist ? `track:"${clean}" artist:"${artist}"` : '',
    clean ? `track:"${clean}"` : '',
    artist && clean ? `${clean} ${artist}` : '',
  ];
  return [...new Set(queries.filter(Boolean))];
}

export async function matchTrack(track: SourceTrack, index: number): Promise<MatchResult> {
  const queries = buildQueries(track);
  const pool = new Map<string, SpotifyTrack>();

  for (const query of queries) {
    try {
      for (const item of await searchTracks(query, 10)) pool.set(item.uri, item);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`  [warn] 搜索失败 "${query}": ${message.slice(0, 120)}`);
    }
    const ranked = [...pool.values()].map((c) => scoreCandidate(track, c)).sort((a, b) => b.score - a.score);
    if ((ranked[0]?.score ?? 0) >= 0.93) break;
    await sleep(120);
  }

  const ranked = [...pool.values()]
    .map((c) => scoreCandidate(track, c))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0] ?? null;
  let status: MatchStatus = 'missing';
  if (best) {
    // 艺人证据不足时，即使分数够高也只进复核，不自动导入
    const trustworthy = best.artistSim >= ARTIST_TRUST || best.boosted;
    if (best.score >= AUTO_THRESHOLD && trustworthy) status = 'auto';
    else if (best.score >= REVIEW_THRESHOLD) status = 'review';
  }

  return {
    index,
    source: track,
    status,
    best: status === 'missing' ? null : best,
    alternatives: ranked.slice(0, 3),
    queries,
  };
}

export async function matchPlaylist(
  tracks: SourceTrack[],
  options: { limit?: number; onProgress?: (done: number, total: number, result: MatchResult) => void } = {},
): Promise<MatchResult[]> {
  const list = options.limit ? tracks.slice(0, options.limit) : tracks;
  const results: MatchResult[] = [];
  for (const [i, track] of list.entries()) {
    const result = await matchTrack(track, i);
    results.push(result);
    options.onProgress?.(i + 1, list.length, result);
  }
  return results;
}
