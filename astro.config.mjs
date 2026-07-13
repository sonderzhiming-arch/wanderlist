// @ts-check
import { defineConfig } from 'astro/config';

// 部署到 GitHub Pages：仓库名为 wanderlist
// 把 site 中的 <你的GitHub用户名> 替换成自己的用户名即可
export default defineConfig({
  site: 'https://sonder-zhiming.github.io',
  base: '/wanderlist',
});
