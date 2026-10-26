# 网易云音乐歌单 → Spotify

把网易云歌单搬到 Spotify：逐首匹配、建歌单、连封面一起带过去。直接调 Spotify Web API，歌单不经过第三方。

```bash
node src/cli.ts sync "https://music.163.com/#/playlist?id=3778678"
```

## 前置条件

- **Node ≥ 22.18**（原生跑 TypeScript，无构建步骤、无运行时依赖）
- **Spotify Premium** —— 2026-02 起 Dev Mode 的 App 必须由 Premium 账号持有，否则 API 一律 403（[公告](https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security)）
- 能访问 `api.spotify.com`（走代理也行）

## 快速开始

**1. 建 Spotify App** —— [Dashboard](https://developer.spotify.com/dashboard) → Create app

Redirect URI 填 `http://127.0.0.1:8888/callback`，勾上 Web API，保存后从 Settings 抄下 Client ID / Secret。

**2. 配置**

```bash
cp .env.example .env
```

```ini
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
SPOTIFY_REDIRECT_URI=http://127.0.0.1:8888/callback
```

只有私密歌单才需要 `NETEASE_COOKIE`（浏览器里复制 `MUSIC_U=...`）。

**3. 导入**

```bash
node src/cli.ts login   # 一次性，浏览器点同意
node src/cli.ts sync <歌单>
```

歌单可以是数字 id、`music.163.com/#/playlist?id=...`、`y.music.163.com/...` 或 `163cn.tv/xxx` 短链。

## 命令

| 命令 | 说明 |
| --- | --- |
| `sync <歌单>` | 一条命令跑完：匹配 → 建歌单 → 写曲目 → 传封面 |
| `sync <歌单> --review` | 逐首确认（1-3 选候选，`s` 跳过，`q` 退出且不写入） |
| `sync <歌单> --update` | 原地更新上次同步的歌单，不堆重复 |
| `preview <歌单>` | 只匹配不写入，输出 `out/<歌单名>.csv` 和终端表格 |
| `show` / `export` | 只打印歌单 / 导出「歌名 - 歌手」文本 |
| `cover <歌单> --to <链接>` | 单独同步封面 |
| `login` / `whoami` / `doctor` | 授权 / 当前账号 / 自检 |

常用参数：`--include auto|review|all|none`（默认 `auto`）、`--choices x.csv`、`--name`、`--private`、`--limit N`、`--refresh`、`--refresh-match`、`--dry-run`、`--no-cover`。

## 匹配怎么做的

最多 6 次搜索逐步放宽（原名+艺人 → 去括号+别名艺人 → 去括号 → …），命中高分就提前停。

打分：标题 50% + 艺人 32% + 时长 15% + 专辑 3%，版本不符（Live / 伴奏 / Remix / Pt.2）每处 −0.10。

**≥0.82 且艺人相似度 ≥0.75** 才算 `auto`；0.5–0.82 进 `review` 等你确认；再低是 `missing`。宁可多一步复核，也不把翻唱当原唱。

中文场景三件事：`data/t2s.json` 繁简归一（坠/墜）、`data/artist-aliases.json` 艺人别名（林俊杰 → JJ Lin）、以及「标题一致 + 时长 ≤4s」兜底 —— 兜底只对**没有别名记录**的艺人生效。

## 二次同步

来源歌单和 Spotify 歌单的对应关系记在 `.cache/targets.json`。歌单更新后：

```bash
node src/cli.ts sync <歌单> --update          # 整表替换
node src/cli.ts sync <歌单> --refresh-match   # 顺便重新匹配
```

不加 `--update` 会新建一个歌单。

## 常见问题

| 症状 | 原因 / 处理 |
| --- | --- |
| `INVALID_CLIENT` | Redirect URI 和 `.env` 不一致，注意端口和结尾斜杠 |
| `403` | 账号没有 Premium，或 token 过期（删 `.cache/token.json` 重登） |
| 抓不到歌单 | 歌单是私密的：设为公开，或配置 `NETEASE_COOKIE` |
| 很多 `missing` | 该曲在你所在的区没上架。`--include review` 放宽，或 `export` 后用 TuneMyMusic（免费 500 首） |
| `429` | 配额限制，脚本会按 `Retry-After` 自动等待 |

## 没有 Premium

```bash
node src/cli.ts export <歌单>    # out/<歌单名>.txt，一行「歌名 - 歌手」
```

把文件内容粘到 TuneMyMusic / Soundiiz 的「任意文本」来源即可。以后升级了再回来跑 `sync`，匹配结果有缓存不用重来。

## 加一个来源

来源全部收在 `src/sources/`。实现 `MusicSource` 的 `canHandle` / `resolveId` / `fetchPlaylist`（可选 `coverSize`、`playlistUrl`），加进 `src/sources/index.ts` 的数组即可 —— 匹配、选曲、写入、封面、缓存都复用。接口定义见 [types.ts](src/sources/types.ts)，目前只实现了 `netease`。

## 开发

```bash
pnpm install   # 只装 typescript / @types/node 做类型检查
pnpm test      # 24 个用例
```

## 说明

网易云侧用的是网页端非公开接口，可能随官方改动失效；Spotify 侧是官方 Web API。仅供个人迁移自己的歌单。

[MIT License](LICENSE)
