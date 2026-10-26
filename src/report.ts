import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MatchResult } from './match.ts';

export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const wide =
      cp >= 0x1100 &&
      (cp <= 0x115f ||
        (cp >= 0x2e80 && cp <= 0xa4cf) ||
        (cp >= 0xac00 && cp <= 0xd7a3) ||
        (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0xfe30 && cp <= 0xfe6f) ||
        (cp >= 0xff00 && cp <= 0xff60) ||
        (cp >= 0xffe0 && cp <= 0xffe6));
    width += wide ? 2 : 1;
  }
  return width;
}

export function truncate(text: string, max: number): string {
  if (displayWidth(text) <= max) return text;
  let out = '';
  let width = 0;
  for (const ch of text) {
    const w = displayWidth(ch);
    if (width + w > max - 1) break;
    out += ch;
    width += w;
  }
  return out + '…';
}

export function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

function csvCell(value: string | number | undefined): string {
  const s = value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function writeCsv(path: string, header: string[], rows: (string | number | undefined)[][]): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
  writeFileSync(path, '\uFEFF' + body + '\n');
}

export function resultsToCsv(results: MatchResult[]): { header: string[]; rows: (string | number)[][] } {
  const header = [
    'index',
    'status',
    'score',
    'source_title',
    'source_artists',
    'source_album',
    'source_sec',
    'spotify_title',
    'spotify_artists',
    'spotify_album',
    'spotify_uri',
    'spotify_url',
    'alternatives',
  ];
  const rows = results.map((r) => {
    const best = r.best;
    const alternatives = r.alternatives
      .filter((c) => c.track.uri !== best?.track.uri)
      .map((c) => `${c.track.name} — ${c.track.artists.join('/')} (${c.score.toFixed(2)})`)
      .join(' | ');
    return [
      r.index + 1,
      r.status,
      best ? best.score.toFixed(3) : '',
      r.source.name,
      r.source.artists.join('/'),
      r.source.album,
      Math.round(r.source.durationMs / 1000),
      best?.track.name ?? '',
      best?.track.artists.join('/') ?? '',
      best?.track.album ?? '',
      best?.track.uri ?? '',
      best?.track.url ?? '',
      alternatives,
    ];
  });
  return { header, rows };
}

export function printTable(results: MatchResult[]): void {
  const icon: Record<string, string> = { auto: '✅', review: '⚠️ ', missing: '❌' };
  const lines: string[] = [];
  const header = `${pad('#', 4)}${pad('状态', 7)}${pad('分数', 7)}${pad('网易云', 40)}${pad('Spotify', 44)}`;
  lines.push(header);
  lines.push('─'.repeat(displayWidth(header)));
  for (const r of results) {
    const left = `${r.source.name} — ${r.source.artists.join('/')}`;
    const right = r.best ? `${r.best.track.name} — ${r.best.track.artists.join('/')}` : '（未找到）';
    lines.push(
      pad(String(r.index + 1), 4) +
        pad(`${icon[r.status]} ${r.status}`, 9) +
        pad(r.best ? r.best.score.toFixed(2) : '—', 7) +
        pad(truncate(left, 38), 40) +
        pad(truncate(right, 42), 44),
    );
  }
  console.log(lines.join('\n'));
}

export function printNeedsReview(results: MatchResult[]): void {
  const flagged = results.filter((r) => r.status !== 'auto');
  if (!flagged.length) return;
  console.log('\n需要人工确认的曲目：');
  for (const r of flagged) {
    console.log(`\n[${r.index + 1}] ${r.source.name} — ${r.source.artists.join('/')}（${Math.round(r.source.durationMs / 1000)}s）`);
    if (!r.alternatives.length) {
      console.log('    没有任何候选');
      continue;
    }
    for (const [i, c] of r.alternatives.entries()) {
      console.log(
        `    ${i + 1}. ${c.track.name} — ${c.track.artists.join('/')} | ${c.track.album} | ${Math.round(c.track.durationMs / 1000)}s | ${c.score.toFixed(2)}${c.track.playable ? '' : ' | 该市场不可播放'}`,
      );
    }
  }
}
