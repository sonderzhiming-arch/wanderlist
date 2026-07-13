# Wanderlist · 旅行愿望清单

把刷视频时心动的目的地固化成一份份结构化档案：是谁安利的、当时为什么想去，
连同美景、人文、美食与出发前的功课，用一个杂志风的静态网站展示。

基于 [Astro](https://astro.build) 构建，内容存放在 `src/content/places/` 的 Markdown 文件中，
无数据库、无后端，部署在 GitHub Pages。

## 本地开发

```bash
npm install
npm run dev      # http://localhost:4321/wanderlist/
npm run build    # 构建到 dist/
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

把 `skills/add-place/` 安装为 Claude Code skill（复制到项目 `.claude/skills/` 或个人 `~/.claude/skills/`），
之后在 Claude Code 里发一条链接加一句理由即可，例如：

> https://www.bilibili.com/video/BVxxxx 冰岛的极光和黑沙滩，想去看一次

Claude 会自动抓取视频信息、调研签证/交通/季节、生成 Markdown 档案和配套 SVG 插画，
并以 `add: 地名` 的格式提交推送，触发自动部署。

也可以手动添加：参照 `src/content/places/kyoto.md` 的结构新建 `.md` 文件即可，
frontmatter schema 定义在 `src/content.config.ts`。

## 目录结构

```
src/content/places/     目的地档案（Markdown，一地一文件）
src/pages/index.astro   首页：卡片画廊 + 地区/状态筛选
src/pages/map.astro     地图页：Leaflet 世界地图打点
src/pages/places/       详情页：杂志式排版
public/illustrations/   手绘感 SVG 插画（一地一张）
skills/add-place/       添加目的地的 Claude skill
```
