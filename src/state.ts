import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CACHE_DIR } from './config.ts';

export type Target = { spotifyId: string; name: string; updatedAt: string };
type TargetTable = Record<string, Target>;

const TARGETS_PATH = join(CACHE_DIR, 'targets.json');

function readTargets(): TargetTable {
  if (!existsSync(TARGETS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(TARGETS_PATH, 'utf8')) as TargetTable;
  } catch {
    return {};
  }
}

export function getTarget(neteaseId: number): Target | null {
  return readTargets()[String(neteaseId)] ?? null;
}

export function saveTarget(neteaseId: number, target: Omit<Target, 'updatedAt'>): void {
  const table = readTargets();
  table[String(neteaseId)] = { ...target, updatedAt: new Date().toISOString() };
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(TARGETS_PATH, JSON.stringify(table, null, 2));
}

/**
 * choices.csv：index,action
 * action 可以是 spotify uri / 链接 / 22 位 id / skip / auto
 */
export function parseChoices(path: string): Map<number, string> {
  const choices = new Map<number, string>();
  const text = readFileSync(path, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('index,')) continue;
    const [index, ...rest] = trimmed.split(',');
    const action = rest.join(',').trim().replace(/^"|"$/g, '');
    const idx = Number(index);
    if (!Number.isInteger(idx) || idx < 1) continue;
    choices.set(idx - 1, action);
  }
  return choices;
}

export function uriFrom(value: string): string | null {
  const v = value.trim();
  if (!v || v === 'auto') return null;
  if (v.startsWith('spotify:track:')) return v;
  const fromUrl = /open\.spotify\.com\/track\/([A-Za-z0-9]+)/.exec(v);
  if (fromUrl?.[1]) return `spotify:track:${fromUrl[1]}`;
  if (/^[A-Za-z0-9]{22}$/.test(v)) return `spotify:track:${v}`;
  return null;
}

export function spotifyPlaylistId(value: string): string {
  const fromUrl = /open\.spotify\.com\/playlist\/([A-Za-z0-9]+)/.exec(value);
  if (fromUrl?.[1]) return fromUrl[1];
  if (/^[A-Za-z0-9]{22}$/.test(value.trim())) return value.trim();
  throw new Error(`无法识别 Spotify 歌单：${value}`);
}
