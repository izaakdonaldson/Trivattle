import { useCallback, useEffect, useRef, useState } from 'react';
import type { TradeList, TradeView } from '../../../src/player/social-types';
import type { CardView } from '../../../src/battle/types';
import { Card, CardDetails, Dialog } from '../Card';
import { OwnedGrid } from './CollectionPage';
import { api, message, requestId } from '../api';
const terminal = (t: TradeView) => ['COMPLETED', 'CANCELLED', 'EXPIRED'].includes(t.state);
export function TradesPage({ history = false }: { history?: boolean }) {
  const [data, setData] = useState<TradeList | null>(null),
    [error, setError] = useState(''),
    [page, setPage] = useState(1);
  const load = useCallback(() => {
    api<TradeList>('/api/trades?history=' + history + '&page=' + page)
      .then(setData)
      .catch((e) => setError(message(e)));
  }, [history, page]);
  useEffect(() => {
    load();
    addEventListener('trivattle:trades', load);
    addEventListener('focus', load);
    return () => {
      removeEventListener('trivattle:trades', load);
      removeEventListener('focus', load);
    };
  }, [load]);
  return (
    <main className="app-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">A FAIR EXCHANGE</p>
          <h1>{history ? 'Trade history.' : 'Trades.'}</h1>
          <p>Exchange cards with friends. Both players approve the exact same offers.</p>
        </div>
        <a href={history ? '#/trades' : '#/trades/history'}>
          {history ? 'Active trades' : 'Trade history'} →
        </a>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!data ? (
        <p role="status">Loading trades…</p>
      ) : !data.items.length ? (
        <div className="empty">
          No {history ? 'past' : 'active'} trades.{' '}
          <a href="#/friends">Find a friend to trade with →</a>
        </div>
      ) : (
        data.items.map((t) => (
          <a className="social-row trade-link" href={'#/trades/' + t.id} key={t.id}>
            <span>
              <strong>{t.players.find((p) => p.player.id !== t.self)?.player.name}</strong>
              <small>
                {t.state === 'INVITED'
                  ? t.invitedBy === t.self
                    ? 'Invitation sent'
                    : 'Trade invitation received'
                  : t.state.toLowerCase()}{' '}
                · {new Date(t.completedAt ?? t.createdAt).toLocaleString()}
              </small>
            </span>
            <span>View trade →</span>
          </a>
        ))
      )}
      {data && (
        <div className="pagination">
          <button disabled={page === 1} onClick={() => setPage(page - 1)}>
            Previous
          </button>
          <span>Page {page}</span>
          <button disabled={page * data.pageSize >= data.total} onClick={() => setPage(page + 1)}>
            Next
          </button>
        </div>
      )}
    </main>
  );
}
export function TradePage({ id, connected }: { id: string; connected: boolean }) {
  const [trade, setTrade] = useState<TradeView | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [inspect, setInspect] = useState<CardView | null>(null),
    [review, setReview] = useState<number | null>(null),
    [remaining, setRemaining] = useState(0);
  const alive = useRef(true),
    serial = useRef(0);
  const accept = useCallback((v: TradeView) => {
    if (alive.current) setTrade((old) => (old && old.revision > v.revision ? old : v));
  }, []);
  const load = useCallback(async () => {
    const n = ++serial.current;
    try {
      const v = await api<TradeView>('/api/trades/' + id);
      if (n === serial.current) accept(v);
    } catch (e) {
      if (alive.current) setError(message(e));
    }
  }, [id, accept]);
  useEffect(() => {
    alive.current = true;
    void load();
    const refresh = () => void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 15000);
    addEventListener('trivattle:trades', refresh);
    addEventListener('focus', refresh);
    return () => {
      alive.current = false;
      clearInterval(timer);
      removeEventListener('trivattle:trades', refresh);
      removeEventListener('focus', refresh);
    };
  }, [load]);
  useEffect(() => {
    if (review !== null && trade?.revision !== review) {
      setReview(null);
      setError('Trade changed. Review the latest offers before confirming.');
    }
  }, [trade?.revision, review]);
  useEffect(() => {
    if (!trade || terminal(trade)) return;
    const start = performance.now();
    let refreshed = false;
    const tick = () => {
      const ms = Math.max(0, trade.expiresAt - trade.serverTime - (performance.now() - start));
      setRemaining(ms);
      if (!ms && !refreshed) {
        refreshed = true;
        void load();
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [trade, load]);
  async function command(extra: object) {
    if (!trade) return;
    setBusy(true);
    setError('');
    setReview(null);
    try {
      accept(
        await api<TradeView>('/api/trades/' + id, {
          ...extra,
          revision: trade.revision,
          requestId: requestId(),
        }),
      );
      dispatchEvent(new Event('trivattle:inventory'));
    } catch (e) {
      setError(message(e));
      await load();
      dispatchEvent(new Event('trivattle:inventory'));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  if (!trade)
    return (
      <main className="app-page">
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : (
          <p role="status">Loading trade…</p>
        )}
        <a href="#/trades">Back to trades</a>
      </main>
    );
  const own = trade.players.find((p) => p.player.id === trade.self)!,
    other = trade.players.find((p) => p.player.id !== trade.self)!;
  const editable = trade.state === 'NEGOTIATING' && !busy && connected;
  const canConfirm =
    editable &&
    own.connected &&
    other.connected &&
    !own.confirmed &&
    own.cards.length > 0 &&
    other.cards.length > 0;
  const offer = (p: typeof own, isOwn: boolean) => (
    <section className="trade-offer" aria-label={isOwn ? 'Your offer' : 'Their offer'}>
      <h2>
        {isOwn ? 'Your offer' : other.player.name + '’s offer'} <small>{p.cards.length}/5</small>
      </h2>
      <p className={p.confirmed ? 'confirmed' : ''}>
        {terminal(trade)
          ? trade.state === 'COMPLETED'
            ? 'Exchanged'
            : 'Trade ended'
          : p.confirmed
            ? 'Confirmed ✓'
            : isOwn
              ? 'Waiting for your confirmation'
              : 'Waiting for their confirmation'}
      </p>
      <div className="card-grid">
        {p.cards.map((c) => (
          <div key={c.id}>
            {c.card ? (
              <Card card={c.card} onInspect={() => setInspect(c.card)} />
            ) : (
              <div className="empty">Definition unavailable</div>
            )}
            <small>Copy {c.id.slice(0, 8)}</small>
            {isOwn && trade.state === 'NEGOTIATING' && (
              <button
                disabled={!editable}
                aria-label={'Remove offered ' + (c.card?.name ?? 'card')}
                onClick={() =>
                  void command({
                    action: 'offer',
                    instances: own.cards.filter((v) => v.id !== c.id).map((v) => v.id),
                  })
                }
              >
                Remove
              </button>
            )}
          </div>
        ))}
      </div>
      {!p.cards.length && <div className="empty">No cards offered yet</div>}
    </section>
  );
  return (
    <main className="app-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">A FAIR EXCHANGE</p>
          <h1>Trade with {other.player.name}.</h1>
          <p role="status">
            {trade.state === 'COMPLETED'
              ? 'Trade completed'
              : trade.state === 'CANCELLED'
                ? 'Trade cancelled'
                : trade.state === 'EXPIRED'
                  ? 'Trade expired'
                  : trade.state === 'INVITED'
                    ? 'Trade invitation'
                    : own.confirmed
                      ? 'You confirmed — waiting for your friend'
                      : 'Review both offers before confirming.'}
          </p>
        </div>
        <a href="#/trades">All trades →</a>
      </div>
      {!terminal(trade) && (
        <p className="muted">
          {connected && other.connected
            ? 'Both players connected'
            : 'Waiting for connection — confirmations reset if either player disconnects.'}{' '}
          · Expires in {Math.ceil(remaining / 60000)} min · Offer revision {trade.offerRevision}
        </p>
      )}
      {(error || trade.error) && (
        <p className="error" role="alert">
          {error || trade.error}
        </p>
      )}
      {trade.state === 'INVITED' ? (
        <section className="trade-invitation">
          <h2>
            {trade.invitedBy === trade.self ? 'Invitation sent' : 'You received a trade invitation'}
          </h2>
          <p>Exchange one to five cards each. No cards move until you both confirm.</p>
          {trade.invitedBy !== trade.self && (
            <>
              <button
                className="primary"
                disabled={busy || !connected}
                onClick={() => void command({ action: 'accept' })}
              >
                Accept invitation
              </button>
              <button disabled={busy} onClick={() => void command({ action: 'reject' })}>
                Decline invitation
              </button>
            </>
          )}
        </section>
      ) : (
        <div className="trade-columns">
          {offer(own, true)}
          {offer(other, false)}
        </div>
      )}
      <div className="trade-controls">
        {trade.state === 'NEGOTIATING' && (
          <button
            className="primary"
            disabled={!canConfirm}
            onClick={() => setReview(trade.revision)}
          >
            {own.confirmed ? 'You confirmed' : 'Review exchange'}
          </button>
        )}
        {!terminal(trade) && (
          <button
            disabled={busy || trade.state === 'SETTLING'}
            onClick={() => void command({ action: 'cancel' })}
          >
            Cancel trade
          </button>
        )}
        {terminal(trade) && (
          <>
            <a href="#/collection">View collection →</a>
            <a href="#/trades/history">Trade history →</a>
          </>
        )}
      </div>
      {trade.state === 'NEGOTIATING' && (
        <section className="trade-picker">
          <h2>Add cards from your collection</h2>
          <p>Select up to five individual copies. Editing an offer clears both confirmations.</p>
          <OwnedGrid
            tradeId={trade.id}
            selected={own.cards.map((c) => c.id)}
            refresh={trade.revision}
            select={(c) => {
              if (editable && own.cards.length < 5)
                void command({ action: 'offer', instances: [...own.cards.map((v) => v.id), c.id] });
            }}
            selectionDisabled={!editable || own.cards.length >= 5}
          />
        </section>
      )}
      {review !== null && (
        <Dialog title="Confirm this exact exchange" onClose={() => setReview(null)}>
          <p>
            You give {own.cards.length} card(s) and receive {other.cards.length} card(s).
          </p>
          <div className="trade-review">
            {[own, other].map((p, i) => (
              <section key={p.player.id}>
                <h3>{i === 0 ? 'You give' : 'You receive'}</h3>
                {p.cards.map((c) => (
                  <div key={c.id}>
                    {c.card ? <Card card={c.card} onInspect={() => setInspect(c.card)} /> : null}
                    <small>Copy {c.id.slice(0, 8)}</small>
                  </div>
                ))}
              </section>
            ))}
          </div>
          <p>Any offer change requires a new confirmation from both players.</p>
          <button
            className="primary"
            disabled={!canConfirm || review !== trade.revision}
            onClick={() => void command({ action: 'confirm', offerRevision: trade.offerRevision })}
          >
            Confirm this exchange
          </button>
        </Dialog>
      )}
      {inspect && <CardDetails card={inspect} onClose={() => setInspect(null)} />}
    </main>
  );
}
