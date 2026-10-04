import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
/** Repair display metadata only; card definitions, source prose and trivia stay unchanged. */
import { CatalogueStore } from '../src/store.js';
import { wikiImage } from '../src/wiki-images.js';
import type { Source } from '../src/domain.js';
const store = new CatalogueStore(process.env.CARD_DATA_DIR ?? 'data/catalogue');
const ids = [
  ...new Set(Object.values(store.data.published).map((id) => store.data.cards[id]!.pageId)),
];
const checkpoint = join(store.directory, 'image-repair-progress.json');
const saved = existsSync(checkpoint)
  ? JSON.parse(readFileSync(checkpoint, 'utf8'))
  : { checked: [], images: [] };
const checked = new Set<number>(saved.checked);
const images = new Map<number, NonNullable<Source['image']>>(saved.images);
const pending = ids.filter((id) => !checked.has(id));
async function query(params: Record<string, string>): Promise<any> {
  const url =
    'https://en.wikipedia.org/w/api.php?' +
    new URLSearchParams({
      action: 'query',
      format: 'json',
      formatversion: '2',
      maxlag: '5',
      ...params,
    });
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Trivattle/0.1 (Wikipedia card image metadata repair)' },
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 429 || res.status >= 500) {
      const delay = Math.max(
        3000 * (attempt + 1),
        Number(res.headers.get('retry-after') ?? 0) * 1000,
      );
      console.log(`Wikipedia HTTP ${res.status}; retrying in ${delay / 1000}s.`);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }
    if (!res.ok) throw Error(`Wikipedia image metadata: HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw Error(data.error.info);
    return data;
  }
  throw Error('Wikipedia image metadata retry budget exhausted');
}
for (let offset = 0; offset < pending.length; offset += 50) {
  const pages = (
    await query({
      pageids: pending.slice(offset, offset + 50).join('|'),
      prop: 'pageimages',
      piprop: 'thumbnail|name',
      pithumbsize: '500',
      pilicense: 'free',
      pilimit: '50',
    })
  ).query.pages;
  const candidates = pages.filter((p: any) => wikiImage(p));
  const infos = new Map<string, any>();
  if (candidates.length) {
    const files = (
      await query({
        titles: candidates.map((p: any) => 'File:' + p.pageimage).join('|'),
        prop: 'imageinfo',
        iiprop: 'url|extmetadata',
      })
    ).query.pages;
    for (const f of files) infos.set(f.title.replaceAll('_', ' '), f.imageinfo?.[0] ?? {});
  }
  for (const p of candidates) {
    const image = wikiImage(p, infos.get(('File:' + p.pageimage).replaceAll('_', ' ')));
    if (image) images.set(p.pageid, image);
  }
  for (const id of pending.slice(offset, offset + 50)) checked.add(id);
  writeFileSync(checkpoint, JSON.stringify({ checked: [...checked], images: [...images] }), {
    mode: 0o600,
  });
  console.log(`Checked ${checked.size}/${ids.length} articles; ${images.size} images found.`);
  await new Promise((r) => setTimeout(r, 1000));
}
await store.withWriter(async () => {
  let updated = 0;
  for (const source of Object.values(store.data.sources)) {
    const image = images.get(source.pageId);
    if (image && JSON.stringify(source.image) !== JSON.stringify(image)) {
      source.image = image;
      updated++;
    }
  }
  store.save();
  console.log(
    `Updated image metadata on ${updated} cached source versions. Card stats and trivia unchanged.`,
  );
});

if (existsSync(checkpoint)) unlinkSync(checkpoint);
