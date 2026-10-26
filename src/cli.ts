#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { CACHE_DIR, OUT_DIR, config } from './config.ts';
import { fetchCover, fetchPlaylist, resolvePlaylistId } from './netease.ts';
import type { NeteasePlaylist } from './netease.ts';
import { matchPlaylist } from './match.ts';
import type { MatchResult } from './match.ts';
import { login, me, searchTracks, getAccessToken, setPlaylistCover } from './spotify.ts';
import { applyPlan, buildPlan, writeImportLog } from './sync.ts';
import type { Include } from './sync.ts';
import { getTarget, parseChoices, saveTarget, spotifyPlaylistId } from './state.ts';
import { printNeedsReview, printTable, resultsToCsv, writeCsv } from './report.ts';

type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=', 2);
      if (!key) continue;
      if (inline !== undefined) {
        flags[key] = inline;
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function slugify(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|\s]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'playlist'
  );
}

async function loadPlaylist(input: string, refresh = false): Promise<NeteasePlaylist> {
  if (!refresh) {
    const id = await resolvePlaylistId(input);
    const path = join(CACHE_DIR, 'netease', `${id}.json`);
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as NeteasePlaylist;
  }
  const playlist = await fetchPlaylist(input);
  mkdirSync(join(CACHE_DIR, 'netease'), { recursive: true });
  writeFileSync(join(CACHE_DIR, 'netease', `${playlist.id}.json`), JSON.stringify(playlist, null, 2));
  return playlist;
}

async function runMatching(playlist: NeteasePlaylist, limit?: number): Promise<MatchResult[]> {
  const total = limit ? Math.min(limit, playlist.tracks.length) : playlist.tracks.length;
  console.log(`开始匹配 ${total} 首曲目…`);
  const results = await matchPlaylist(playlist.tracks, {
    limit,
    onProgress: (done, all, result) => {
      const icon = result.status === 'auto' ? '✅' : result.status === 'review' ? '⚠️ ' : '❌';
      process.stdout.write(`\r  ${done}/${all} ${icon} ${result.netease.name.slice(0, 24).padEnd(26)}`);
    },
  });
  process.stdout.write('\n');
  mkdirSync(join(CACHE_DIR, 'matches'), { recursive: true });
  writeFileSync(
    join(CACHE_DIR, 'matches', `${playlist.id}.json`),
    JSON.stringify({ createdAt: new Date().toISOString(), results }, null, 2),
  );
  return results;
}

function loadMatchCache(playlist: NeteasePlaylist): MatchResult[] | null {
  const path = join(CACHE_DIR, 'matches', `${playlist.id}.json`);
  if (!existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, 'utf8')) as { results: MatchResult[] };
  return data.results;
}

function summarize(results: MatchResult[]): void {
  const counts = { auto: 0, review: 0, missing: 0 };
  for (const r of results) counts[r.status]++;
  console.log(
    `\n匹配结果：✅ 自动 ${counts.auto} · ⚠️ 待确认 ${counts.review} · ❌ 未找到 ${counts.missing}（共 ${results.length} 首）`,
  );
}

