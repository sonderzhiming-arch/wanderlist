---
name: add-place
description: >
  向 Wanderlist 旅行愿望清单添加新目的地。当用户发来一条链接（B 站视频为主，也可能是小红书等）
  加一句「想去的理由」时触发：抓取链接信息、联网调研目的地、按 schema 生成 Markdown 档案、
  绘制配套 SVG 插画、从维基共享资源配上当地照片，并 git 提交推送。也用于给已有目的地补照片或
  导入用户自己拍的照片（「给阿勒泰加几张照片」「把我拍的照片放进去」）。Use when the user sends a URL
  plus a short reason for wanting to visit a place, or says 加一个地方 / 添加目的地 / add place / 加照片.
---

# add-place：添加新目的地

## 触发条件

用户消息同时包含：

1. 一条链接（`bilibili.com` / `b23.tv` 为主，也可能是小红书、公众号等），**或**直接说出地名并注明来源（如「朋友推荐的」）；
2. 一句想去的理由（如「看到岚山竹林的视频，想在秋天去看红叶」）。

也可由用户显式触发：「加一个地方」「把这个存进愿望清单」等。
只想给已有目的地加照片时，直接看文末「给已有目的地补照片」。

## 工作流程

### 第 1 步：抓取来源信息

- B 站链接：抓取页面的 og meta 标签（`og:title`、`og:image`），`b23.tv` 短链先跟随重定向。
  可用 `curl -sL -A "Mozilla/5.0" <url> | grep -o '<meta[^>]*og:[^>]*>'` 提取。
- 抓取失败或标题看不出目的地时，**向用户询问**视频主题 / 目的地是哪里，不要猜。
- 从标题和用户的话中确定目的地名称。若一条视频涉及多个地方，问清楚要收录哪一个。

### 第 2 步：联网调研

用 WebSearch 核实以下信息（**签证政策必须搜索当年最新政策**，不确定处在正文标注「以官方最新政策为准」）：

- 美景：3–5 个代表性景观，附简短语境（不要景点罗列体）；
- 人文：历史、文化、街区、节庆；
- 美食：4–6 种当地食物，用列表 + 加粗名称的格式；
- 签证：对**中国普通护照**的签证类型（免签 / 落地签 / 电子签 / 需办签证 / 国内无需）、停留天数、入境卡等要求；
- 交通：**从杭州出发**的方案（有无直飞、常见中转、大致时长）；
- 最佳旅行季节；
- 经纬度坐标（城市中心即可，保留 4 位小数）；
- 目的地的**英文名**和 2–3 个代表性景点的中英文名（第 5 步搜照片用）。

### 第 3 步：生成 Markdown 档案

写入 `src/content/places/<英文或拼音小写-连字符>.md`（如 `chiang-mai.md`、`kashgar.md`），文件名即页面 slug。

Frontmatter schema（见 `src/content.config.ts`，全部必填除非标注可选）：

```yaml
---
title: 地名                    # 如「京都」
country: 国家                  # 国内目的地写「中国」
region: 大区                   # 东亚/东南亚/南亚/中亚/中东/欧洲/北美/南美/非洲/大洋洲/国内
coordinates: [纬度, 经度]      # [lat, lng]，数字
addedDate: YYYY-MM-DD          # 当天日期，不加引号
sourceUrl: 来源链接            # 完整 URL
sourcePlatform: bilibili       # bilibili/小红书/朋友推荐/其他
motivation: 用户原话           # 一字不改地保留用户说的理由，这是最重要的字段
status: wishlist               # 新记录一律 wishlist
visaType: 签证类型             # 免签/落地签/电子签/需办签证/国内无需
bestSeason: 最佳季节           # 如「11 月中下旬红叶季」
coverImage: 路径               # 可选；相对 public/ 的路径，不带 base 前缀
illustration: illustrations/<slug>.svg   # 第 4 步生成的插画路径
# photos: 相册，可选。由第 5 步的脚本自动写入，不要手写网上的照片
---
```

正文用固定的四个二级标题组织（顺序固定，标题一字不差）：

```markdown
## 美景
（2–3 段散文，写出画面感）

## 人文
（2–3 段：历史脉络 + 当下的生活气息）

## 美食
（列表，每项「**名称**：一句话介绍」）

## 出发前 checklist
（列表，从杭州出发视角，依次覆盖：护照/证件、签证、交通、预算、其他提醒。
政策类信息注明「以官方最新政策为准」）
```

注意：详情页会把「出发前 checklist」一节抽到侧栏展示，其余节留在主栏，
所以 checklist 标题必须包含 `checklist` 字样。

### 第 4 步：生成 SVG 插画

在 `public/illustrations/<slug>.svg` 创建插画，风格必须与现有插画一致（先打开 `altay.svg`、`huizhou.svg`、`greenland.svg` 看一眼）：

