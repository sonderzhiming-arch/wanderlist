export const STATUS_META = {
  wishlist: { label: '想去', color: '#c9930f' },
  planning: { label: '计划中', color: '#1d6f66' },
  visited: { label: '已去过', color: '#5c6b4f' },
} as const;

export type Status = keyof typeof STATUS_META;

/** 2026-03-18 -> 「2026 年 3 月 18 日」（frontmatter 日期按 UTC 解析，故取 UTC 分量） */
export function formatDate(d: Date): string {
  return `${d.getUTCFullYear()} 年 ${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日`;
}

/** 给 public/ 下的资源路径加上部署 base 前缀 */
export function withBase(path: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/+$/, '');
  return `${base}/${path.replace(/^\/+/, '')}`;
}
