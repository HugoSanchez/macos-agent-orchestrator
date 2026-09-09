import type { MetadataRoute } from 'next';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: 'https://itsverso.xyz',
      changeFrequency: 'weekly',
      priority: 1,
    },
    {
      url: 'https://itsverso.xyz/privacy',
      changeFrequency: 'monthly',
      priority: 0.5,
    },
  ];
}
