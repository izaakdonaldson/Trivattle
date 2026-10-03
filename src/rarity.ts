import { hash, type Assignment, type Views } from './domain.js';
import type { Config } from './config.js';
export function rankPopulation(views: Views[], config: Config, diverse: boolean) {
  const unique = [
    ...new Map(
      views.filter((v) => v.status === 'complete' && v.total !== null).map((v) => [v.pageId, v]),
    ).values(),
  ].sort((a, b) => b.total! - a.total! || a.pageId - b.pageId);
  if (unique.length < config.rarity.minPopulation)
    throw Error(
      `Rarity requires ${config.rarity.minPopulation} eligible candidates with complete pageviews`,
    );
  if (!diverse) throw Error('Rarity requires random candidates and curated or popular seeds');
  if (new Set(unique.map((v) => v.start + v.end)).size !== 1)
    throw Error('Rarity reference population must share a pageview period');
  const populationId = hash({ version: config.rarity, views: unique });
  const assignments: Record<string, Assignment> = {};
  unique.forEach((v) => {
    const rank = unique.findIndex((x) => x.total === v.total);
    const ties = unique.filter((x) => x.total === v.total).length;
    const percentile = (rank + (ties - 1) / 2) / unique.length;
    assignments[v.pageId] = {
      rarity: config.rarity.tiers.find(([, cutoff]) => percentile < cutoff)![0],
      score: v.total!,
      percentile,
      version: config.rarity.version,
      populationId,
    };
  });
  return {
    id: populationId,
    createdAt: new Date().toISOString(),
    config: config.rarity,
    members: unique,
    assignments,
  };
}
