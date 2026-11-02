// 照片脚本的测试：npm test
// 纯函数直接测；完整流程（search → add → import）在临时目录里跑，网络请求用假的 fetch 代替。
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import sharp from 'sharp';
import {
  existingSources,
  insertPhotos,
  isFreeLicense,
  mergeCandidates,
  nextNumber,
  rejectReason,
  sameTitle,
  stripHtml,
  toCandidate,
  toFileTitle,
  yamlString,
} from './photos.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- 按 Commons API（formatversion=2）返回格式构造的测试数据 ----
function page({ title, index, width = 4000, height = 2667, mime = 'image/jpeg', license = 'CC BY-SA 4.0', artist, description, dist }) {
  const file = title.slice(5).replace(/ /g, '_');
  const thumb = width > 1280;
  return {
    pageid: Math.floor(Math.random() * 1e6),
    ns: 6,
    title,
    ...(index != null && { index }),
    ...(dist != null && { coordinates: [{ lat: 47.1, lon: 88.1, primary: true, globe: 'earth', dist }] }),
    imagerepository: 'local',
    imageinfo: [
      {
        size: 2345678,
        width,
        height,
        ...(thumb && {
          thumburl: `https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/${file}/1280px-${file}`,
          thumbwidth: 1280,
          thumbheight: Math.round((height * 1280) / width),
        }),
        url: `https://upload.wikimedia.org/wikipedia/commons/a/ab/${file}`,
        descriptionurl: `https://commons.wikimedia.org/wiki/File:${file}`,
        descriptionshorturl: 'https://commons.wikimedia.org/w/index.php?curid=1',
        mime,
        extmetadata: {
          ...(description && { ImageDescription: { value: description, source: 'commons-desc-page' } }),
          ...(artist && { Artist: { value: artist, source: 'commons-desc-page' } }),
          LicenseShortName: { value: license, source: 'commons-desc-page', hidden: '' },
        },
      },
    ],
  };
}

const SEARCH_PAGES = [
  page({
    title: 'File:Demo Lake autumn.jpg',
    index: 2,
    artist: '<a href="//commons.wikimedia.org/wiki/User:Example" title="User:Example">Example Photographer</a>',
    description: '<p>秋天的<b>示例湖</b>&nbsp;全景</p>',
  }),
  page({ title: 'File:Demo Lake sunrise.jpg', index: 1, license: 'CC0', artist: 'Jane Doe', description: 'Sunrise over Demo Lake' }),
  page({ title: 'File:Demo Lake location map.png', index: 3, mime: 'image/png' }),
  page({ title: 'File:Demo Lake boats.jpg', index: 4, license: 'CC BY-NC 2.0' }),
  page({ title: 'File:Demo Lake tiny.jpg', index: 5, width: 640, height: 480 }),
  page({ title: 'File:Demo Lake.svg', index: 6, mime: 'image/svg+xml' }),
  page({ title: 'File:Demo Lake panorama.jpg', index: 7, width: 9000, height: 1500 }),
];
const GEO_PAGES = [
  page({ title: 'File:Demo village street.jpg', dist: 2300.5, license: 'CC BY 2.0', artist: 'Flickr user' }),
  page({ title: 'File:Demo Lake sunrise.jpg', dist: 900, license: 'CC0', artist: 'Jane Doe' }), // 与关键词结果重复
  page({ title: 'File:Demo pier.jpg', dist: 150.2, license: 'Public domain', width: 1600, height: 1067 }),
];

const PLACE_MD = `---
title: 示例湖
country: 中国
region: 国内
coordinates: [47.1234, 88.5678]
addedDate: 2026-10-01
sourceUrl: https://www.bilibili.com/video/BV1xx
sourcePlatform: bilibili
motivation: 想去看看
status: wishlist
visaType: 国内无需
bestSeason: 9 月
illustration: illustrations/demo.svg
---

## 美景

正文第一段。
`;

const frontmatter = (md) => yaml.load(md.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]);

// ---------------------------------------------------------------------------

