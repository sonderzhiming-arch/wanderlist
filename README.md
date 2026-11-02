# Wanderlist · 旅行愿望清单

把刷视频时心动的目的地固化成一份份结构化档案：是谁安利的、当时为什么想去，
连同美景、人文、美食、当地照片与出发前的功课，用一个杂志风的静态网站展示。

基于 [Astro](https://astro.build) 构建，内容存放在 `src/content/places/` 的 Markdown 文件中，
无数据库、无后端，部署在 GitHub Pages。字体和地图库都随站点一起部署，不依赖外部 CDN。

## 本地开发

```bash
npm install
npm run dev      # http://localhost:4321/wanderlist/
npm run build    # 构建到 dist/
npm test         # 照片脚本的测试
```

## 部署到 GitHub Pages

1. 在 GitHub 新建名为 **wanderlist** 的仓库（若用其他名字，同步修改 `astro.config.mjs` 里的 `base`）；
2. 修改 `astro.config.mjs` 中 `site` 为 `https://<你的用户名>.github.io`；
3. 推送代码到 `main` 分支：

   ```bash
   git remote add origin git@github.com:<你的用户名>/wanderlist.git
   git push -u origin main
   ```

4. 仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**；
5. 之后每次 push 到 `main`，`.github/workflows/deploy.yml` 会自动构建并发布到
   `https://<你的用户名>.github.io/wanderlist/`。

## 添加新目的地（add-place skill）

skill 放在 `.claude/skills/add-place/`，在这个项目里打开 Claude Code 就能直接用。
发一条链接加一句理由即可，例如：

> https://www.bilibili.com/video/BVxxxx 冰岛的极光和黑沙滩，想去看一次

Claude 会自动抓取视频信息、调研签证/交通/季节、生成 Markdown 档案和配套 SVG 插画、
从维基共享资源挑几张当地照片放进相册，并以 `add: 地名` 的格式提交推送，触发自动部署。

也可以手动添加：参照 `src/content/places/altay.md` 的结构新建 `.md` 文件即可，
frontmatter schema 定义在 `src/content.config.ts`。

## 相册与照片

每个目的地可以有一组照片，显示在详情页的「相册」、首页卡片（悬停时露出第一张）、
地图弹窗和 `/photos/` 照片墙里，点开可以全屏左右翻看。

照片存放在 `src/content/places/photos/<slug>/`，在 md 的 frontmatter 里登记：

```yaml
photos:
  - src: ./photos/altay/01.jpg       # 相对 md 文件的路径
    caption: 喀纳斯湖的月亮湾         # 中文说明，也是图片的替代文本
    credit: 作者名                    # 以下三项是署名，网上找的照片必填，自己拍的可省略
    license: CC BY-SA 4.0
    sourceUrl: https://commons.wikimedia.org/wiki/File:...
```

构建时会校验文件是否存在，并自动生成多尺寸的 webp，原图不用自己压缩。
`scripts/photos.mjs` 负责找图和导入：

```bash
# 在维基共享资源搜索自由授权的当地照片（--preview 会下载小图到 .cache/ 方便挑选）
npm run photos -- search altay --q "Kanas Lake" --q "Hemu" --preview
# 下载选中的照片，压缩后存进相册，并自动写入署名
npm run photos -- add altay 3 7 12
# 导入自己拍的照片（会去掉 EXIF，包括 GPS 位置）
npm run photos -- import jiugongshan ~/Pictures/IMG_0001.jpg --caption "铜鼓包的风车"
```

维基共享资源上的照片都是 CC0 / 公有领域 / CC BY / CC BY-SA 等自由授权，可以放进公开仓库，但要按授权署名，
所以 `credit` / `license` / `sourceUrl` 不要删。在国内使用需要先开代理并设置 `https_proxy`，脚本会自动走代理。

## 目录结构

```
src/content/places/          目的地档案（Markdown，一地一文件）
src/content/places/photos/   相册照片（一地一个文件夹）
src/pages/index.astro        首页：卡片画廊 + 地区/状态筛选
src/pages/map.astro          地图页：Leaflet 世界地图打点
src/pages/photos.astro       相册页：按目的地分组的照片墙
src/pages/places/            详情页：杂志式排版
src/components/              相册拼图、全屏看图组件
public/illustrations/        手绘感 SVG 插画（一地一张）
scripts/photos.mjs           找图 / 导入照片的脚本
.claude/skills/add-place/    添加目的地的 Claude skill
```
