/**
 * 封面图处理：与来源、目标平台都无关。
 * 输入一个图片 URL（来源可提供按尺寸取变体的规则），输出 Spotify 接受的 base64 JPEG。
 */

/** Spotify PUT /playlists/{id}/images 的上限是 256KB（base64 之后） */
const MAX_BASE64_BYTES = 256 * 1024;

export type CoverInput = {
  url: string;
  /** 来源的缩放规则，比如网易云是 url?param=640y640 */
  sizeUrl?: (url: string, size: number) => string;
  sizes?: number[];
  headers?: Record<string, string>;
};

export async function prepareCoverBase64({
  url,
  sizeUrl,
  sizes = [640, 512, 320],
  headers,
}: CoverInput): Promise<string> {
  if (!url) throw new Error('这个歌单没有封面图');

  let lastError: Error | null = null;
  for (const size of sizes) {
    const target = sizeUrl ? sizeUrl(url, size) : url;
    const res = await fetch(target, headers ? { headers } : undefined);
    if (!res.ok) {
      lastError = new Error(`下载封面失败 HTTP ${res.status}`);
      continue;
    }

    const type = res.headers.get('content-type') ?? '';
    if (type && !/jpe?g/i.test(type)) {
      throw new Error(`封面是 ${type}，Spotify 只接受 JPEG`);
    }

    const base64 = Buffer.from(await res.arrayBuffer()).toString('base64');
    if (base64.length <= MAX_BASE64_BYTES) return base64;

    lastError = new Error(
      `封面 ${size}px 转 base64 后 ${(base64.length / 1024).toFixed(0)}KB，超过 ${MAX_BASE64_BYTES / 1024}KB`,
    );
  }

  throw lastError ?? new Error('取封面失败');
}
