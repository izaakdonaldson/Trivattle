import { load } from 'cheerio';
import { HttpClient, HttpError } from './http.js';
import { sourceSchema, viewsSchema, wordCount, type Source, type Views } from './domain.js';
import type { Config } from './config.js';
const ACTION = 'https://en.wikipedia.org/w/api.php';
const analytics = 'https://wikimedia.org/api/rest_v1/metrics/pageviews';
const iso = (d: Date) => d.toISOString().slice(0, 10);
const stamp = (d: Date) => iso(d).replaceAll('-', '') + '00';
export class RejectedArticle extends Error {}
export function cleanArticle(html: string) {
  const $ = load(html);
  $(
    'script,style,nav,aside,footer,.navbox,.vertical-navbox,.infobox,.sidebar,.metadata,.ambox,.hatnote,.mw-editsection,.reference,.references,.reflist,sup,.noprint,figure,figcaption,[role="navigation"],[typeof="mw:Extension/ref"],[typeof="mw:Extension/references"]',
  ).remove();
  $('h2,h3,h4').each((_, el) => {
    if (
      /^(references|notes|external links|further reading|bibliography|see also)$/i.test(
        $(el)
          .text()
          .replace(/\[.*?\]/g, '')
          .trim(),
      )
    ) {
      const section = $(el).closest('section');
      if (section.length) section.remove();
      else $(el).nextUntil('h2').addBack().remove();
    }
  });
  const allWords = wordCount($('body').text());
  $('table,ul,ol,dl').remove();
  const paragraphs = $('p')
    .toArray()
    .map((el) => $(el).text().replace(/\s+/g, ' ').trim())
    .filter((s) => wordCount(s) >= 8);
  const text = paragraphs.join('\n\n');
  return {
    text,
    wordCount: wordCount(text),
    paragraphs: paragraphs.length,
    proseFraction: wordCount(text) / Math.max(1, allWords),
  };
}
export function filterArticle(meta: any, clean: ReturnType<typeof cleanArticle>, config: Config) {
  const reasons: string[] = [];
  if (meta.ns !== 0) reasons.push('non-article namespace');
  if (meta.missing !== undefined || meta.invalid !== undefined) reasons.push('missing article');
  if (meta.pageprops?.disambiguation !== undefined) reasons.push('disambiguation');
  if (/^(list of|lists of|index of|outline of)\b/i.test(meta.title ?? ''))
    reasons.push('list-only article');
  if (clean.wordCount < config.ingestion.minWords)
    reasons.push(`insufficient prose: ${clean.wordCount} words`);
  if (clean.paragraphs < config.ingestion.minParagraphs)
    reasons.push('insufficient factual paragraphs');
  if (clean.proseFraction < config.ingestion.minProseFraction)
    reasons.push('table/list-dominated article');
  return reasons;
}
export interface WikiProvider {
  article(title: string, discovery: Source['discovery']): Promise<Source>;
  pageviews(source: Source, now?: Date): Promise<Views>;
  random(count: number): Promise<string[]>;
  popular(count: number, now?: Date): Promise<string[]>;
}
export class Wikipedia implements WikiProvider {
  constructor(
    private http: HttpClient,
    private config: Config,
  ) {}
  private action(params: Record<string, string>) {
    return this.http.json(
      ACTION +
        '?' +
        new URLSearchParams({
          action: 'query',
          format: 'json',
          formatversion: '2',
          maxlag: '5',
          ...params,
        }),
    );
  }
  async article(title: string, discovery: Source['discovery'] = 'manual'): Promise<Source> {
    let response = await this.action({
      titles: title,
      redirects: '1',
      prop: 'info|pageprops|categories|pageimages',
      inprop: 'url',
      cllimit: 'max',
      clshow: '!hidden',
      piprop: 'thumbnail|name',
      pithumbsize: '500',
      pilicense: 'free',
    });
    const meta = response.query.pages[0];
    if (meta.missing !== undefined || meta.invalid !== undefined)
      throw new RejectedArticle('missing article');
    const categories = (meta.categories ?? []).map((c: any) => c.title as string);
    while (response.continue) {
      response = await this.action({
        titles: meta.title,
        prop: 'categories',
        cllimit: 'max',
        clshow: '!hidden',
        ...response.continue,
      });
      categories.push(...(response.query.pages[0].categories ?? []).map((c: any) => c.title));
    }
    const page = await this.http.json(
      'https://en.wikipedia.org/w/rest.php/v1/page/' +
        encodeURIComponent(meta.title) +
        '/with_html',
    );
    if (page.id !== meta.pageid || page.title !== meta.title)
      throw Error('Page identity changed during ingestion; retry');
    const clean = cleanArticle(page.html);
    const reasons = filterArticle(meta, clean, this.config);
    if (reasons.length) throw new RejectedArticle(reasons.join('; '));
    let image: Source['image'] = null;
    if (
      meta.thumbnail?.source &&
      /^https:\/\/upload\.wikimedia\.org\//.test(meta.thumbnail.source) &&
      meta.pageimage
    ) {
      let info: any = {};
      try {
        const result = await this.action({
          titles: 'File:' + meta.pageimage,
          prop: 'imageinfo',
          iiprop: 'url|extmetadata',
        });
        info = result.query.pages[0]?.imageinfo?.[0] ?? {};
      } catch {
        /* Attribution can be unavailable; preserve null instead of guessing. */
      }
      const ext = info.extmetadata ?? {};
      const plain = (v: any) => (v ? load(v).text().trim() : null);
      image = {
        url: meta.thumbnail.source,
        fileName: meta.pageimage,
        attribution: plain(ext.Artist?.value),
        license: plain(ext.LicenseShortName?.value),
        licenseUrl: ext.LicenseUrl?.value ?? null,
        descriptionUrl: info.descriptionurl ?? null,
      };
    }
    return sourceSchema.parse({
      pageId: meta.pageid,
      title: page.title,
      url: meta.fullurl,
      revisionId: page.latest.id,
      wikidataId: meta.pageprops?.wikibase_item ?? null,
      summary: clean.text.split('\n\n')[0],
      wordCount: clean.wordCount,
      text: clean.text,
      categories,
      fetchedAt: new Date().toISOString(),
      image,
      textLicense: 'CC BY-SA 4.0; https://creativecommons.org/licenses/by-sa/4.0/',
      discovery,
    });
  }
  async pageviews(source: Source, now = new Date()): Promise<Views> {
    const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    for (let delay = 0; delay <= this.config.ingestion.pageviewDelayRetries; delay++) {
      const end = new Date(+midnight - (delay + 1) * 86400000),
        start = new Date(+end - (this.config.ingestion.pageviewDays - 1) * 86400000);
      let items: any[] = [];
      try {
        items =
          (
            await this.http.json(
              `${analytics}/per-article/en.wikipedia.org/all-access/user/${encodeURIComponent(source.title.replaceAll(' ', '_'))}/daily/${stamp(start)}/${stamp(end)}`,
            )
          ).items ?? [];
      } catch (e) {
        if (!(e instanceof HttpError && e.status === 404)) throw e;
      }
      const daily = new Map(items.map((i) => [String(i.timestamp), i.views]));
      const complete =
        daily.size === this.config.ingestion.pageviewDays &&
        Array.from({ length: this.config.ingestion.pageviewDays }, (_, i) =>
          stamp(new Date(+start + i * 86400000)),
        ).every((day) => daily.has(day) && Number.isInteger(daily.get(day)) && daily.get(day) >= 0);
      const total = complete ? [...daily.values()].reduce((a, b) => a + b, 0) : null;
      const result = viewsSchema.parse({
        pageId: source.pageId,
        title: source.title,
        status: complete ? 'complete' : 'missing',
        total,
        average: total === null ? null : total / this.config.ingestion.pageviewDays,
        start: iso(start),
        end: iso(end),
        days: this.config.ingestion.pageviewDays,
        fetchedAt: new Date().toISOString(),
      });
      if (complete || delay === this.config.ingestion.pageviewDelayRetries) return result;
    }
    throw Error('Unreachable pageview state');
  }
  async random(count: number) {
    const titles = new Set<string>();
    let attempts = 0;
    while (titles.size < count && attempts++ < Math.ceil(count / 20) + 5) {
      const data = await this.action({
        list: 'random',
        rnnamespace: '0',
        rnfilterredir: 'nonredirects',
        rnlimit: String(Math.min(20, count - titles.size)),
      });
      for (const p of data.query.random) titles.add(p.title);
    }
    return [...titles];
  }
  async popular(count: number, now = new Date()) {
    for (let delay = 1; delay <= 4; delay++) {
      const day = iso(new Date(+now - delay * 86400000)).replaceAll('-', '/');
      try {
        const data = await this.http.json(`${analytics}/top/en.wikipedia.org/all-access/${day}`);
        return data.items[0].articles
          .map((p: any) => p.article.replaceAll('_', ' '))
          .filter((t: string) => !t.includes(':') && t !== 'Main Page')
          .slice(0, count) as string[];
      } catch (e) {
        if (!(e instanceof HttpError && e.status === 404)) throw e;
      }
    }
    throw Error('Popular discovery unavailable');
  }
}