/** 终端里逐首确认，答案写回 choices */
async function reviewInteractively(
  results: MatchResult[],
  choices: Map<number, string>,
): Promise<boolean> {
  const pending = results.filter((r) => r.status !== 'auto' && !choices.has(r.index));
  if (!pending.length) {
    console.log('\n没有需要人工确认的曲目。');
    return true;
  }
  if (!process.stdin.isTTY) {
    console.log('\n（当前不是交互终端，跳过逐首复核，按 --include 规则处理）');
    return true;
  }

  console.log(`\n有 ${pending.length} 首需要确认。回车=选第 1 个，s=跳过，q=退出\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const result of pending) {
      const { netease } = result;
      console.log(
        `[${result.index + 1}/${results.length}] ${netease.name} — ${netease.artists.join('/')}（${Math.round(netease.durationMs / 1000)}s）`,
      );
      if (!result.alternatives.length) {
        console.log('    没有候选，跳过\n');
        choices.set(result.index, 'skip');
        continue;
      }
      result.alternatives.forEach((c, i) => {
        console.log(
          `    ${i + 1}. ${c.track.name} — ${c.track.artists.join('/')} | ${Math.round(c.track.durationMs / 1000)}s | ${c.score.toFixed(2)}`,
        );
      });
      const answer = (await rl.question('  选择 [1-3 / s / Enter=1 / q]: ')).trim().toLowerCase();

      if (answer === 'q') {
        console.log('已退出复核，没有写入任何东西。');
        return false;
      }
      if (answer === 's') {
        choices.set(result.index, 'skip');
        continue;
      }
      const pick = Number(answer || '1');
      const chosen = result.alternatives[Number.isInteger(pick) ? pick - 1 : 0];
      if (!chosen) {
        console.log('    序号无效，跳过');
        choices.set(result.index, 'skip');
        continue;
      }
      choices.set(result.index, chosen.track.uri);
    }
  } finally {
    rl.close();
  }
  return true;
}

async function cmdSync(positional: string[], flags: Flags): Promise<void> {
  const input = positional[0];
  if (!input) {
    throw new Error('用法：node src/cli.ts sync <歌单链接或 id> [--review] [--update] [--dry-run]');
  }

  const playlist = await loadPlaylist(input, Boolean(flags.refresh));
  console.log(`歌单：${playlist.name}（${playlist.trackCount} 首，by ${playlist.creator || '未知'}）`);

  let results = flags['refresh-match'] ? null : loadMatchCache(playlist);
  if (results && results.length !== playlist.tracks.length) results = null;
  if (!results) results = await runMatching(playlist);
  else console.log('使用缓存的匹配结果（--refresh-match 可重新匹配）');

  summarize(results);

  const include = (typeof flags.include === 'string' ? flags.include : 'auto') as Include;
  if (!['auto', 'review', 'all', 'none'].includes(include)) {
    throw new Error('--include 只能是 auto / review / all / none');
  }
  const choices =
    typeof flags.choices === 'string' ? parseChoices(flags.choices) : new Map<number, string>();

  if (flags.review) {
    const ok = await reviewInteractively(results, choices);
    if (!ok) return;
  }

  const plan = buildPlan(results, include, choices);
  const name = typeof flags.name === 'string' ? flags.name : playlist.name;
  const isPublic = !flags.private;

  console.log(`\n歌单「${name}」：将导入 ${plan.selected.length} 首，跳过 ${plan.skipped.length} 首`);
  if (plan.skipped.length) {
    const reasons = new Map<string, number>();
    for (const s of plan.skipped) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
    for (const [reason, count] of reasons) console.log(`  · ${reason}：${count} 首`);
  }

  if (flags['dry-run']) {
    for (const item of plan.selected) {
      console.log(`  ${item.result.netease.name} → ${item.result.best?.track.name ?? item.uri}`);
    }
    console.log('\n--dry-run：没有写入 Spotify');
    return;
  }
  if (!plan.selected.length) {
    console.log('没有可导入的曲目，什么都没做。');
    return;
  }

  const existing = getTarget(playlist.id);
  let targetId: string | undefined;
  if (flags.update) {
    targetId =
      existing?.spotifyId ?? (typeof flags.to === 'string' ? spotifyPlaylistId(flags.to) : undefined);
    if (!targetId) {
      throw new Error('--update 需要目标歌单：之前用本工具建过就直接更新，否则用 --to <Spotify 歌单链接>');
    }
  } else if (existing) {
    console.log(`\n提示：这个歌单之前同步过（${existing.spotifyId}）。加 --update 原地更新，否则会新建一个。`);
  }

  const description =
    typeof flags.description === 'string'
      ? flags.description
      : `从网易云音乐歌单「${playlist.name}」迁移（https://music.163.com/#/playlist?id=${playlist.id}）`;

  const result = await applyPlan({
    playlist,
    plan,
    name,
    isPublic,
    description,
    targetId,
    cover: !flags['no-cover'],
    onProgress: (done, total) => process.stdout.write(`\r  写入 ${done}/${total}`),
  });
  process.stdout.write('\n');

  saveTarget(playlist.id, { spotifyId: result.id, name });
  mkdirSync(OUT_DIR, { recursive: true });
  writeImportLog(join(OUT_DIR, `${slugify(playlist.name)}.imported.csv`), plan);

  console.log(`\n完成 ✅ ${result.added} 首 → ${result.url}`);
  console.log(`  封面：${result.coverUploaded ? '已同步' : '未同步（可用 cover 命令补）'}`);
  if (plan.skipped.length) {
    console.log(
      `  跳过 ${plan.skipped.length} 首：${plan.skipped
        .slice(0, 6)
        .map((s) => s.result.netease.name)
        .join('、')}${plan.skipped.length > 6 ? ' 等' : ''}`,
    );
    console.log('  补漏：node src/cli.ts sync <歌单> --review');
  }
}

async function cmdPreview(positional: string[], flags: Flags): Promise<void> {
  const input = positional[0];
  if (!input) throw new Error('用法：node src/cli.ts preview <歌单链接或 id> [--limit 10] [--refresh]');
  const playlist = await loadPlaylist(input, Boolean(flags.refresh));
  console.log(`歌单：${playlist.name}（${playlist.trackCount} 首，by ${playlist.creator || '未知'}）`);

  const limit = flags.limit ? Number(flags.limit) : undefined;
  const results = await runMatching(playlist, limit);

  summarize(results);
  printTable(results);
  printNeedsReview(results);

  const { header, rows } = resultsToCsv(results);
  const csvPath = join(OUT_DIR, `${slugify(playlist.name)}.csv`);
  writeCsv(csvPath, header, rows);
  console.log(`\n完整结果：${csvPath}`);
  console.log('直接导入：node src/cli.ts sync <歌单>       逐首确认：node src/cli.ts sync <歌单> --review');
}

async function cmdShow(positional: string[], flags: Flags): Promise<void> {
  const input = positional[0];
  if (!input) throw new Error('用法：node src/cli.ts show <歌单链接或 id>');
  const playlist = await loadPlaylist(input, Boolean(flags.refresh));
  console.log(`歌单：${playlist.name}（${playlist.trackCount} 首，by ${playlist.creator || '未知'}）`);
  for (const [i, t] of playlist.tracks.entries()) {
    console.log(
      `${String(i + 1).padStart(3)}. ${t.name} — ${t.artists.join('/')} | ${t.album} | ${Math.round(t.durationMs / 1000)}s`,
    );
  }
}

async function cmdExport(positional: string[], flags: Flags): Promise<void> {
  const input = positional[0];
  if (!input) throw new Error('用法：node src/cli.ts export <歌单链接或 id>');
  const playlist = await loadPlaylist(input, Boolean(flags.refresh));
  const lines = playlist.tracks.map((t) => `${t.name} - ${t.artists.join(', ')}`);
  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, `${slugify(playlist.name)}.txt`);
  writeFileSync(path, lines.join('\n') + '\n');
  console.log(`已导出 ${lines.length} 行到 ${path}`);
  console.log('可以直接粘贴到 TuneMyMusic / Soundiiz 的「任意文本」来源。');
}