- `viewBox="0 0 800 500"`，根元素带 `role="img"` 和中文 `aria-label`（如「阿勒泰：禾木木屋、雪山与白桦插画」）；
- 配色固定三色：底色 `#f6efe2`（米色矩形铺满）、主线条 `#9c4a2f`（赭红）、点缀 `#d9a441`（暖金）；
- 手绘线稿风：`stroke-width` 4–7，`stroke-linecap="round"`、`stroke-linejoin="round"`，曲线用 Q/C 制造轻微不规则感；
- 构图公式：**一个标志性地标的线稿剪影**（居中或略偏，占画面主体）+ 远景线（山脉/地平线，透明度 0.35）+ 地面双线（一实一虚 `stroke-dasharray="2 18"`）+ 一个暖金色的「太阳位」元素（可以玩梗，比如用馕、月饼当太阳）+ 1–2 个当地风物小元素；
- 只用线稿 + 少量暖金色块填充，不要渐变、不要写实、不要文字。

### 第 5 步：配照片（相册）

照片来自[维基共享资源](https://commons.wikimedia.org)（Wikimedia Commons）：那里只收自由授权的作品，可以合法放进公开仓库，
但必须署名。`scripts/photos.mjs` 负责搜索、下载、压缩和写入 frontmatter（含作者、授权、原图链接），网站会自动展示署名。

1. **搜索候选**（关键词越具体越好，英文名通常结果更多）：

   ```bash
   npm run photos -- search <slug> --q "<英文名>" --q "<景点英文名>" --q "<景点中文名>" --preview
   ```

   脚本默认还会用 frontmatter 的 `title` 搜索，并在 `coordinates` 周边 10 公里内做地理搜索；
   已自动排除非自由授权、太小、全景长条图和地图/图标类结果。
   维基媒体对共享出口 IP 限流很严，脚本会按要求自动等待重试，整个搜索可能要几分钟，
   在 Claude Code 里建议用后台运行，等它跑完再继续；不要并行开多个搜索。
2. **看预览图再挑**：`--preview` 会把前 24 个候选的小图下载到 `.cache/photos/<slug>/preview/`，
   并拼一张带编号的总览图 `.cache/photos/<slug>/contact.jpg`。**先用 Read 看这张总览图**，
   拿不准的再打开对应编号的单张预览。挑 4–6 张：
   - 确实是这个地方（不是同名的别处、不是别的城市）；
   - 画面清楚、构图好看，优先横图；
   - 尽量覆盖不同主题：标志性风景、街巷/人文、季节特色，有合适的再加一张美食；
   - 不要：同一角度的重复照片、黑白老照片、文物/标本特写、大幅水印或文字、以可辨认的路人为主体的照片。
3. **写入**：

   ```bash
   npm run photos -- add <slug> <编号> <编号> ...
   ```

   也可以直接给 `File:文件名` 或 Commons 文件页链接。照片会以 `01.jpg`、`02.jpg`… 存进
   `src/content/places/photos/<slug>/`（长边 1600px 的 JPEG），条目追加到 frontmatter 的 `photos` 列表末尾。
   列表第一张会作为分享卡片图和地图弹窗里的缩略图，挑最有代表性的放第一个。
4. **改说明**：把每条 `caption` 改成简洁的中文（≤ 20 字，写清楚是哪儿、什么场景，如「禾木村的清晨炊烟」）。
   `credit` / `license` / `sourceUrl` 是署名信息，**不要改也不要删**。
5. **找不到合适的就少放或不放**。不要用来源不明、没有自由授权的图片，也不要外链别的网站的图片。
   网络不通时（脚本会提示：国内需开代理并设置 `https_proxy`；Claude 云端环境需在环境网络设置里放行
   `commons.wikimedia.org` 与 `upload.wikimedia.org`），跳过这一步并告诉用户，不影响收录。

### 第 6 步：提交

```bash
git add src/content/places/<slug>.md src/content/places/photos/<slug> public/illustrations/<slug>.svg
git commit -m "add: <地名>"
git push
```

推送前先 `npm run build` 确认无报错（schema 校验失败、照片路径写错都会在 build 时暴露）。
没配照片时 `git add` 去掉 photos 那一项。push 失败（如无网络/无权限）时告知用户，不要重试超过一次。

## 完成后回复用户

用一两句话总结：收录了哪里、签证结论、最佳季节、配了几张照片（没配上的话说明原因），并提醒 push 后 GitHub Actions 会自动部署。

## 给已有目的地补照片

- **网上的照片**：照第 5 步做即可，脚本会跳过已经加过的照片。
- **用户自己拍的照片**：

  ```bash
  npm run photos -- import <slug> <图片路径>... --caption "说明"
  ```

  会自动按 EXIF 摆正方向、缩到长边 1600px、转成 JPEG，并**去掉 EXIF（包括 GPS 位置）**，避免公开仓库泄露拍摄地点。
  一次导入多张时 `--caption` 会用在每一张上，导入后逐条改成各自的说明；自己拍的照片不用填 credit / license。
  iPhone 的 HEIC 格式读不了，先转成 JPEG（Mac：`sips -s format jpeg 输入.HEIC --out 输出.jpg`）。
- 提交信息用 `photos: <地名>`，同样先 `npm run build` 再推送。
