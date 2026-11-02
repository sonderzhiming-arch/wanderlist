#!/usr/bin/env node
/**
 * Wanderlist 照片工具
 *
 * 从维基共享资源（Wikimedia Commons）搜索并下载自由授权的当地照片，或导入自己拍的照片；
 * 统一压缩成 JPEG 存进 src/content/places/photos/<slug>/，并把条目追加到 <slug>.md 的 photos 字段。
 *
 *   npm run photos -- search <slug> [--q 关键词]... [--radius 公里] [--limit 条数] [--no-geo] [--preview]
 *   npm run photos -- add <slug> <候选编号 | File:标题 | Commons 链接>...
 *   npm run photos -- import <slug> <本地图片>... [--caption 说明]
 *
 * 维基共享资源只收自由授权的作品（CC0 / 公有领域 / CC BY / CC BY-SA），可以合法放进公开仓库，
 * 但必须署名：add 会自动记下作者、授权和原图链接，网站上会显示出来。
 * 只用 Node 内置模块 + sharp（Astro 自带的图片库），设置了 https_proxy 时会自动走代理。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLACES_DIR = path.join(ROOT, 'src/content/places');
const CACHE_DIR = path.join(ROOT, '.cache/photos');

const API = 'https://commons.wikimedia.org/w/api.php';
// 维基媒体要求带上能识别来源、附联系方式的 User-Agent，格式见其 User-Agent Policy：
// 名称/版本 (联系方式) 所用库/版本。合规的 User-Agent 限速宽松得多
const USER_AGENT = `WanderlistPhotos/1.1 (https://github.com/sonderzhiming-arch/wanderlist) Node.js/${process.versions.node}`;
/** 被限流（429）或服务繁忙（503）时最多重试几次；等待时间按服务器给的 Retry-After */
const MAX_RETRIES = 5;
/** 没有 Retry-After 时指数退避的起始秒数（测试里设为 0） */
const BACKOFF_BASE = Number(process.env.PHOTOS_BACKOFF_BASE ?? 5);
/** 下载用的缩略图宽度：1280 是维基媒体的标准缩略图档位之一 */
const DOWNLOAD_WIDTH = 1280;
const PREVIEW_WIDTH = 330;
/** 最多下载多少张预览图（图片服务器限流较严，候选靠后的一般也用不上） */
const PREVIEW_MAX = 24;
/** 存进仓库的照片最长边，以及 JPEG 质量 */
const MAX_EDGE = 1600;
const JPEG_QUALITY = 82;

const ACCEPTED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MIN_WIDTH = 1000;
const MIN_HEIGHT = 600;
/** 标题里出现这些词的多半不是风景照 */
const NON_PHOTO =
  /\b(map|karte|carte|mapa|locator|location|logo|flag|coat of arms|emblem|seal|diagram|chart|graph|plan|scheme|icon|stamp|banknote|coin|poster|document|signature|screenshot|sketch|drawing)\b|地图|位置图|示意图|标志|徽章|旗/i;

export class UserError extends Error {}

// ---------------------------------------------------------------------------
// 纯函数（有单元测试）
// ---------------------------------------------------------------------------

/** 去掉 HTML 标签、解码常见实体、合并空白 */
export function stripHtml(html = '') {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(html)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (m, code) => {
      if (code[0] !== '#') return named[code.toLowerCase()] ?? m;
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    })
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '') // 零宽字符（Commons 的描述里常见）
    .replace(/\s+/g, ' ')
    .trim();
}

/** 是否为可以放进公开网站的自由授权（排除 NC / ND 以及只有 GFDL 的） */
export function isFreeLicense(name = '') {
  const n = String(name).trim();
  if (!n) return false;
  if (/\bNC\b|\bND\b|non-?commercial|no-?deriv/i.test(n)) return false;
  return /^(CC0|CC[- ]BY\b|CC[- ]BY-SA\b|Public domain|PD\b|PD-|Attribution|Copyrighted free use|FAL\b|Free Art)/i.test(n);
}

