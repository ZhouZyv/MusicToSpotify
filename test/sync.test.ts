import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPlan } from '../src/sync.ts';
import { parseChoices, uriFrom } from '../src/state.ts';
import type { MatchResult } from '../src/match.ts';
import type { SourceTrack } from '../src/sources/types.ts';
import type { SpotifyTrack } from '../src/spotify.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const nt = (i: number): SourceTrack => ({
  id: String(i),
  name: `歌${i}`,
  artists: ['某人'],
  album: '',
  durationMs: 200_000,
});

const st = (id: string): SpotifyTrack => ({
  uri: `spotify:track:${id}`,
  id,
  name: `歌${id}`,
  artists: ['某人'],
  album: '',
  durationMs: 200_000,
  url: `https://open.spotify.com/track/${id}`,
  playable: true,
});

function result(index: number, status: MatchResult['status'], uri = 'aaa'): MatchResult {
  return {
    index,
    source: nt(index),
    status,
    best:
      status === 'missing'
        ? null
        : {
            track: st(uri),
            score: 0.9,
            titleSim: 1,
            artistSim: 1,
            durationScore: 1,
            versionPenalty: 0,
            boosted: false,
          },
    alternatives: [],
    queries: [],
  };
}

const results = [
  result(0, 'auto', 'auto1'),
  result(1, 'review', 'review1'),
  result(2, 'missing'),
  result(3, 'auto', 'auto2'),
];

test('include=auto 只导自动匹配的', () => {
  const plan = buildPlan(results, 'auto', new Map());
  assert.deepEqual(
    plan.selected.map((s) => s.uri),
    ['spotify:track:auto1', 'spotify:track:auto2'],
  );
  assert.equal(plan.skipped.length, 2);
  assert.ok(plan.skipped.some((s) => s.reason === 'Spotify 没有找到'));
});

test('include=review 连待确认的一起导', () => {
  const plan = buildPlan(results, 'review', new Map());
  assert.equal(plan.selected.length, 3);
});

test('include=none 只导 choices 点名的', () => {
  const plan = buildPlan(results, 'none', new Map([[1, 'spotify:track:bbb']]));
  assert.deepEqual(
    plan.selected.map((s) => [s.uri, s.source]),
    [['spotify:track:bbb', 'manual']],
  );
});

test('choices 的 skip 优先于 include', () => {
  const plan = buildPlan(results, 'all', new Map([[0, 'skip']]));
  assert.ok(!plan.selected.some((s) => s.result.index === 0));
  assert.equal(plan.selected.length, 2);
});

test('choices 内容非法时抛错', () => {
  assert.throws(() => buildPlan(results, 'auto', new Map([[0, '不是链接']])), /无法识别/);
});

test('uriFrom 接受 uri / 链接 / 裸 id', () => {
  assert.equal(uriFrom('spotify:track:4iV5W9uYEdYUVa79Axb7Rh'), 'spotify:track:4iV5W9uYEdYUVa79Axb7Rh');
  assert.equal(
    uriFrom('https://open.spotify.com/track/4iV5W9uYEdYUVa79Axb7Rh'),
    'spotify:track:4iV5W9uYEdYUVa79Axb7Rh',
  );
  assert.equal(uriFrom('4iV5W9uYEdYUVa79Axb7Rh'), 'spotify:track:4iV5W9uYEdYUVa79Axb7Rh');
  assert.equal(uriFrom('skip'), null);
});

test('parseChoices 忽略表头与注释', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mts-'));
  const file = join(dir, 'choices.csv');
  writeFileSync(file, 'index,action\n# 注释\n7,spotify:track:abc\n9,skip\n');
  const choices = parseChoices(file);
  assert.equal(choices.get(6), 'spotify:track:abc');
  assert.equal(choices.get(8), 'skip');
  assert.equal(choices.size, 2);
});
