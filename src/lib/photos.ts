import type { ImageMetadata } from 'astro';
import { getImage } from 'astro:assets';
import type { CollectionEntry } from 'astro:content';

export type Photo = CollectionEntry<'places'>['data']['photos'][number];

/** 灯箱大图的最长边 */
const LIGHTBOX_WIDTH = 1600;

/** 只保留不超过原图宽度的候选尺寸（不放大），一个都不剩时用原图宽度 */
export function widthsFor(src: ImageMetadata, candidates: number[]): number[] {
  const fit = candidates.filter((w) => w <= src.width);
  return fit.length > 0 ? fit : [src.width];
}

/** 署名行，如「摄影 Foo · CC BY-SA 4.0」；自己拍的照片没填署名时为空串 */
export function byline(photo: Pick<Photo, 'credit' | 'license'>): string {
  return [photo.credit && `摄影 ${photo.credit}`, photo.license].filter(Boolean).join(' · ');
}

/** 照片是否带署名信息（网上找的照片都应该有） */
export function hasAttribution(photo: Photo): boolean {
  return Boolean(photo.credit || photo.license || photo.sourceUrl);
}

/** 给模板用的照片数据：附上灯箱用的大图地址与尺寸、署名行 */
export async function preparePhotos(photos: Photo[]) {
  return Promise.all(
    photos.map(async (photo) => {
      const width = Math.min(photo.src.width, LIGHTBOX_WIDTH);
      const full = await getImage({ src: photo.src, width, format: 'webp', quality: 80 });
      return {
        ...photo,
        full: {
          url: full.src,
          width,
          height: Math.round((photo.src.height * width) / photo.src.width),
        },
        byline: byline(photo),
      };
    })
  );
}

export type PreparedPhoto = Awaited<ReturnType<typeof preparePhotos>>[number];

/** 分享卡片（og:image）用的 1200px JPEG，返回站点绝对地址 */
export async function ogImageUrl(photo: Photo, site: URL | undefined): Promise<string | undefined> {
  if (!site) return undefined;
  const img = await getImage({
    src: photo.src,
    width: Math.min(photo.src.width, 1200),
    format: 'jpg',
    quality: 80,
  });
  return new URL(img.src, site).href;
}
