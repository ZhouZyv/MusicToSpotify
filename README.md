# 网易云音乐歌单 → Spotify

![Node](https://img.shields.io/badge/Node-%E2%89%A522.18-339933?logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue)
![Dependencies](https://img.shields.io/badge/runtime%20deps-0-brightgreen)

把网易云歌单里的歌，一一定位到 Spotify 上的对应曲目，然后建一个 Spotify 歌单 —— 曲目顺序、歌单封面都保留。

```
网易云歌单 ──→ 抓取 ──→ 逐首匹配 ──→ 选曲计划 ──→ Spotify 歌单
              │           │              │            │
           trackIds    标题/艺人/时长   评分阈值      曲目 + 封面
           补全         + 繁简 + 别名   人工复核
```

和其他「导出文本 → 再粘贴到第三方网站」的方案不同，这里**直接调用 Spotify Web API 建歌单**：曲目不会被第三方服务器经手，匹配过程可复核、可修正、可重跑。

- 零运行时依赖，Node ≥ 22.18 直接用原生 TypeScript 跑
- `sync` 一条命令跑完，也可以 `--review` 在终端逐首确认
- 二次同步原地更新同一歌单，不会堆出重复；匹配结果有缓存，不重复烧 API 配额
- 来源做成适配层，目前只实现网易云（见[加一个新的音乐源](#加一个新的音乐源)）

## 前置条件

1. **Node ≥ 22.18**（`node -v` 确认，低版本不支持直接运行 `.ts`）
2. **Spotify Premium 账号**。2026 年 2 月起，Spotify 把 Development Mode 的门槛改成「App 所有者必须有 Premium」，否则 API 一律 403（[官方公告](https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security)）
3. 本机能访问 `api.spotify.com`、`accounts.spotify.com`（走代理也行，命令行通就够）

## 快速开始

### 1. 创建 Spotify App（约 3 分钟）

1. 打开 <https://developer.spotify.com/dashboard> 登录
2. **Create app**，名字随便填（如 `netease-import`）
3. **Redirect URI 填 `http://127.0.0.1:8888/callback`**，勾选 `Web API` 后保存
   - 必须和 `.env` 里的 `SPOTIFY_REDIRECT_URI` **完全一致**，否则授权报 `INVALID_CLIENT: Invalid redirect URI`
4. 进入 **Settings**，复制 **Client ID** 和 **Client Secret**

> 自己用建一个就够。Development Mode 默认只有你一个授权用户，最多可加 5 个。

### 2. 配置

```bash
cp .env.example .env
```

```ini
SPOTIFY_CLIENT_ID=你的 Client ID
SPOTIFY_CLIENT_SECRET=你的 Client Secret
SPOTIFY_REDIRECT_URI=http://127.0.0.1:8888/callback
```

只有迁移**私密歌单**才需要 `NETEASE_COOKIE`：浏览器登录 music.163.com → 开发者工具 → Network → 任意请求的 Cookie 里复制整段（含 `MUSIC_U=...`）。

### 3. 导入

```bash
# 授权（一次性，浏览器点同意，token 存到 .cache/token.json）
node src/cli.ts login

# 一条命令跑完：抓取 → 匹配 → 建歌单 → 写曲目 → 传封面
node src/cli.ts sync "https://music.163.com/#/playlist?id=3778678"
```

`sync` 默认只导入置信度高的（`status=auto`），其余列进报告跳过，不硬塞。

歌单参数支持：数字 id、`music.163.com/#/playlist?id=...`、`y.music.163.com/...`、`163cn.tv/xxx` 短链。

## 常用操作

### 先看看匹配得怎么样

```bash
# 只匹配不写入：终端表格 + out/<歌单名>.csv
node src/cli.ts preview <歌单>
```

终端会按 `✅ auto / ⚠️ review / ❌ missing` 分三档打表，末尾单独列出待确认曲目的前 3 个候选。

### 逐首确认再导入

```bash
node src/cli.ts sync <歌单> --review
```

每首待确认的曲目会列出候选，输入 `1`~`3` 选第几个，回车取第 1 个，`s` 跳过，`q` 退出且不写入。

### 二次同步

第一次 `sync` 会把「来源歌单 → Spotify 歌单」的对应关系记进 `.cache/targets.json`。之后歌单加了歌、或者换匹配算法想重新对齐：

```bash
node src/cli.ts sync <歌单> --update          # 原地整表替换，不会堆重复
node src/cli.ts sync <歌单> --refresh-match   # 忽略缓存重新匹配
```

不加 `--update` 就新建一个歌单。

### 批量精修：choices.csv

`--review` 覆盖日常场景；要批量改就写 choices 文件（`index` 是预览表格里的序号，从 1 开始）：

```csv
index,action
7,spotify:track:4iV5W9uYEdYUVa79Axb7Rh
9,skip
12,https://open.spotify.com/track/1301WleyT98MSxVHPZCA6M
```

`action` 支持 Spotify URI / 链接 / 22 位 track id / `skip`，优先级高于 `--include`：

```bash
node src/cli.ts sync <歌单> --choices choices.csv --include none --name "歌单名（补漏）"
```

## 命令一览

| 命令 | 作用 |
| --- | --- |
| `login` / `whoami` | 授权 / 查看当前 Spotify 账号 |
| `sync <歌单>` | 一条命令跑完导入（建歌单 + 写曲目 + 传封面） |
| `sync <歌单> --review` | 逐首确认后再导入 |
| `sync <歌单> --update` | 原地更新已有歌单（整表替换） |
| `preview <歌单>` | 只匹配、写 CSV，不写 Spotify |
| `show <歌单>` | 只打印来源歌单内容 |
| `export <歌单>` | 导出 `歌名 - 歌手` 文本（TuneMyMusic 兜底） |
| `cover <歌单> --to <spotify>` | 单独同步封面 |
| `doctor` | 检查 `.env` / 授权 / 连通性 |

| 参数 | 说明 |
| --- | --- |
| `--include auto\|review\|all\|none` | 导入范围，默认 `auto` |
| `--choices file.csv` | 按序号指定 uri / skip |
| `--name` / `--description` | 歌单名与描述 |
| `--private` | 建为私密歌单 |
| `--update` / `--to <歌单>` | 更新已有歌单 |
| `--limit N` | 只处理前 N 首 |
| `--refresh` / `--refresh-match` | 重抓来源 / 重新匹配 |
| `--source <id>` | 指定来源，目前只有 `netease` |
| `--dry-run` / `--no-cover` | 只打印 / 不传封面 |

## 匹配是怎么做的

每首歌最多发起 6 次 Spotify 搜索，逐步放宽，命中高分就提前停止：

1. `track:"原名" artist:"第一艺人"`
2. `track:"去括号名字" artist:"别名"` ← 别名表里的罗马化写法，有几个别名发几次
3. `track:"去括号名字" artist:"第一艺人"`
4. `track:"去括号名字"`
5. `去括号名字 第一艺人`

候选打分：

| 维度 | 权重 | 说明 |
| --- | --- | --- |
| 标题相似度 | 50% | 归一化后按字符 bigram Dice 计算，中文友好 |
| 艺人相似度 | 32% | 逐个艺人 + 别名比对，包含关系也算高分 |
| 时长接近度 | 15% | ±2s 满分，±5s / ±10s / ±15s 递减 |
| 专辑相似度 | 3% | 辅助信号 |
| 版本差异 | 扣分 | 一边是 Live / 伴奏 / Remix / Pt.2 而另一边不是，每处 −0.10，最多扣 0.20 |

三层中文场景处理：

1. **繁简归一**：`data/t2s.json` 是从 OpenCC `TSCharacters` 抽的 3221 字对照表。网易云用简体、Spotify 的中文目录常用繁体（坠/墜、郑润泽/鄭潤澤），不归一这类歌会直接判成 `missing`
2. **艺人别名**：`data/artist-aliases.json` 收录常见中英对应（林俊杰 → JJ Lin、蔡健雅 → Tanya Chua），既用于搜索也参与相似度
3. **中文补偿**：只有在我们**不知道**该艺人罗马化写法时，才允许「标题几乎一致 + 时长误差 ≤4s」把分数抬到 0.86。已知别名必须靠艺人本身拿分，否则会把《愿与愁》的翻唱认成林俊杰原唱

最终判定：

- `score ≥ 0.82` **且** `艺人相似度 ≥ 0.75`（或触发中文补偿）→ `auto`
- `score ≥ 0.5` 但艺人证据不足 → `review`，人工过一眼
- 其余 → `missing`

宁可多一步复核，也不自动把翻唱塞进歌单。

## 产物与缓存

| 路径 | 内容 |
| --- | --- |
| `out/<歌单名>.csv` | `preview` 的完整匹配表：分数、候选、Spotify 链接 |
| `out/<歌单名>.imported.csv` | `sync` 实际导入了哪些、来自自动匹配还是人工指定 |
| `out/<歌单名>.txt` | `export` 的「歌名 - 歌手」纯文本 |
| `.cache/<来源>/<id>.json` | 抓到的歌单快照 |
| `.cache/matches/<id>.json` | 匹配结果，重跑不重新搜索 |
| `.cache/targets.json` | 来源歌单 → Spotify 歌单 的映射 |
| `.cache/token.json` | OAuth token（文件权限 0600） |

`.cache/`、`out/`、`.env` 都在 `.gitignore` 里。

## 加一个新的音乐源

来源相关的东西全部收在 `src/sources/`。实现 `MusicSource` 接口，往 `src/sources/index.ts` 的数组里加一行即可，匹配、选曲、写入、封面、缓存都不用改。

| 需要实现 | 职责 |
| --- | --- |
| `canHandle(input)` | 判断链接或 id 是不是本来源的 |
| `resolveId(input)` | 短链跳转、从 URL 取 id，返回稳定的字符串 id |
| `fetchPlaylist(input)` | 抓歌单元信息和**有序**曲目 |
| `coverSize(url, size)` | 封面按边长取变体的规则（可选，不实现就只用原图） |
| `playlistUrl(id)` | 还原原歌单地址，会写进 Spotify 歌单描述 |

只要交出 `SourceTrack { id, name, artists, album, durationMs }`。繁简归一、艺人别名、时长容差、置信度门槛都在通用层，新来源自动继承。

```
sources/netease.ts   ─┐
（以后的 qq.ts）      ├─→ sources/index.ts ─→ 缓存
                     │
                     └─→ match.ts（打分）─→ sync.ts（选曲 + 写入 Spotify）
                                              │
                                          cover.ts（封面管线）
```

加 QQ 音乐时唯一要额外确认的是封面图床的缩放参数，其余照抄。

## 常见问题

**`INVALID_CLIENT: Invalid redirect URI`**
Dashboard 里的 Redirect URI 和 `.env` 不一致。注意结尾别多斜杠，端口要对上。

**`403` / `This request requires a valid access token`**
token 过期，或 App 换了 Client Secret。删掉 `.cache/token.json` 重新 `login`。

**歌单抓不到，提示私密**
在网易云里把歌单设为公开，或者配置 `NETEASE_COOKIE`。

**很多歌 `missing`**
大概率是这些歌在你所在的区没上架（中文独立音乐尤其常见）。可以 `--include review` 把相近的也导进去，或者 `export` 出文本交给 TuneMyMusic / Soundiiz 再试一次。

**重复跑会不会建出一堆歌单**
不会。`sync` 默认新建，但会提示这个歌单已经同步过；加 `--update` 就是原地整表替换。

**`429` 限流**
Development Mode 配额有限。脚本会按 `Retry-After` 等待；匹配结果有缓存，重跑不会重新搜索。

## 如果账号没有 Premium

Development Mode 的 App 必须由 Premium 账号持有，否则所有 API 调用直接 403（不是限流）。两条路：

1. **不折腾 API**：`node src/cli.ts export <歌单>` 生成 `out/<歌单名>.txt`，一行一首「歌名 - 歌手」，粘到 TuneMyMusic / Soundiiz 的「任意文本」来源即可。TuneMyMusic 免费版单次 500 首
2. **升级后再回来**：`login` → `sync`，匹配结果有缓存，不用重来

先跑 `node src/cli.ts doctor`，它会明确告诉你是缺凭据、没登录、还是被 Premium 拦住。

## 开发

```bash
pnpm install            # 只装 typescript 和 @types/node，用于类型检查
pnpm test               # node --test，24 个用例
pnpm typecheck          # tsc --noEmit
```

运行时不依赖任何包：代码里只用 `node:fs` / `node:http` / `node:crypto` / 全局 `fetch`，Node 22.18+ 直接执行 `.ts`（type stripping），没有构建步骤。

## 说明

- 网易云侧用的是网页端非公开接口，可能随官方改动失效；Spotify 侧是官方 Web API
- 仅供个人迁移自己的歌单，别拿去做公开服务或批量分发
- 封面版权归原权利人，这里只是原样搬运

## 目录

```
src/config.ts     .env 读取与路径
src/sources/      来源适配层（types.ts 接口 / netease.ts 实现 / index.ts 注册表）
src/cover.ts      封面下载、尺寸降级、JPEG 校验、base64 与 256KB 限制
src/spotify.ts    OAuth PKCE、API 封装、建歌单/加曲/换封面
src/match.ts      归一化、打分、匹配策略
src/report.ts     终端表格与 CSV
src/sync.ts       选曲计划与写入流程（建歌单/整表替换/封面）
src/state.ts      targets.json 状态、choices 解析
src/cli.ts        命令行入口
data/t2s.json     繁简对照表（来自 OpenCC TSCharacters，Apache-2.0）
data/artist-aliases.json  艺人中英别名，可自行往里加
test/             打分、选曲、来源、封面的单元测试（24 个）
```

## License

[MIT](LICENSE)
