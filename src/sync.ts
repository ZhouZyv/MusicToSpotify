import type { MatchResult } from './match.ts';
import type { NeteasePlaylist } from './netease.ts';
import { fetchCover } from './netease.ts';
import {
  addTracks,
  changePlaylistDetails,
  createPlaylist,
  replaceTracks,
  setPlaylistCover,
} from './spotify.ts';
import { writeCsv } from './report.ts';
import { uriFrom } from './state.ts';

export type Include = 'auto' | 'review' | 'all' | 'none';

export type Selection = { result: MatchResult; uri: string; source: 'auto' | 'manual' };
export type Skipped = { result: MatchResult; reason: string };

export type Plan = { selected: Selection[]; skipped: Skipped[] };

/**
 * 决定「导哪些」。纯函数，方便测试。
 * choices 里点名的曲目优先级最高（可以跳过 include 的限制）。
 */
export function buildPlan(results: MatchResult[], include: Include, choices: Map<number, string>): Plan {
  const selected: Selection[] = [];
  const skipped: Skipped[] = [];

  for (const result of results) {
    const choice = choices.get(result.index);

    if (choice !== undefined) {
      if (choice.toLowerCase() === 'skip') {
        skipped.push({ result, reason: 'choices 标记跳过' });
        continue;
      }
      const uri = uriFrom(choice);
      if (!uri) throw new Error(`第 ${result.index + 1} 首的 choices 内容无法识别：${choice}`);
      selected.push({ result, uri, source: 'manual' });
      continue;
    }

    if (!result.best) {
      skipped.push({ result, reason: 'Spotify 没有找到' });
      continue;
    }

    const allowed =
      include === 'all'
        ? true
        : include === 'review'
          ? result.status === 'auto' || result.status === 'review'
          : include === 'none'
            ? false
            : result.status === 'auto';

    if (allowed) {
      selected.push({ result, uri: result.best.track.uri, source: 'auto' });
    } else {
      skipped.push({
        result,
        reason: include === 'none' ? 'choices 未点名' : `置信度不足（${result.status}）`,
      });
    }
  }

  const strayChoices = [...choices.keys()].filter((i) => !results.some((r) => r.index === i));
  if (strayChoices.length) {
    console.warn(`警告：choices 里有 ${strayChoices.length} 个序号超出范围，已忽略`);
  }

  return { selected, skipped };
}

export type ApplyOptions = {
  playlist: NeteasePlaylist;
  plan: Plan;
  name: string;
  isPublic: boolean;
  description: string;
  /** 传了就是更新已有歌单（整表替换），否则新建 */
  targetId?: string;
  cover?: boolean;
  outDir?: string;
  onProgress?: (done: number, total: number) => void;
};

export async function applyPlan(options: ApplyOptions): Promise<{
  id: string;
  url: string;
  added: number;
  coverUploaded: boolean;
}> {
  const { playlist, plan, name, isPublic, description } = options;
  const uris = plan.selected.map((s) => s.uri);
  let id = options.targetId ?? '';
  let url = '';

  if (id) {
    await changePlaylistDetails(id, {
      name,
      public: isPublic,
      ...(description ? { description } : {}),
    });
    await replaceTracks(id, uris, options.onProgress);
    url = `https://open.spotify.com/playlist/${id}`;
  } else {
    const created = await createPlaylist(name, description, isPublic);
    id = created.id;
    url = created.url;
    await addTracks(id, uris, options.onProgress);
  }

  let coverUploaded = false;
  if (options.cover !== false) {
    try {
      const base64 = await fetchCover(playlist);
      await setPlaylistCover(id, base64);
      coverUploaded = true;
    } catch (err) {
      console.warn(`  封面没同步上：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { id, url, added: uris.length, coverUploaded };
}

/** 把「导了什么」写到 out/<name>.imported.csv，方便事后核对 */
export function writeImportLog(path: string, plan: Plan): void {
  writeCsv(
    path,
    ['index', 'netease', 'spotify', 'spotify_url', 'source'],
    plan.selected.map((s) => [
      s.result.index + 1,
      `${s.result.netease.name} — ${s.result.netease.artists.join('/')}`,
      s.result.best ? `${s.result.best.track.name} — ${s.result.best.track.artists.join('/')}` : '',
      s.result.best?.track.url ?? '',
      s.source,
    ]),
  );
}
