import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const places = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/places' }),
  schema: ({ image }) => z.object({
    /** 地名，如「京都」 */
    title: z.string(),
    /** 国家 */
    country: z.string(),
    /** 大区，用于首页筛选 */
    region: z.enum(['东亚', '东南亚', '南亚', '中亚', '中东', '欧洲', '北美', '南美', '非洲', '大洋洲', '国内']),
    /** 经纬度 [lat, lng] */
    coordinates: z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)]),
    /** 记录日期 */
    addedDate: z.date(),
    /** 来源链接（B 站视频等） */
    sourceUrl: z.string().url(),
    /** 来源平台 */
    sourcePlatform: z.enum(['bilibili', '小红书', '朋友推荐', '其他']),
    /** 当时为什么想去 —— 原话保留，最重要的字段 */
    motivation: z.string(),
    /** 想去 / 计划中 / 已去过 */
    status: z.enum(['wishlist', 'planning', 'visited']).default('wishlist'),
    /** 对中国护照的签证类型 */
    visaType: z.enum(['免签', '落地签', '电子签', '需办签证', '国内无需']),
    /** 最佳旅行季节 */
    bestSeason: z.string(),
    /** 封面图路径（相对 public/，不带 base 前缀），可选 */
    coverImage: z.string().optional(),
    /** SVG 插画路径（相对 public/，不带 base 前缀），可选 */
    illustration: z.string().optional(),
    /**
     * 相册：照片放在 src/content/places/photos/<slug>/，路径相对本 md 文件，
     * 如 ./photos/altay/01.jpg。构建时会校验文件存在，并自动压缩成多尺寸 webp。
     * 网上找的照片必须填 credit / license / sourceUrl（署名要求）；自己拍的可以省略。
     */
    photos: z
      .array(
        z.object({
          src: image(),
          /** 中文说明，同时用作图片的替代文本 */
          caption: z.string(),
          /** 作者 */
          credit: z.string().optional(),
          /** 授权协议，如 CC BY-SA 4.0 */
          license: z.string().optional(),
          /** 原图页面 */
          sourceUrl: z.string().url().optional(),
        })
      )
      .default([]),
  }),
});

export const collections = { places };