async function cmdCover(positional: string[], flags: Flags): Promise<void> {
  const input = positional[0];
  const target = typeof flags.to === 'string' ? flags.to : '';
  if (!input || !target) {
    throw new Error('用法：node src/cli.ts cover <网易云歌单|id> --to <Spotify 歌单链接|id>');
  }
  const playlist = await loadPlaylist(input, Boolean(flags.refresh));
  const playlistId = spotifyPlaylistId(target);
  console.log(`正在同步封面：${playlist.name}`);
  const base64 = await fetchCover(playlist);
  await setPlaylistCover(playlistId, base64);
  console.log(`已更新封面 → https://open.spotify.com/playlist/${playlistId}`);
}

async function cmdDoctor(): Promise<void> {
  const checks: [string, () => Promise<string>][] = [
    [
      '.env 文件',
      async () => {
        if (!existsSync(join(process.cwd(), '.env')))
          throw new Error('找不到 .env（先 cp .env.example .env）');
        return '.env 存在';
      },
    ],
    [
      'Client ID',
      async () => {
        if (!config.clientId) throw new Error('为空（去 Dashboard 复制 Client ID）');
        return `已配置（${config.clientId.slice(0, 6)}…）`;
      },
    ],
    ['Redirect URI', async () => `${config.redirectUri}（必须和 Dashboard 里完全一致）`],
    [
      '登录状态',
      async () => {
        await getAccessToken();
        return '已有 token';
      },
    ],
    [
      'Spotify /me',
      async () => {
        const user = await me();
        return `已连通，账号 ${user.display_name}（${user.id}）`;
      },
    ],
    [
      '搜索接口',
      async () => {
        const tracks = await searchTracks('track:"晴天" artist:"周杰伦"', 3);
        if (!tracks.length) return '能调通，但这首歌没搜到（可能是市场限制）';
        return `能调通，返回 ${tracks.length} 条，例如 ${tracks[0]?.name} — ${tracks[0]?.artists.join('/')}`;
      },
    ],
  ];

  for (const [name, run] of checks) {
    try {
      console.log(`✅ ${name}：${await run()}`);
    } catch (err) {
      console.log(`❌ ${name}：${err instanceof Error ? err.message : String(err)}`);
      if (name === '登录状态' || name === 'Spotify /me') {
        console.log('\n后续步骤：');
        console.log('  1) 确认 App 所有者是 Premium 账号');
        console.log('  2) node src/cli.ts login');
        return;
      }
    }
  }
  console.log('\n全部通过，可以跑 sync 了。');
}