/** 把 Commons API 返回的一页（formatversion=2）整理成候选照片 */
export function toCandidate(page) {
  const info = page?.imageinfo?.[0];
  if (!info) return null;
  const meta = info.extmetadata ?? {};
  const value = (key) => stripHtml(meta[key]?.value ?? '');
  return {
    title: page.title,
    pageUrl: info.descriptionurl ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`,
    width: info.width ?? 0,
    height: info.height ?? 0,
    mime: info.mime ?? '',
    url: info.thumburl ?? info.url,
    license: value('LicenseShortName'),
    artist: value('Artist').slice(0, 80),
    description: value('ImageDescription'),
    /** 周边搜索时离目的地坐标的距离（米） */
    distance: page.coordinates?.[0]?.dist ?? null,
    /** 排序依据：关键词搜索用相关度名次，周边搜索用距离 */
    index: page.index ?? page.coordinates?.[0]?.dist ?? Number.MAX_SAFE_INTEGER,
  };
}

/** 比较两个 File: 标题（忽略下划线/空格差异和首字母大小写） */
export function sameTitle(a, b) {
  const norm = (t) => {
    const s = String(t).replace(/_/g, ' ').trim().replace(/^file:\s*/i, '');
    return s.charAt(0).toUpperCase() + s.slice(1);
  };
  return norm(a) === norm(b);
}

/** 不适合用的原因；可以用时返回 null */
export function rejectReason(c) {
  if (!ACCEPTED_MIME.has(c.mime)) return `格式 ${c.mime || '未知'}`;
  if (!isFreeLicense(c.license)) return `授权 ${c.license || '未知'}`;
  if (c.width < MIN_WIDTH || c.height < MIN_HEIGHT) return `尺寸 ${c.width}×${c.height} 太小`;
  const ratio = c.width / c.height;
  if (ratio > 2.6 || ratio < 0.55) return '比例太极端（全景/长条图）';
  if (NON_PHOTO.test(c.title.replace(/[_-]/g, ' '))) return '像是地图/图标/文档';
  if (/^File:Mapillary\b/i.test(c.title)) return '街景车自动拍摄';
  return null;
}

/**
 * 合并多次查询的结果：每批先按名次/距离排序，再轮流从各批取一张并去重，
 * 这样候选数量有上限时，每个关键词和周边搜索都能分到名额
 */
export function mergeCandidates(batches) {
  const sorted = batches.map((batch) => [...batch].filter(Boolean).sort((a, b) => a.index - b.index));
  const seen = new Set();
  const out = [];
  const longest = Math.max(0, ...sorted.map((b) => b.length));
  for (let i = 0; i < longest; i++) {
    for (const batch of sorted) {
      const c = batch[i];
      if (!c || seen.has(c.title)) continue;
      seen.add(c.title);
      out.push(c);
    }
  }
  return out;
}

/** 默认说明：取 Commons 上的描述，没有就用文件名；之后应改成简短的中文 */
export function defaultCaption(c) {
  const text = c.description || c.title.replace(/^File:/i, '').replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' ');
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

/** YAML 标量：安全时写成裸字符串（和现有 frontmatter 风格一致），否则用双引号 */
export function yamlString(value) {
  const s = String(value);
  const unsafe =
    s === '' ||
    /^[\s'"\-?:,[\]{}#&*!|>%@`]/.test(s) ||
    /\s$/.test(s) ||
    /: |:$| #|[\n\r\t]/.test(s) ||
    /^(true|false|yes|no|on|off|null|~|[-+]?\d[\d_]*(\.\d*)?([eE][-+]?\d+)?|[-+]?\.\d+)$/i.test(s);
  return unsafe ? JSON.stringify(s) : s;
}

