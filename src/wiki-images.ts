import { load } from 'cheerio';
import type { Source } from './domain.js';
/** Wikimedia serves thumbnails from both upload and thumb hosts. */
export function isWikiImageUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    return (
      u.protocol === 'https:' &&
      ['upload.wikimedia.org', 'thumb.wikimedia.org'].includes(u.hostname)
    );
  } catch {
    return false;
  }
}
export function wikiImage(
  meta: { thumbnail?: { source?: string }; pageimage?: string },
  info: any = {},
): Source['image'] {
  if (!isWikiImageUrl(meta.thumbnail?.source) || !meta.pageimage) return null;
  const ext = info.extmetadata ?? {};
  const plain = (value: unknown) =>
    typeof value === 'string' ? load(value).text().trim() || null : null;
  return {
    url: meta.thumbnail.source,
    fileName: meta.pageimage,
    attribution: plain(ext.Artist?.value),
    license: plain(ext.LicenseShortName?.value),
    licenseUrl: ext.LicenseUrl?.value ?? null,
    descriptionUrl: info.descriptionurl ?? null,
  };
}
