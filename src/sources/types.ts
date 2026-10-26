/**
 * 音乐来源（网易云、以后可能是 QQ 音乐 / 酷狗 / 本地文件…）的统一接口。
 *
 * 只放「只有来源自己知道」的东西：怎么从链接里认出歌单、怎么抓曲目、封面怎么取不同尺寸。
 * 匹配、选曲、写入 Spotify、封面转码、缓存这些都与来源无关，放在 src/ 根目录。
 */
export type SourceTrack = {
  /** 来源侧的唯一 id，字符串化以便容纳非数字 id */
  id: string;
  name: string;
  artists: string[];
  album: string;
  durationMs: number;
};

export type SourcePlaylist = {
  /** 对应 MusicSource.id，例如 'netease' */
  sourceId: string;
  /** 展示用名称，例如 '网易云音乐' */
  sourceLabel: string;
  id: string;
  name: string;
  description: string;
  coverUrl: string;
  creator: string;
  /** 可点开的原歌单地址 */
  url: string;
  trackCount: number;
  tracks: SourceTrack[];
};

export interface MusicSource {
  /** 稳定的来源标识，用于缓存目录、targets 状态、--source 参数 */
  readonly id: string;
  /** 展示名 */
  readonly label: string;
  /** 判断这个输入是不是本来源的歌单（链接或 id） */
  canHandle(input: string): boolean;
  /** 把用户给的任意形式（链接/短链/id）解析成稳定 id */
  resolveId(input: string): Promise<string>;
  /** 抓歌单 + 全部曲目（含顺序） */
  fetchPlaylist(input: string): Promise<SourcePlaylist>;
  /** 封面图按边长取变体的 URL 规则，来源不支持缩放时不实现 */
  coverSize?(url: string, size: number): string;
  /** 由 id 还原可点开的原歌单地址 */
  playlistUrl(id: string): string;
}