function entryLines(entry, indent) {
  const pad = `${indent}  `;
  const lines = [`${indent}- src: ${yamlString(entry.src)}`, `${pad}caption: ${yamlString(entry.caption)}`];
  for (const key of ['credit', 'license', 'sourceUrl']) {
    if (entry[key]) lines.push(`${pad}${key}: ${yamlString(entry[key])}`);
  }
  return lines;
}

/** 在 frontmatter 的 photos 列表末尾追加条目（没有 photos 字段就新建在末尾），其余内容原样保留 */
export function insertPhotos(markdown, entries) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/);
  if (!match) throw new UserError('没找到 frontmatter（文件开头的 --- 块）');
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n';
  const lines = match[1].split(/\r?\n/);
  const at = lines.findIndex((l) => /^photos\s*:/.test(l));

  if (at === -1) {
    lines.push('photos:', ...entries.flatMap((e) => entryLines(e, '  ')));
  } else {
    if (/^photos\s*:\s*\[\s*\]\s*(#.*)?$/.test(lines[at])) lines[at] = 'photos:';
    else if (!/^photos\s*:\s*(#.*)?$/.test(lines[at])) {
      throw new UserError('photos 字段不是常见的列表写法，没法自动追加，请手动编辑');
    }
    let end = at + 1;
    while (end < lines.length && (/^[\s-]/.test(lines[end]) || lines[end].trim() === '')) end++;
    while (end > at + 1 && lines[end - 1].trim() === '') end--;
    const firstItem = lines.slice(at + 1, end).find((l) => /^\s*-\s/.test(l));
    const indent = firstItem ? firstItem.match(/^(\s*)-/)[1] : '  ';
    lines.splice(end, 0, ...entries.flatMap((e) => entryLines(e, indent)));
  }

  return `---${eol}${lines.join(eol)}${eol}---${markdown.slice(match[0].length)}`;
}

/** 读出 frontmatter 里已登记的原图链接，避免重复添加 */
export function existingSources(markdown) {
  const fm = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
  // 只认列表项里（有缩进）的 sourceUrl，顶层的 sourceUrl 是来源视频链接
  return new Set([...fm.matchAll(/^[ \t]+sourceUrl:[ \t]*["']?([^"'\s]+)/gm)].map((m) => m[1]));
}

/** Commons 链接 / File:标题 → 标准标题 */
export function toFileTitle(ref) {
  let title = String(ref).trim();
  const fromUrl = title.match(/commons\.wikimedia\.org\/wiki\/(File:[^?#]+)/i);
  if (fromUrl) title = decodeURIComponent(fromUrl[1]);
  if (!/^File:/i.test(title)) return null;
  return `File:${title.slice(5).replace(/_/g, ' ').trim()}`;
}

/** 下一个文件编号：01、02…（按目录里已有的最大编号递增） */
export function nextNumber(fileNames) {
  const used = fileNames.map((n) => parseInt(n, 10)).filter(Number.isFinite);
  return (used.length ? Math.max(...used) : 0) + 1;
}

// ---------------------------------------------------------------------------
// 读写目的地档案
// ---------------------------------------------------------------------------

async function readPlace(slug) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug ?? '')) {
    throw new UserError(`slug 应该是小写字母、数字和连字符，比如 altay、chiang-mai（收到：${slug ?? '空'}）`);
  }
  const file = path.join(PLACES_DIR, `${slug}.md`);
  if (!existsSync(file)) throw new UserError(`找不到 ${path.relative(ROOT, file)}，请先生成目的地档案`);
  const text = await readFile(file, 'utf8');
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
  const title = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m)?.[1];
  const coords = fm.match(/^coordinates:\s*\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]/m);
  return {
    slug,
    file,
    text,
    title: title ?? slug,
    coords: coords ? [Number(coords[1]), Number(coords[2])] : null,
    photoDir: path.join(PLACES_DIR, 'photos', slug),
  };
}

async function nextFileNumber(dir) {
  const names = existsSync(dir) ? await readdir(dir) : [];
  return nextNumber(names);
}

// ---------------------------------------------------------------------------
// 网络
// ---------------------------------------------------------------------------

function networkHint(error) {
  const code = error?.cause?.code ?? error?.cause?.name ?? error?.name ?? '';
  return new UserError(
    [
      `连不上维基共享资源（${code || error.message}）。`,
      '· 在国内：先开代理，并在终端里设置 https_proxy（如 export https_proxy=http://127.0.0.1:7890），脚本会自动走代理；',
      '· 在 Claude 云端环境：需要在环境的网络设置里放行 commons.wikimedia.org 和 upload.wikimedia.org。',
    ].join('\n')
  );
}

/** Retry-After 头（秒数或 HTTP 日期）→ 需要等待的秒数；没有时按指数退避（5、10、20…秒） */
export function retryDelay(header, attempt, now = Date.now(), base = 5) {
  const value = header?.trim();
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 120);
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.min(Math.max(Math.ceil((date - now) / 1000), 0), 120);
  }
  return Math.min(base * 2 ** attempt, 120);
}

const sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

async function request(url, { timeout = 30000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(timeout) });
    } catch (error) {
      throw networkHint(error);
    }
    if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
      const wait = retryDelay(res.headers.get('retry-after'), attempt, Date.now(), BACKOFF_BASE);
      console.warn(`  维基媒体${res.status === 429 ? '限流' : '繁忙'}，按要求等 ${wait} 秒后重试（${attempt + 1}/${MAX_RETRIES}）…`);
      await res.body?.cancel();
      await sleep(wait);
      continue;
    }
    if (res.status === 429) throw new UserError('请求太频繁，被维基媒体限流了，过几分钟再试');
    if (!res.ok) throw new UserError(`请求失败：HTTP ${res.status} ${url}`);
    return res;
  }
}

