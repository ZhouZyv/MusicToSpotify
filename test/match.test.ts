import assert from 'node:assert/strict';
import test from 'node:test';
import { buildQueries, cleanTitle, dice, scoreCandidate, toSimplified, versionFlags } from '../src/match.ts';
import type { NeteaseTrack } from '../src/netease.ts';
import type { SpotifyTrack } from '../src/spotify.ts';

const netease = (over: Partial<NeteaseTrack> = {}): NeteaseTrack => ({
  id: 1,
  name: '晴天',
  artists: ['周杰伦'],
  album: '叶惠美',
  durationMs: 269_000,
  ...over,
});

const spotify = (over: Partial<SpotifyTrack> = {}): SpotifyTrack => ({
  uri: 'spotify:track:abc',
  id: 'abc',
  name: '晴天',
  artists: ['Jay Chou'],
  album: '叶惠美',
  durationMs: 269_000,
  url: 'https://open.spotify.com/track/abc',
  playable: true,
  ...over,
});

test('cleanTitle 去掉括号与 feat', () => {
  assert.equal(cleanTitle('沉溺 (你让我的心不再结冰）'), '沉溺');
  assert.equal(cleanTitle('Star Crossing Night (feat. GALI)'), 'Star Crossing Night');
  assert.equal(cleanTitle('某某 (Live版)'), '某某');
});

test('versionFlags 识别版本', () => {
  assert.ok(versionFlags('爱的回归线 (Live版)').has('live'));
  assert.ok(versionFlags('某某（伴奏）').has('instrumental'));
  assert.equal(versionFlags('晴天').size, 0);
});

test('dice 对中文短标题敏感', () => {
  assert.equal(dice('晴天', '晴天'), 1);
  assert.equal(dice(cleanTitle('晴天 (Live)'), '晴天'), 1);
  assert.ok(dice('晴天', '七里香') < 0.2);
});

test('繁体/简体差异不影响匹配', () => {
  assert.equal(toSimplified('墜'), '坠');
  assert.equal(toSimplified('張'), '张');
  const result = scoreCandidate(
    netease({ name: '坠', artists: ['郑润泽'], album: '漩涡人生' }),
    spotify({ name: '墜', artists: ['郑润泽'], album: '漩渦人生' }),
  );
  assert.ok(result.score >= 0.95, `score=${result.score}`);
});

test('已知别名（周杰伦→Jay Chou）靠别名匹配，不靠补偿', () => {
  const result = scoreCandidate(netease(), spotify());
  assert.equal(result.artistSim, 1);
  assert.equal(result.boosted, false);
  assert.ok(result.score >= 0.95, `score=${result.score}`);
});

test('不知名艺人：标题+时长兜底只给 boosted 标记', () => {
  const result = scoreCandidate(
    netease({ name: '雀跃', artists: ['某独立音乐人'] }),
    spotify({ name: '雀跃', artists: ['Some Indie'] }),
  );
  assert.equal(result.boosted, true);
});

test('有别名但艺人没对上（翻唱）不享受补偿', () => {
  const result = scoreCandidate(
    netease({ name: '愿与愁', artists: ['林俊杰'], album: '愿与愁' }),
    spotify({ name: '愿与愁', artists: ['苏子欲'], album: '愿与愁' }),
  );
  assert.equal(result.boosted, false);
  assert.ok(result.score < 0.82, `score=${result.score}`);
});

test('翻唱/伴奏版本会被压低', () => {
  const original = scoreCandidate(netease(), spotify());
  const karaoke = scoreCandidate(
    netease(),
    spotify({ name: '晴天 (伴奏)', album: '晴天' }),
  );
  assert.ok(karaoke.score < original.score);
});

test('完全不同的歌不会过阈值', () => {
  const result = scoreCandidate(
    netease(),
    spotify({ name: '七里香', album: '七里香', durationMs: 299_000 }),
  );
  assert.ok(result.score < 0.5, `score=${result.score}`);
});

test('buildQueries 生成多级回退', () => {
  const queries = buildQueries(netease({ name: '罗生门（Follow）', artists: ['梨冻紧'] }));
  assert.ok(queries.length >= 2);
  assert.ok(queries[0]?.includes('artist:'));
});
