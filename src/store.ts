import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import { resolve } from 'node:path';
import lockfile from 'proper-lockfile';
import type { Source, Views, Card, Question, Job } from './domain.js';
import type { rankPopulation } from './rarity.js';
import type { Config } from './config.js';
export type Catalogue = {
  schemaVersion: 1;
  sources: Record<string, Source>;
  aliases: Record<string, number>;
  views: Record<string, Views>;
  populations: Record<string, ReturnType<typeof rankPopulation>>;
  jobs: Record<string, Job>;
  cards: Record<string, Card>;
  published: Record<string, string>;
  questions: Record<string, Question>;
  configs: Record<string, Config>;
  quarantined: Record<string, string>;
};
const empty = (): Catalogue => ({
  schemaVersion: 1,
  sources: {},
  aliases: {},
  views: {},
  populations: {},
  jobs: {},
  cards: {},
  published: {},
  questions: {},
  configs: {},
  quarantined: {},
});
/** Single offline writer, unlimited readers. Atomic replacement keeps readers on a complete snapshot. */
export class CatalogueStore {
  readonly directory: string;
  readonly path: string;
  data: Catalogue;
  constructor(
    directory = 'data/catalogue',
    readonly readOnly = false,
  ) {
    this.directory = resolve(directory);
    this.path = resolve(directory, 'catalogue.json');
    this.data = this.read();
  }
  private read(): Catalogue {
    if (!existsSync(this.path)) return empty();
    const data = JSON.parse(readFileSync(this.path, 'utf8'));
    if (data.schemaVersion !== 1) throw Error('Unsupported catalogue schema');
    data.quarantined ??= {};
    return data;
  }
  refresh() {
    this.data = this.read();
  }
  async withWriter<T>(fn: () => Promise<T>): Promise<T> {
    if (this.readOnly) throw Error('Read-only catalogue');
    mkdirSync(this.directory, { recursive: true });
    const release = await lockfile.lock(this.directory, { retries: 0, stale: 120000 });
    try {
      this.refresh();
      return await fn();
    } finally {
      await release();
    }
  }
  save() {
    if (this.readOnly) throw Error('Read-only catalogue');
    mkdirSync(this.directory, { recursive: true });
    const tmp = this.path + `.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 });
    const fd = openSync(tmp, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path);
  }
  source(key: string) {
    const source = this.data.sources[key];
    if (!source) throw Error(`Missing source ${key}`);
    return source;
  }
  putSource(source: Source, alias: string) {
    const key = `${source.pageId}:${source.revisionId}`;
    this.data.sources[key] ??= source;
    this.data.aliases[alias.toLowerCase()] = source.pageId;
    this.data.aliases[source.title.toLowerCase()] = source.pageId;
    return key;
  }
  putQuestion(q: Question) {
    const prior = this.data.questions[q.id];
    if (prior && JSON.stringify(prior) !== JSON.stringify(q)) throw Error('Question ID collision');
    this.data.questions[q.id] = q;
  }
  export(path: string, includeAnswers = false) {
    const cards = Object.values(this.data.published).map((id) => {
      const card = this.data.cards[id]!;
      const source = this.source(card.sourceKey);
      return {
        card,
        wikipedia: { ...source, text: undefined },
        pageviews: this.data.populations[card.rarityAssignment.populationId]?.members.find(
          (v) => v.pageId === card.pageId,
        ),
        ...(includeAnswers ? { trivia: card.questionIds.map((q) => this.data.questions[q]) } : {}),
      };
    });
    writeFileSync(
      path,
      JSON.stringify({ schemaVersion: 1, serverOnly: includeAnswers, cards }, null, 2) + '\n',
      { mode: includeAnswers ? 0o600 : 0o644 },
    );
  }
}