async function commonsQuery(params) {
  const url = new URL(API);
  const all = {
    action: 'query',
    format: 'json',
    formatversion: '2',
    prop: 'imageinfo',
    iiprop: 'url|size|mime|extmetadata',
    iiurlwidth: String(DOWNLOAD_WIDTH),
    iiextmetadatafilter: 'Artist|LicenseShortName|ImageDescription',
    iiextmetadatalanguage: 'zh',
    ...params,
  };
  for (const [k, v] of Object.entries(all)) url.searchParams.set(k, v);
  for (let attempt = 0; ; attempt++) {
    const data = await (await request(url)).json();
    if (!data.error) return (data.query?.pages ?? []).map(toCandidate).filter(Boolean);
    // 搜索后端繁忙（共享出口 IP 上很常见）是临时错误，退避后重试
    const busy = /too busy|try again later|maxlag|ratelimited/i.test(`${data.error.code} ${data.error.info}`);
    if (busy && attempt < MAX_RETRIES) {
      const wait = retryDelay(null, attempt, Date.now(), BACKOFF_BASE);
      console.warn(`  维基共享资源搜索繁忙，等 ${wait} 秒后重试（${attempt + 1}/${MAX_RETRIES}）…`);
      await sleep(wait);
      continue;
    }
    throw new UserError(`Commons API 报错：${data.error.info ?? data.error.code}`);
  }
}

async function download(url) {
  const res = await request(url, { timeout: 60000 });
  return Buffer.from(await res.arrayBuffer());
}

