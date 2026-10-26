import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CACHE_DIR } from '../config.ts';
import { neteaseSource } from './netease.ts';
import type { MusicSource, SourcePlaylist } from './types.ts';

/**
 * 已支持的来源。加一个新来源只要：
 * 1. 在 sources/ 下实现 MusicSource
 * 2. 加进这个数组
 * 其余流程（匹配、选曲、写入、封面、缓存）都不用改。
 */
const SOURCES: MusicSource[] = [neteaseSource];

export function listSources(): MusicSource[] {
  return SOURCES;
}

export function getSource(id?: string): MusicSource {
  if (!id) return SOURCES[0]!;
  const found = SOURCES.find((s) => s.id === id);
  if (!found) {
    throw new Error(`不支持的来源：${id}（可用：${SOURCES.map((s) => s.id).join(' / ')}）`);
  }
  return found;
}

/** 按输入自动认出是哪个来源，认不出就用默认的 */
export function detectSource(input: string): MusicSource {
  return SOURCES.find((s) => s.canHandle(input)) ?? SOURCES[0]!;
}

export type LoadOptions = { refresh?: boolean; sourceId?: string };

/** 抓歌单；缓存按「来源 + id」落盘，重复跑不再打接口 */
export async function loadPlaylist(input: string, options: LoadOptions = {}): Promise<SourcePlaylist> {
  const source = options.sourceId ? getSource(options.sourceId) : detectSource(input);
  const id = await source.resolveId(input);
  const cachePath = join(CACHE_DIR, source.id, `${id}.json`);

  if (!options.refresh && existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as SourcePlaylist & {
      cover?: string;
    };
    // 旧版缓存字段不同（cover → coverUrl、没有 sourceId），结构不符就重新抓
    const fresh = cached.sourceId === source.id && cached.coverUrl !== undefined && Boolean(cached.id);
    if (fresh) return cached;
    console.warn('缓存格式已升级，重新抓一次歌单…');
  }

  const playlist = await source.fetchPlaylist(input);
  mkdirSync(join(CACHE_DIR, source.id), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(playlist, null, 2));
  return playlist;
}