function usage(): void {
  console.log(`网易云歌单 → Spotify

核心：
  node src/cli.ts sync <歌单>              一条命令跑完：匹配 → 建歌单 → 写曲目 → 传封面
  node src/cli.ts sync <歌单> --review      逐首确认后再导入（终端交互）
  node src/cli.ts sync <歌单> --update      更新之前同步过的歌单（整表替换）

辅助：
  node src/cli.ts login                    授权 Spotify（含上传封面权限）
  node src/cli.ts whoami                   当前账号
  node src/cli.ts preview <歌单>           只看匹配结果，不写 Spotify
  node src/cli.ts show <歌单>              只看网易云歌单内容
  node src/cli.ts export <歌单>            导出「歌名 - 歌手」文本（TuneMyMusic 兜底）
  node src/cli.ts cover <歌单> --to <spotify>   单独同步封面
  node src/cli.ts doctor                   检查配置与连通性

参数：
  --include auto|review|all|none   导入范围（默认 auto）
  --choices file.csv               按序号指定 uri / skip
  --name "名称"                    指定 Spotify 歌单名
  --description "..."              指定歌单描述
  --private                        建为私密歌单
  --limit N                        只处理前 N 首
  --refresh                        重新抓网易云
  --refresh-match                  忽略缓存重新匹配
  --dry-run                        只打印不写入
  --no-cover                       不传封面
`);
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional.shift();
  switch (command) {
    case 'login': {
      await login();
      const user = await me();
      console.log(`已登录：${user.display_name}（${user.id}）`);
      break;
    }
    case 'whoami': {
      const user = await me();
      console.log(`当前账号：${user.display_name}（${user.id}）`);
      break;
    }
    case 'sync':
    case 'import':
      await cmdSync(positional, flags);
      break;
    case 'preview':
      await cmdPreview(positional, flags);
      break;
    case 'show':
      await cmdShow(positional, flags);
      break;
    case 'export':
      await cmdExport(positional, flags);
      break;
    case 'cover':
      await cmdCover(positional, flags);
      break;
    case 'doctor':
      await cmdDoctor();
      break;
    case 'help':
    case undefined:
      usage();
      break;
    default:
      console.error(`未知命令：${command}\n`);
      usage();
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(`\n出错：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