/** 把预览图拼成一张带编号的总览图，挑图时看一张就够 */
export async function contactSheet(items, out) {
  const { default: sharp } = await import('sharp');
  const cols = 5;
  const [cw, ch, pad] = [300, 210, 8];
  const rows = Math.ceil(items.length / cols);
  const composites = [];
  for (const [i, { file, label }] of items.entries()) {
    const left = pad + (i % cols) * (cw + pad);
    const top = pad + Math.floor(i / cols) * (ch + pad);
    try {
      const thumb = await sharp(file).resize(cw, ch, { fit: 'contain', background: '#282828' }).toBuffer();
      composites.push({ input: thumb, left, top });
    } catch {
      continue; // 个别预览图损坏时跳过
    }
    const badge = `<svg xmlns="http://www.w3.org/2000/svg" width="46" height="32"><rect width="46" height="32" fill="#c82828"/><text x="23" y="23" font-family="sans-serif" font-size="20" font-weight="bold" fill="#fff" text-anchor="middle">${label}</text></svg>`;
    composites.push({ input: Buffer.from(badge), left, top });
  }
  await sharp({
    create: { width: cols * (cw + pad) + pad, height: rows * (ch + pad) + pad, channels: 3, background: '#282828' },
  })
    .composite(composites)
    .jpeg({ quality: 82 })
    .toFile(out);
}

