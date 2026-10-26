# 网易云音乐歌单 → Spotify

把网易云歌单里的一首首歌，一一定位到 Spotify 上的对应曲目，然后新建一个 Spotify 歌单。

和其他「导出文本 → 再粘贴到第三方网站」的方案不同，这里是**直接调用 Spotify Web API 建歌单**，匹配过程可复核、可修正、可重跑。

- 零运行时依赖（只用 Node 内置能力），Node ≥ 22.18 原生跑 TypeScript
- `sync` 一条命令跑完，也可以 `--review` 逐首确认后再写入
- Spotify 授权走 Authorization Code + PKCE，token 只存在本机 `.cache/`
- 二次同步原地更新同一歌单，不会堆重复；匹配结果有缓存，不重复烧 API 配额

## 前置条件

1. **Node ≥ 22.18**（用 `node -v` 确认）
2. **Spotify Premium 账号**。2026 年 2 月起，Spotify 把 Development Mode 的门槛改成：App 所有者必须有 Premium，否则 App 直接不可用（[官方公告](https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security)）。
3. 本机能访问 `api.spotify.com`、`accounts.spotify.com`（有代理也行，命令行能通就够）。

## 第一步：创建 Spotify App（约 3 分钟）

1. 打开 <https://developer.spotify.com/dashboard>，用你的 Spotify 账号登录
2. **Create app**，名字随便填（如 `netease-import`），Description 随便填
3. **Redirect URI 填 `http://127.0.0.1:8888/callback`**，勾选 `Web API`，保存
   - 这个地址必须和 `.env` 里的 `SPOTIFY_REDIRECT_URI` **完全一致**，否则授权会报 `INVALID_CLIENT: Invalid redirect URI`
4. 进入 App 的 **Settings**，复制 **Client ID** 和 **Client Secret**

> 同一个 App 自己用就够了；Development Mode 默认只有你一个授权用户，最多可加 5 个。

## 第二步：配置

```bash
cp .env.example .env
```

编辑 `.env`：

```ini
SPOTIFY_CLIENT_ID=你的 Client ID
SPOTIFY_CLIENT_SECRET=你的 Client Secret
SPOTIFY_REDIRECT_URI=http://127.0.0.1:8888/callback
```

只有迁移**私密歌单**时才需要 `NETEASE_COOKIE`：浏览器登录 music.163.com → 开发者工具 → Network → 任意请求的 Cookie 里复制整段（含 `MUSIC_U=...`）。

## 第三步：用起来

```bash
# 1. 授权（一次性，浏览器弹窗点同意，token 存到 .cache/token.json）
node src/cli.ts login

# 2. 一条命令跑完：抓取 → 匹配 → 建歌单 → 写曲目 → 传封面
node src/cli.ts sync "https://music.163.com/#/playlist?id=3778678"
```

`sync` 默认只导入匹配置信度高的（`status=auto`），其余列进报告跳过，不硬塞。封面走网易云图床的 `?param=640y640` 变体（转 base64 约 78KB，在 Spotify 256KB 上限内），`--no-cover` 可关闭。

### 想先看一眼 / 想逐首确认

```bash
# 只匹配不写入，生成 out/<歌单名>.csv 和终端表格
node src/cli.ts preview <歌单>

# 终端里逐首弹候选：回车=第 1 个，s=跳过，q=退出且不写入
node src/cli.ts sync <歌单> --review
```

### 二次同步

第一次 `sync` 会把「网易云歌单 → Spotify 歌单」记进 `.cache/targets.json`。之后歌单加了歌、或想换匹配算法重新对齐：

```bash
node src/cli.ts sync <歌单> --update          # 原地整表替换，不会堆出重复歌单
node src/cli.ts sync <歌单> --refresh-match   # 忽略缓存重新匹配
```

不加 `--update` 就新建一个歌单。

### 需要精修时：choices.csv

`--review` 覆盖日常场景；要批量改就写 choices 文件（`index` 是预览表格的序号，从 1 开始）：

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
| `show <歌单>` | 只打印网易云歌单 |
| `export <歌单>` | 导出 `歌名 - 歌手` 文本（TuneMyMusic 兜底） |
| `cover <歌单> --to <spotify>` | 单独同步封面 |
| `doctor` | 检查 `.env` / 授权 / 连通性 |

`--include` 控制导入范围：`auto`（默认）/ `review` / `all` / `none`。
其他参数：`--name`、`--description`、`--private`、`--limit N`、`--refresh`、`--refresh-match`、`--dry-run`、`--no-cover`。

歌单参数支持：数字 id、`music.163.com/#/playlist?id=...`、`y.music.163.com/...`、`163cn.tv/xxx` 短链。

## 匹配是怎么做的

每首歌最多发起 4 次 Spotify 搜索（逐步放宽）：

1. `track:"原名" artist:"第一艺人"`
2. `track:"去括号/feat 后的名字" artist:"第一艺人"`
3. `track:"去括号后的名字"`
4. `去括号后的名字 第一艺人`

候选打分：

| 维度 | 权重 | 说明 |
| --- | --- | --- |
| 标题相似度 | 50% | 归一化后按字符 bigram Dice 计算，中文友好 |
| 艺人相似度 | 32% | 逐个艺人比对，包含关系也算高分 |
| 时长接近度 | 15% | ±2s 满分，±5s / ±10s / ±15s 递减 |
| 专辑相似度 | 3% | 辅助信号 |
| 版本差异 | 扣分 | 一边是 Live / 伴奏 / Remix 而另一边不是，每处 −0.10 |

