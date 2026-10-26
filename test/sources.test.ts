import assert from 'node:assert/strict';
import test from 'node:test';
import { detectSource, getSource, listSources } from '../src/sources/index.ts';
import { prepareCoverBase64 } from '../src/cover.ts';

test('默认来源是网易云', () => {
  assert.equal(getSource().id, 'netease');
  assert.equal(listSources().length, 1);
});

test('能认出网易云的链接、短链和裸 id', () => {
  assert.equal(detectSource('https://music.163.com/#/playlist?id=3778678').id, 'netease');
  assert.equal(detectSource('https://y.music.163.com/m/playlist?id=3778678').id, 'netease');
  assert.equal(detectSource('https://163cn.tv/zoIxm3').id, 'netease');
  assert.equal(detectSource('3778678').id, 'netease');
});

test('未知来源给出可用列表', () => {
  assert.throws(() => getSource('qq'), /不支持的来源：qq（可用：netease）/);
});

test('网易云封面尺寸规则', () => {
  const source = getSource('netease');
  assert.equal(
    source.coverSize?.('https://p1.music.126.net/a.jpg', 640),
    'https://p1.music.126.net/a.jpg?param=640y640',
  );
  assert.equal(
    source.coverSize?.('https://p1.music.126.net/a.jpg?x=1', 320),
    'https://p1.music.126.net/a.jpg?x=1&param=320y320',
  );
  assert.equal(source.playlistUrl('123'), 'https://music.163.com/#/playlist?id=123');
});

test('封面转 base64：JPEG 通过', async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
  const base64 = await prepareCoverBase64({ url: `data:image/jpeg;base64,${jpeg.toString('base64')}` });
  assert.equal(base64, jpeg.toString('base64'));
});

test('封面转 base64：非 JPEG 直接拒绝', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  await assert.rejects(
    prepareCoverBase64({ url: `data:image/png;base64,${png.toString('base64')}` }),
    /只接受 JPEG/,
  );
});

test('封面转 base64：超过 256KB 时降级，全部超限则报错', async () => {
  const huge = Buffer.alloc(300 * 1024, 0xff);
  await assert.rejects(
    prepareCoverBase64({ url: `data:image/jpeg;base64,${huge.toString('base64')}`, sizes: [640] }),
    /超过 256KB/,
  );
});
