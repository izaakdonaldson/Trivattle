import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import type { CardView } from '../../../src/battle/types';
import type { Collection, Owned } from '../../../src/player/types';
import { Card, CardDetails } from '../Card';
import { api, message } from '../api';
export function OwnedGrid({
  select,
  selected = [],
  refresh = 0,
  catalogue = false,
  tradeId,
  selectionDisabled = false,
}: {
  select?: (c: Owned) => void;
  selected?: string[];
  refresh?: number;
  catalogue?: boolean;
  tradeId?: string;
  selectionDisabled?: boolean;
}) {
  const [q, setQ] = useState(''),
    [type, setType] = useState(''),
    [rarity, setRarity] = useState(''),
    [sort, setSort] = useState('rarity'),
    [direction, setDirection] = useState('desc'),
    [page, setPage] = useState(1),
    [data, setData] = useState<Collection | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [inspected, setInspected] = useState<CardView | null>(null),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    const invalidate = () => setRetry((n) => n + 1);
    addEventListener('trivattle:inventory', invalidate);
    const timer = setTimeout(() => {
      api<Collection>(
        `${catalogue ? '/api/catalogue' : '/api/me/collection'}?${new URLSearchParams({ q, type, rarity, sort, direction, page: String(page), grouped: 'false' })}`,
      )
        .then((v) => {
          if (active) {
            setData(v);
            setError('');
          }
        })
        .catch((e) => {
          if (active) setError(message(e));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 180);
    return () => {
      active = false;
      removeEventListener('trivattle:inventory', invalidate);
      clearTimeout(timer);
    };
  }, [q, type, rarity, sort, direction, page, refresh, catalogue, !!select, retry]);
  const reset = (fn: () => void) => {
    fn();
    setPage(1);
  };
  return (
    <section>
      <div className="filters collection-filters">
        <label className="search">
          <Search size={16} />
          <input
            aria-label={catalogue ? 'Search all cards' : 'Search owned cards'}
            placeholder={catalogue ? 'Search the whole game…' : 'Search your collection…'}
            value={q}
            onChange={(e) => reset(() => setQ(e.target.value))}
          />
        </label>
        <select
          aria-label="Filter by type"
          value={type}
          onChange={(e) => reset(() => setType(e.target.value))}
        >
          <option value="">All types</option>
          {['science', 'nature', 'history', 'technology', 'culture', 'geography', 'basic'].map(
            (t) => (
              <option key={t}>{t}</option>
            ),
          )}
        </select>
        <select
          aria-label="Filter by rarity"
          value={rarity}
          onChange={(e) => reset(() => setRarity(e.target.value))}
        >
          <option value="">All rarities</option>
          {['common', 'uncommon', 'rare', 'epic', 'legendary'].map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
        <select
          aria-label="Sort cards"
          value={sort}
          onChange={(e) => reset(() => setSort(e.target.value))}
        >
          {!catalogue && <option value="date">Acquisition date</option>}
          <option value="type">Type</option>
          <option value="name">Alphabetical</option>
          <option value="rarity">Rarity</option>
        </select>
        <button
          onClick={() => reset(() => setDirection(direction === 'asc' ? 'desc' : 'asc'))}
          aria-label="Reverse sort order"
        >
          {direction === 'asc' ? '↑ Ascending' : '↓ Descending'}
        </button>
      </div>
      <p className="muted" role="status">
        {loading
          ? 'Finding your cards…'
          : `${data?.copies ?? 0} ${catalogue ? 'cards in the game' : 'owned copies'} · ${data?.total ?? 0} results`}
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
          <button onClick={() => setRetry((n) => n + 1)}>Retry</button>
        </p>
      )}
      <div className="card-grid owned-grid">
        {data?.cards.map((c) => (
          <div className="owned-item" key={c.id}>
            {c.card ? (
              <Card
                card={c.card}
                selectOnCard={!!select}
                hideSelectButton={!!select}
                onInspect={() => setInspected(c.card)}
                onSelect={select ? () => select(c) : undefined}
                selected={selected.includes(c.id)}
                disabled={
                  selectionDisabled ||
                  !c.playable ||
                  selected.includes(c.id) ||
                  (!!select && !!c.reservedTradeId && c.reservedTradeId !== tradeId) ||
                  (!!tradeId && !!c.battleCommitted)
                }
              >
                {selected.includes(c.id)
                  ? `In slot ${selected.indexOf(c.id) + 1}`
                  : 'Add to selection'}
              </Card>
            ) : (
              <div className="empty">Definition unavailable</div>
            )}
            <div className="copy-meta">
              {!catalogue && (
                <span title={c.id}>
                  Copy {c.id.slice(0, 8)} · {new Date(c.acquiredAt).toLocaleDateString()}
                </span>
              )}
              {select && selected.includes(c.id) && (
                <strong>
                  {tradeId ? 'In your offer' : 'In slot ' + (selected.indexOf(c.id) + 1)}
                </strong>
              )}
              {!!select && c.reservedTradeId && c.reservedTradeId !== tradeId && (
                <span>Reserved for another trade</span>
              )}
              {tradeId && c.battleCommitted && <span>Committed to a battle</span>}
              {!c.playable && <span>Card unavailable</span>}
            </div>
          </div>
        ))}
      </div>
      {!loading && !data?.cards.length && (
        <div className="empty">
          <h3>No cards found</h3>
          <p>
            {catalogue ? (
              'Try different filters.'
            ) : (
              <>
                Open your first pack to start collecting. <a href="#/packs">Open packs →</a>
              </>
            )}
          </p>
        </div>
      )}
      <div className="pagination">
        <button disabled={page === 1 || loading} onClick={() => setPage(page - 1)}>
          ← Previous
        </button>
        <span>
          Page {page} of {Math.max(1, Math.ceil((data?.total ?? 0) / 20))}
        </span>
        <button
          disabled={loading || page * 20 >= (data?.total ?? 0)}
          onClick={() => setPage(page + 1)}
        >
          Next →
        </button>
      </div>
      {inspected && <CardDetails card={inspected} onClose={() => setInspected(null)} />}
    </section>
  );
}
export function CollectionPage({ refresh }: { refresh: number }) {
  return (
    <main className="app-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">YOUR OWN CORNER OF THE WORLD</p>
          <h1>The collection.</h1>
          <p className="muted">
            Every copy has a story. Which five will you bring to your next battle?
          </p>
        </div>
        <a className="button-link primary" href="#/packs">
          Open packs →
        </a>
      </div>
      <OwnedGrid refresh={refresh} />
    </main>
  );
}

export function CataloguePage() {
  return (
    <main className="app-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">THE WHOLE WORLD, ONE CARD AT A TIME</p>
          <h1>All cards.</h1>
          <p className="muted">
            Explore every playable card in Trivattle, including the ones you haven’t collected yet.
          </p>
        </div>
      </div>
      <OwnedGrid catalogue />
    </main>
  );
}