另外还有三层处理中文场景的机制：

1. **繁简归一**：`data/t2s.json` 是从 OpenCC 的 `TSCharacters` 抽出的 3200 字对照表。网易云用简体、Spotify 的中文目录常用繁体（坠/墜、郑润泽/鄭潤澤），不归一的话这类歌会直接判成 missing。
2. **艺人别名**：`data/artist-aliases.json` 收录常见的中英对应（林俊杰 → JJ Lin、蔡健雅 → Tanya Chua）。别名既用于搜索，也参与艺人相似度计算。
3. **中文补偿**：只有在我们**不知道**该艺人的罗马化写法时，才允许「标题几乎一致 + 时长误差 ≤4s」把分数抬到 0.86。已知别名的艺人必须靠艺人匹配本身拿分，否则就会把「愿与愁」的翻唱当成林俊杰原唱。

最终判定：

- `score ≥ 0.82` **且** `艺人相似度 ≥ 0.75`（或触发了中文补偿）→ `auto`
- `score ≥ 0.5` 但艺人证据不足 → `review`，必须人工过一眼
- 其余 → `missing`

宁可多一步复核，也不自动塞翻唱进歌单。

## 常见问题

**`INVALID_CLIENT: Invalid redirect URI`**
Dashboard 里的 Redirect URI 和 `.env` 不一致。注意结尾不要多斜杠，端口要对上。

**`403` / `This request requires a valid access token`**
token 过期或 App 换了 Client Secret。删掉 `.cache/token.json` 重新 `login`。

**歌单抓不到，提示私密**
在网易云里把歌单设为公开，或者配置 `NETEASE_COOKIE`。

**很多歌 `missing`**
大概率是这些歌在 Spotify 你所在的区没有上架（中文独立音乐尤其常见）。可以 `--include review` 把相近的也导进去，或者 `export` 出文本交给 TuneMyMusic / Soundiiz 再试一次。

**`429` 限流**
Development Mode 配额有限。脚本会自动按 `Retry-After` 等待；匹配结果有缓存，重跑不会重新搜索。

## 如果账号没有 Premium

Development Mode 的 App 必须由 Premium 账号持有，否则所有 API 调用直接 403（不是限流）。这时候有两条路：

1. **不折腾 API**：`node src/cli.ts export <歌单>` 会生成 `out/<歌单名>.txt`，一行一首「歌名 - 歌手」，直接粘到 TuneMyMusic / Soundiiz 的「任意文本」来源即可。TuneMyMusic 免费版单次 500 首，普通歌单够用。
2. **升级后再回来**：`login` → `preview` → `import`，匹配结果有缓存，不用重来。

先跑 `node src/cli.ts doctor`，它会明确告诉你是缺凭据、没登录、还是被 Premium 拦住。

## 加一个新的音乐源

来源相关的东西全部收在 `src/sources/`。实现 `MusicSource` 接口，再往 `src/sources/index.ts` 的数组里加一行，匹配、选曲、写入、封面、缓存这些都不用改。

| 需要实现 | 职责 |
| --- | --- |
| `canHandle(input)` | 判断链接或 id 是不是本来源的 |
| `resolveId(input)` | 短链跳转、从 URL 里取 id，返回稳定的字符串 id |
| `fetchPlaylist(input)` | 抓歌单元信息和**有序**曲目 |
| `coverSize(url, size)` | 封面按边长取变体的规则（可选，不实现就只用原图） |
| `playlistUrl(id)` | 还原原歌单地址，会写进 Spotify 歌单描述 |

只要交出 `SourceTrack { id, name, artists, album, durationMs }` 就够了。繁简归一、艺人别名、时长容差、置信度门槛这些都在通用层，新来源自动继承。

已经做到的复用：

```
sources/netease.ts   ─┐
（以后的 qq.ts）      ├─→ sources/index.ts ─→ 缓存
                     │
                     └─→ match.ts（打分）─→ sync.ts（选曲 + 写入 Spotify）
                                              │
                                          cover.ts（封面管线）
```

目前只实现了 `netease`。加 QQ 音乐时唯一要额外确认的是封面图床的缩放参数，其余照抄。

## 说明

- 网易云侧用的是网页端非公开接口，可能随官方改动失效；Spotify 侧是官方 Web API。
- 仅供个人迁移自己的歌单使用，别拿去做公开服务或批量分发。

## 目录

```
src/config.ts     .env 读取与路径
src/sources/      来源适配层（types.ts 接口 / netease.ts 实现 / index.ts 注册表）
src/cover.ts      封面下载、尺寸降级、JPEG 校验、base64 与 256KB 限制
src/spotify.ts    OAuth PKCE、API 封装、建歌单/加曲
src/match.ts      归一化、打分、匹配策略
src/report.ts     终端表格与 CSV
src/sync.ts       选曲计划与写入流程（建歌单/整表替换/封面）
src/state.ts      targets.json 状态、choices 解析
src/cli.ts        命令行入口
data/t2s.json     繁简对照表（来自 OpenCC TSCharacters，Apache-2.0）
data/artist-aliases.json  艺人中英别名，可自行往里加
test/             打分、选曲、来源、封面的单元测试（24 个）
```
