import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { isWikiImageUrl } from './wiki-images.js';
export type CachedArt = { contentType: string; bytes: Buffer };
const mimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
export function imageCandidates(value: string): string[] {
  if (!isWikiImageUrl(value)) return [];
  const u = new URL(value);
  if (u.port || u.username || u.password || !u.pathname.startsWith('/wikipedia/')) return [];
  u.search = '';
  u.hash = '';
  const primary = u.toString();
  u.hostname =
    u.hostname === 'thumb.wikimedia.org' ? 'upload.wikimedia.org' : 'thumb.wikimedia.org';
  return [primary, u.toString()];
}
/** Same source bytes for every browser. Bounded fetches, disk cache, and shared in-flight work. */
export class CardArtCache {
  private pending = new Map<string, Promise<CachedArt>>();
  private failed = new Map<string, number>();
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(
    readonly directory = 'data/art-cache',
    readonly transport: typeof fetch = fetch,
  ) {}
  async get(url: string): Promise<CachedArt> {
    const candidates = imageCandidates(url);
    if (!candidates.length) throw Error('Unsupported image source');
    const key = createHash('sha256').update(candidates.slice().sort().join('|')).digest('hex');
    const existing = this.pending.get(key);
    if (existing) return existing;
    if ((this.failed.get(key) ?? 0) > Date.now()) throw Error('Image temporarily unavailable');
    const work = this.load(key, candidates);
    this.pending.set(key, work);
    try {
      return await work;
    } catch (e) {
      this.failed.set(key, Date.now() + 2000);
      throw e;
    } finally {
      this.pending.delete(key);
    }
  }
  private async load(key: string, candidates: string[]): Promise<CachedArt> {
    const path = join(this.directory, key + '.json');
    try {
      const data = JSON.parse(await readFile(path, 'utf8'));
      if (mimeTypes.has(data.contentType) && typeof data.base64 === 'string')
        return { contentType: data.contentType, bytes: Buffer.from(data.base64, 'base64') };
    } catch {
      /* A cache miss is expected on first view. */
    }
    if (this.active >= 4) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    try {
      for (const source of candidates) {
        try {
          let url = source;
          let response: Response | undefined;
          for (let redirect = 0; redirect < 3; redirect++) {
            response = await this.transport(url, {
              redirect: 'manual',
              signal: AbortSignal.timeout(10000),
              headers: {
                'User-Agent': 'Trivattle/0.1 (Wikipedia collectible card image cache)',
                Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*',
              },
            });
            if (response.status >= 300 && response.status < 400) {
              const location = response.headers.get('location');
              await response.body?.cancel();
              if (!location) throw Error('Image redirect missing');
              url = new URL(location, url).toString();
              if (!imageCandidates(url).length) throw Error('Unsafe image redirect');
              continue;
            }
            break;
          }
          const contentType = response?.headers.get('content-type')?.split(';')[0] ?? '';
          if (!response?.ok || !mimeTypes.has(contentType)) {
            await response?.body?.cancel();
            continue;
          }
          const reader = response.body?.getReader();
          if (!reader) continue;
          const parts: Uint8Array[] = [];
          let length = 0;
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              length += value.length;
              if (length > 8 * 1024 * 1024) throw Error('Image too large');
              parts.push(value);
            }
          } finally {
            await reader.cancel();
          }
          if (!length) continue;
          const bytes = Buffer.concat(parts),
            data = { contentType, base64: bytes.toString('base64') };
          await mkdir(this.directory, { recursive: true });
          const temp = path + `.${process.pid}.tmp`;
          await writeFile(temp, JSON.stringify(data));
          await rename(temp, path);
          this.failed.delete(key);
          return { contentType, bytes };
        } catch {
          /* Try the other Wikimedia image host before falling back. */
        }
      }
      throw Error('Image temporarily unavailable');
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}