/** 统一处理：按 EXIF 摆正方向、缩到最长边 MAX_EDGE、转 JPEG；不保留 EXIF（去掉 GPS 等隐私信息） */
async function toJpeg(input) {
  const { default: sharp } = await import('sharp');
  try {
    return await sharp(input)
      .rotate()
      .flatten({ background: '#ffffff' }) // 透明 PNG 垫白底，否则转 JPEG 会变黑
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer();
  } catch (error) {
    if (/heif|heic|unsupported image format/i.test(String(error?.message))) {
      throw new UserError(
        'HEIC 格式读不了，请先转成 JPEG（Mac：sips -s format jpeg 输入.HEIC --out 输出.jpg；' +
          '或在 iPhone「设置 → 相机 → 格式」选「兼容性最佳」）'
      );
    }
    throw error;
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

async function cmdSearch(slug, opts) {
  const place = await readPlace(slug);
  const queries = [...new Set([place.title, ...(opts.q ?? [])].map((q) => q.trim()).filter(Boolean))];
  const limit = Math.min(Math.max(Number(opts.limit) || 20, 1), 50);
  const radius = Math.min(Math.max(Number(opts.radius) || 10, 1), 10); // API 上限 10 公里

  const batches = [];
  for (const q of queries) {
    batches.push(
      await commonsQuery({
        generator: 'search',
        gsrsearch: `${q} filetype:bitmap`,
        gsrnamespace: '6',
        gsrlimit: String(limit),
      })
    );
  }
  if (place.coords && !opts['no-geo']) {
    batches.push(
      await commonsQuery({
        generator: 'geosearch',
        ggscoord: place.coords.join('|'),
        ggsradius: String(radius * 1000),
        ggsnamespace: '6',
        ggslimit: String(limit),
        prop: 'imageinfo|coordinates',
        codistancefrompoint: place.coords.join('|'),
        colimit: 'max',
      })
    );
  }

  const all = mergeCandidates(batches);
  const usable = all.filter((c) => !rejectReason(c)).slice(0, 40);
  const cacheDir = path.join(CACHE_DIR, slug);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(path.join(cacheDir, 'candidates.json'), JSON.stringify(usable, null, 2));

  const scope = [`关键词：${queries.join(' / ')}`, place.coords && !opts['no-geo'] ? `周边 ${radius} 公里` : null]
    .filter(Boolean)
    .join(' · ');
  console.log(`${place.title}（${slug}）· ${scope}`);
  console.log(`找到 ${usable.length} 张可用照片（另有 ${all.length - usable.length} 个结果因格式/授权/尺寸/内容被排除）\n`);
  usable.forEach((c, i) => {
    const shape = c.width >= c.height ? '横' : '竖';
    const near = c.distance != null ? ` · 距坐标 ${(c.distance / 1000).toFixed(1)} 公里` : '';
    console.log(`${String(i + 1).padStart(2)}. ${c.title}`);
    console.log(`    ${c.width}×${c.height} ${shape} · ${c.license}${c.artist ? ` · 作者 ${c.artist}` : ''}${near}`);
    if (c.description) console.log(`    ${c.description.slice(0, 100)}`);
  });

  if (usable.length === 0) {
    console.log('没有合适的结果。可以换英文名、具体景点名再搜（--q "Kanas Lake"），或扩大/取消周边搜索。');
    return;
  }

  if (opts.preview) {
    const dir = path.join(cacheDir, 'preview');
    await mkdir(dir, { recursive: true });
    // 维基媒体建议并发不超过 3
    const saved = await mapLimit(usable.slice(0, PREVIEW_MAX), 2, async (c, i) => {
      const url = c.url.replace(/\/\d+px-([^/]+)$/, `/${PREVIEW_WIDTH}px-$1`);
      const ext = path.extname(new URL(url).pathname).toLowerCase() || '.jpg';
      const file = path.join(dir, `${String(i + 1).padStart(2, '0')}${ext}`);
      try {
        await writeFile(file, await download(url));
        return { file, label: String(i + 1) };
      } catch (error) {
        console.warn(`  预览图 ${i + 1} 下载失败：${error.message.split('\n')[0]}`);
        return null;
      }
    });
    const ok = saved.filter(Boolean);
    const more = usable.length > PREVIEW_MAX ? `；只下载了前 ${PREVIEW_MAX} 张，后面的看标题和描述判断` : '';
    if (ok.length > 0) {
      const sheet = path.join(cacheDir, 'contact.jpg');
      await contactSheet(ok, sheet);
      console.log(`\n预览总览：${path.relative(ROOT, sheet)}（一张图里带编号的全部预览，先看这张${more}）`);
    }
    console.log(`单张预览：${path.relative(ROOT, dir)}/（文件名编号与上面一致）`);
  }
  console.log(`\n挑好后运行：npm run photos -- add ${slug} <编号>...`);
}

async function resolveRefs(slug, refs) {
  const cached = path.join(CACHE_DIR, slug, 'candidates.json');
  let candidates = null;
  const out = [];
  const titles = [];
  for (const ref of refs) {
    if (/^\d+$/.test(ref)) {
      if (!candidates) {
        if (!existsSync(cached)) throw new UserError(`用编号添加前要先运行：npm run photos -- search ${slug}`);
        candidates = JSON.parse(await readFile(cached, 'utf8'));
      }
      const c = candidates[Number(ref) - 1];
      if (!c) throw new UserError(`编号 ${ref} 超出范围（共 ${candidates.length} 个候选）`);
      out.push(c);
    } else {
      const title = toFileTitle(ref);
      if (!title) throw new UserError(`看不懂「${ref}」：请用候选编号、File:文件名，或 Commons 文件页链接`);
      titles.push(title);
    }
  }
  if (titles.length) {
    const found = await commonsQuery({ titles: titles.join('|') });
    for (const title of titles) {
      const c = found.find((f) => sameTitle(f.title, title));
      if (!c) throw new UserError(`Commons 上没找到 ${title}`);
      out.push(c);
    }
  }
  return out;
}

async function savePhotos(place, items) {
  await mkdir(place.photoDir, { recursive: true });
  let n = await nextFileNumber(place.photoDir);
  const entries = [];
  for (const { buffer, entry } of items) {
    const name = `${String(n++).padStart(2, '0')}.jpg`;
    await writeFile(path.join(place.photoDir, name), await toJpeg(buffer));
    entries.push({ src: `./photos/${place.slug}/${name}`, ...entry });
    console.log(`  ✓ ${path.relative(ROOT, path.join(place.photoDir, name))}  ${entry.caption}`);
  }
  const latest = await readFile(place.file, 'utf8');
  await writeFile(place.file, insertPhotos(latest, entries));
  return entries;
}

async function cmdAdd(slug, refs) {
  if (refs.length === 0) throw new UserError('请给出要添加的候选编号或 File:文件名');
  const place = await readPlace(slug);
  const known = existingSources(place.text);
  const items = [];
  for (const c of await resolveRefs(slug, refs)) {
    if (!isFreeLicense(c.license)) {
      console.warn(`  ✗ 跳过 ${c.title}：授权「${c.license || '未知'}」不能用于公开网站`);
      continue;
    }
    if (known.has(c.pageUrl)) {
      console.warn(`  - 跳过 ${c.title}：已经在相册里了`);
      continue;
    }
    known.add(c.pageUrl);
    items.push({
      buffer: await download(c.url),
      entry: { caption: defaultCaption(c), credit: c.artist || undefined, license: c.license, sourceUrl: c.pageUrl },
    });
  }
  if (items.length === 0) return console.log('没有需要添加的照片。');
  console.log(`添加到 ${place.title}：`);
  await savePhotos(place, items);
  console.log(`\n已写入 ${path.relative(ROOT, place.file)}。记得把 caption 改成简短的中文说明（作者/授权/链接不要改）。`);
}

async function cmdImport(slug, files, opts) {
  if (files.length === 0) throw new UserError('请给出要导入的图片路径');
  const place = await readPlace(slug);
  // npm run 会把工作目录切到仓库根目录，相对路径要按用户原来所在的目录解析
  const base = process.env.INIT_CWD || process.cwd();
  const items = [];
  for (const file of files.map((f) => path.resolve(base, f))) {
    if (!existsSync(file)) throw new UserError(`找不到文件 ${file}`);
    items.push({ buffer: await readFile(file), entry: { caption: opts.caption || '（待补充说明）' } });
  }
  console.log(`导入到 ${place.title}（已去掉 EXIF，包括 GPS 位置）：`);
  await savePhotos(place, items);
  console.log(`\n已写入 ${path.relative(ROOT, place.file)}。记得把 caption 改成这张照片的说明。`);
}

const HELP = `用法：
  npm run photos -- search <slug> [--q 关键词]... [--radius 公里] [--limit 条数] [--no-geo] [--preview]
      在维基共享资源按地名（frontmatter 的 title）和 --q 关键词搜索，并在坐标周边搜索；
      列出可用的自由授权照片。--preview 会把小图下载到 .cache/photos/<slug>/preview/ 方便挑选。
  npm run photos -- add <slug> <编号 | File:文件名 | Commons 链接>...
      下载选中的照片，压缩后存进 src/content/places/photos/<slug>/，并写入 frontmatter（含署名）。
  npm run photos -- import <slug> <本地图片>... [--caption 说明]
      导入自己拍的照片（会去掉 EXIF/GPS 信息）。`;

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        q: { type: 'string', multiple: true },
        radius: { type: 'string' },
        limit: { type: 'string' },
        'no-geo': { type: 'boolean' },
        preview: { type: 'boolean' },
        caption: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    throw new UserError(`${error.message}\n\n${HELP}`);
  }
  const { values, positionals } = parsed;
  const [command, slug, ...rest] = positionals;
  if (values.help || !command) return console.log(HELP);
  if (command === 'search') return cmdSearch(slug, values);
  if (command === 'add') return cmdAdd(slug, rest);
  if (command === 'import') return cmdImport(slug, rest, values);
  throw new UserError(`不认识的命令「${command}」\n\n${HELP}`);
}

/** 设置了代理环境变量时，用 NODE_USE_ENV_PROXY=1 重新启动自己，让内置 fetch 走代理 */
function relaunchWithProxy() {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!proxy || process.env.NODE_USE_ENV_PROXY) return false;
  const [major, minor] = process.versions.node.split('.').map(Number);
  const quiet = major > 20 || (major === 20 && minor >= 11) ? ['--disable-warning=UNDICI-EHPA'] : [];
  const result = spawnSync(process.execPath, [...quiet, fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, NODE_USE_ENV_PROXY: '1' },
  });
  process.exitCode = result.status ?? 1;
  return true;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href && !relaunchWithProxy()) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof UserError ? `\n${error.message}` : error);
    process.exitCode = 1;
  });
}