describe('纯函数', () => {
  test('stripHtml 去标签、解码实体', () => {
    assert.equal(stripHtml('<p>秋天的<b>示例湖</b>&nbsp;全景&amp;<br/>远山 &#x4E2D;&#22269;</p>'), '秋天的示例湖 全景& 远山 中国');
    assert.equal(stripHtml(undefined), '');
  });

  test('isFreeLicense 只接受可公开使用的自由授权', () => {
    for (const ok of ['CC BY-SA 4.0', 'CC BY 2.0', 'CC0', 'Public domain', 'PD-self', 'Attribution', 'CC-BY-SA-3.0']) {
      assert.ok(isFreeLicense(ok), ok);
    }
    for (const bad of ['CC BY-NC 2.0', 'CC BY-NC-SA 4.0', 'CC BY-ND 4.0', 'GFDL', '', 'All rights reserved']) {
      assert.ok(!isFreeLicense(bad), bad);
    }
  });

  test('toCandidate 解析 API 返回，rejectReason 过滤不合适的', () => {
    const cands = SEARCH_PAGES.map(toCandidate);
    const [autumn, sunrise, map, nc, tiny, svg, pano] = cands;
    assert.equal(autumn.artist, 'Example Photographer');
    assert.equal(autumn.description, '秋天的示例湖 全景');
    assert.equal(autumn.url, 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Demo_Lake_autumn.jpg/1280px-Demo_Lake_autumn.jpg');
    assert.equal(autumn.pageUrl, 'https://commons.wikimedia.org/wiki/File:Demo_Lake_autumn.jpg');
    assert.equal(rejectReason(autumn), null);
    assert.equal(rejectReason(sunrise), null);
    assert.match(rejectReason(map), /地图/);
    assert.match(rejectReason(nc), /授权/);
    assert.match(rejectReason(tiny), /太小/);
    assert.match(rejectReason(svg), /格式/);
    assert.match(rejectReason(pano), /比例/);
    assert.equal(toCandidate({ title: 'File:Missing.jpg', missing: true }), null);
    assert.equal(toCandidate(GEO_PAGES[0]).distance, 2300.5);
  });

  test('mergeCandidates：每批按名次/距离排序，跨批去重', () => {
    const merged = mergeCandidates([SEARCH_PAGES.map(toCandidate), GEO_PAGES.map(toCandidate)]);
    assert.deepEqual(
      merged.map((c) => c.title).slice(0, 2),
      ['File:Demo Lake sunrise.jpg', 'File:Demo Lake autumn.jpg']
    );
    assert.equal(merged.filter((c) => c.title === 'File:Demo Lake sunrise.jpg').length, 1);
    assert.deepEqual(merged.slice(-2).map((c) => c.title), ['File:Demo pier.jpg', 'File:Demo village street.jpg']);
  });

  test('yamlString 安全时用裸字符串，否则加引号', () => {
    assert.equal(yamlString('喀纳斯湖的月亮湾'), '喀纳斯湖的月亮湾');
    assert.equal(yamlString('CC BY-SA 4.0'), 'CC BY-SA 4.0');
    assert.equal(yamlString('https://commons.wikimedia.org/wiki/File:A_(b).jpg'), 'https://commons.wikimedia.org/wiki/File:A_(b).jpg');
    for (const s of ['note: x', '- dash', 'a #b', '2026', 'true', '', ' x', '"q"', '[x]', 'line\nbreak']) {
      assert.equal(yaml.load(`v: ${yamlString(s)}`).v, s, s);
    }
  });

  test('insertPhotos：没有 photos 字段时新建，正文不变', () => {
    const out = insertPhotos(PLACE_MD, [
      { src: './photos/demo/01.jpg', caption: '湖边: 清晨', credit: 'Jane', license: 'CC0', sourceUrl: 'https://commons.wikimedia.org/wiki/File:A.jpg' },
      { src: './photos/demo/02.jpg', caption: '自己拍的' },
    ]);
    const data = frontmatter(out);
    assert.equal(data.illustration, 'illustrations/demo.svg');
    assert.deepEqual(data.photos, [
      { src: './photos/demo/01.jpg', caption: '湖边: 清晨', credit: 'Jane', license: 'CC0', sourceUrl: 'https://commons.wikimedia.org/wiki/File:A.jpg' },
      { src: './photos/demo/02.jpg', caption: '自己拍的' },
    ]);
    assert.ok(out.endsWith('---\n\n## 美景\n\n正文第一段。\n'));
  });

  test('insertPhotos：追加到已有列表末尾，后面的字段保留', () => {
    const md = PLACE_MD.replace(
      'illustration: illustrations/demo.svg\n',
      'photos:\n  - src: ./photos/demo/01.jpg\n    caption: 第一张\n\nillustration: illustrations/demo.svg\n'
    );
    const data = frontmatter(insertPhotos(md, [{ src: './photos/demo/02.jpg', caption: '第二张' }]));
    assert.deepEqual(data.photos.map((p) => p.caption), ['第一张', '第二张']);
    assert.equal(data.illustration, 'illustrations/demo.svg');
  });

  test('insertPhotos：兼容顶格列表、photos: [] 和 CRLF', () => {
    const flat = PLACE_MD.replace('illustration:', 'photos:\n- src: ./photos/demo/01.jpg\n  caption: 顶格\nillustration:');
    assert.deepEqual(frontmatter(insertPhotos(flat, [{ src: './photos/demo/02.jpg', caption: '新' }])).photos.length, 2);

    const empty = PLACE_MD.replace('illustration:', 'photos: []\nillustration:');
    assert.equal(frontmatter(insertPhotos(empty, [{ src: './photos/demo/01.jpg', caption: '新' }])).photos.length, 1);

    const crlf = PLACE_MD.replace(/\n/g, '\r\n');
    const out = insertPhotos(crlf, [{ src: './photos/demo/01.jpg', caption: '新' }]);
    assert.ok(!/[^\r]\n/.test(out), '保持 CRLF');
    assert.equal(frontmatter(out).photos.length, 1);

    assert.throws(() => insertPhotos('no frontmatter', []), /frontmatter/);
  });

  test('existingSources / toFileTitle / sameTitle / nextNumber', () => {
    const md = insertPhotos(PLACE_MD, [{ src: './a.jpg', caption: 'x', sourceUrl: 'https://commons.wikimedia.org/wiki/File:A.jpg' }]);
    assert.deepEqual([...existingSources(md)], ['https://commons.wikimedia.org/wiki/File:A.jpg']);
    assert.equal(toFileTitle('https://commons.wikimedia.org/wiki/File:Kanas_Lake_%282%29.jpg?uselang=zh'), 'File:Kanas Lake (2).jpg');
    assert.equal(toFileTitle('File:Kanas_Lake.jpg'), 'File:Kanas Lake.jpg');
    assert.equal(toFileTitle('Kanas Lake.jpg'), null);
    assert.ok(sameTitle('File:kanas_Lake.jpg', 'File:Kanas Lake.jpg'));
    assert.equal(nextNumber([]), 1);
    assert.equal(nextNumber(['01.jpg', '03.jpg', 'notes.txt']), 4);
  });
});

// ---------------------------------------------------------------------------

describe('完整流程（临时目录 + 假网络）', () => {
  let tmp;
  let run;
  let requests = [];
  const realFetch = globalThis.fetch;

  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'wanderlist-photos-'));
    await mkdir(path.join(tmp, 'scripts'));
    await cp(path.join(ROOT, 'scripts/photos.mjs'), path.join(tmp, 'scripts/photos.mjs'));
    await symlink(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'), 'dir');
    await mkdir(path.join(tmp, 'src/content/places'), { recursive: true });
    await writeFile(path.join(tmp, 'src/content/places/demo.md'), PLACE_MD);
    ({ main: run } = await import(pathToFileURL(path.join(tmp, 'scripts/photos.mjs')).href));

    const jpeg = await sharp({ create: { width: 1280, height: 853, channels: 3, background: '#6a8caf' } }).jpeg().toBuffer();
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.hostname === 'upload.wikimedia.org') return new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } });
      const p = url.searchParams;
      let pages = [];
      if (p.get('generator') === 'search') pages = SEARCH_PAGES;
      else if (p.get('generator') === 'geosearch') pages = GEO_PAGES;
      else if (p.get('titles')) {
        pages = p.get('titles').split('|').map((t) => [...SEARCH_PAGES, ...GEO_PAGES].find((x) => sameTitle(x.title, t)) ?? { title: t, missing: true });
      }
      return Response.json({ batchcomplete: true, query: { pages } });
    };
  });

  after(async () => {
    globalThis.fetch = realFetch;
    await rm(tmp, { recursive: true, force: true });
  });

  test('search 写出候选列表、按坐标做周边搜索、可下载预览图', async (t) => {
    t.mock.method(console, 'log', () => {});
    await run(['search', 'demo', '--q', 'Demo Lake', '--preview']);
    const geo = requests.find((u) => u.searchParams.get('generator') === 'geosearch');
    assert.equal(geo.searchParams.get('ggscoord'), '47.1234|88.5678');
    assert.equal(geo.searchParams.get('ggsradius'), '10000');
    const search = requests.filter((u) => u.searchParams.get('generator') === 'search').map((u) => u.searchParams.get('gsrsearch'));
    assert.deepEqual(search, ['示例湖 filetype:bitmap', 'Demo Lake filetype:bitmap']);
    for (const u of requests.filter((u) => u.hostname === 'commons.wikimedia.org')) {
      assert.equal(u.searchParams.get('formatversion'), '2');
    }

    const cands = JSON.parse(await readFile(path.join(tmp, '.cache/photos/demo/candidates.json'), 'utf8'));
    assert.deepEqual(cands.map((c) => c.title), [
      'File:Demo Lake sunrise.jpg',
      'File:Demo Lake autumn.jpg',
      'File:Demo pier.jpg',
      'File:Demo village street.jpg',
    ]);
    const previews = await readdir(path.join(tmp, '.cache/photos/demo/preview'));
    assert.deepEqual(previews.sort(), ['01.jpg', '02.jpg', '03.jpg', '04.jpg']);
    assert.ok(requests.some((u) => u.pathname.endsWith('/330px-Demo_Lake_autumn.jpg')));
  });

  test('add 下载、压缩、写入带署名的 frontmatter，并跳过重复', async (t) => {
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'warn', () => {});
    await run(['add', 'demo', '2', 'File:Demo_pier.jpg']);
    await run(['add', 'demo', '2']); // 重复，应跳过

    const md = await readFile(path.join(tmp, 'src/content/places/demo.md'), 'utf8');
    const { photos } = frontmatter(md);
    assert.deepEqual(photos, [
      {
        src: './photos/demo/01.jpg',
        caption: '秋天的示例湖 全景',
        credit: 'Example Photographer',
        license: 'CC BY-SA 4.0',
        sourceUrl: 'https://commons.wikimedia.org/wiki/File:Demo_Lake_autumn.jpg',
      },
      {
        src: './photos/demo/02.jpg',
        caption: 'Demo pier',
        license: 'Public domain',
        sourceUrl: 'https://commons.wikimedia.org/wiki/File:Demo_pier.jpg',
      },
    ]);
    const meta = await sharp(path.join(tmp, 'src/content/places/photos/demo/01.jpg')).metadata();
    assert.equal(meta.format, 'jpeg');
    assert.equal(meta.width, 1280);
  });

  test('import 导入本地照片：缩小到 1600px、去掉 EXIF', async (t) => {
    t.mock.method(console, 'log', () => {});
    const local = path.join(tmp, 'IMG_0001.png');
    await sharp({ create: { width: 3000, height: 2000, channels: 4, background: { r: 200, g: 120, b: 60, alpha: 0.5 } } })
      .withMetadata({ exif: { IFD0: { Make: 'TestCam' } } })
      .png()
      .toFile(local);
    process.env.INIT_CWD = tmp;
    await run(['import', 'demo', 'IMG_0001.png', '--caption', '傍晚的湖边']);
    delete process.env.INIT_CWD;

    const { photos } = frontmatter(await readFile(path.join(tmp, 'src/content/places/demo.md'), 'utf8'));
    assert.deepEqual(photos.at(-1), { src: './photos/demo/03.jpg', caption: '傍晚的湖边' });
    const meta = await sharp(path.join(tmp, 'src/content/places/photos/demo/03.jpg')).metadata();
    assert.equal(meta.width, 1600);
    assert.equal(meta.exif, undefined);
  });

  test('出错时给出可读的提示', async () => {
    await assert.rejects(run(['add', 'nope', '1']), /找不到/);
    await assert.rejects(run(['add', 'demo']), /请给出/);
    await assert.rejects(run(['search', '../etc']), /slug/);
    await assert.rejects(run(['add', 'demo', '99']), /超出范围/);
    await assert.rejects(run(['add', 'demo', 'File:Not there.jpg']), /没找到/);
    await assert.rejects(run(['frobnicate']), /不认识的命令/);
  });
});
