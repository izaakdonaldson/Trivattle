import { useEffect, useRef, useState } from 'react';
import { Sparkles, PackageOpen } from 'lucide-react';
import type { Opening, PackInfo } from '../../../src/player/types';
import type { CardView } from '../../../src/battle/types';
import { Card, CardDetails } from '../Card';
import { api, message, requestId } from '../api';
export function PacksPage({ userId, onOpened }: { userId: string; onOpened: () => void }) {
  const [info, setInfo] = useState<PackInfo | null>(null),
    [result, setResult] = useState<Opening | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [shown, setShown] = useState(0),
    [skipped, setSkipped] = useState(false),
    [inspected, setInspected] = useState<CardView | null>(null),
    [history, setHistory] = useState<Opening[]>([]),
    [remaining, setRemaining] = useState<number | null>(null),
    [packNotice, setPackNotice] = useState('');
  const lastPacks = useRef<number | null>(null),
    loadSerial = useRef(0);
  const keyName = `trivattle-pack-${userId}`;
  const load = () => {
    const serial = ++loadSerial.current;
    api<PackInfo>('/api/me/packs')
      .then((v) => {
        if (serial !== loadSerial.current) return;
        if (lastPacks.current !== null && v.packs > lastPacks.current)
          setPackNotice('New free packs are ready!');
        lastPacks.current = v.packs;
        setInfo(v);
        setRemaining(v.nextPackAt === null ? null : Math.max(0, v.nextPackAt - v.serverTime));
      })
      .catch((e) => setError(message(e)));
    api<Opening[]>('/api/me/pack-openings')
      .then((v) => {
        if (serial === loadSerial.current) setHistory(v);
      })
      .catch((e) => setError(message(e)));
  };
  useEffect(() => {
    if (!info) return;
    const received = performance.now();
    let requested = false;
    const tick = () => {
      if (info.nextPackAt === null) {
        setRemaining(null);
        return;
      }
      const ms = Math.max(0, info.nextPackAt - info.serverTime - (performance.now() - received));
      setRemaining(ms);
      if (!ms && !requested && !document.hidden) {
        requested = true;
        load();
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [info]);
  useEffect(() => {
    const refresh = () => {
      if (!document.hidden) load();
    };
    const timer = setInterval(refresh, 30000);
    addEventListener('focus', refresh);
    addEventListener('trivattle:inventory', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      removeEventListener('focus', refresh);
      removeEventListener('trivattle:inventory', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);
  async function open(recover = false) {
    setBusy(true);
    setError('');
    setPackNotice('');
    const key = localStorage.getItem(keyName) ?? requestId();
    localStorage.setItem(keyName, key);
    try {
      const value = await api<Opening>('/api/me/pack-openings', {}, { 'Idempotency-Key': key });
      setResult(value);
      const immediate = recover || matchMedia('(prefers-reduced-motion: reduce)').matches;
      setSkipped(immediate);
      setShown(immediate ? 1 : 0);
      localStorage.removeItem(keyName);
      onOpened();
      load();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    load();
    if (localStorage.getItem(keyName)) void open(true);
  }, []);
  useEffect(() => {
    if (!result || shown !== 0) return;
    const timer = setTimeout(() => setShown((n) => Math.min(5, n + 1)), 500);
    return () => clearTimeout(timer);
  }, [result, shown]);
  return (
    <main className="app-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">A WORLD OF POSSIBILITY</p>
          <h1>Something remarkable inside.</h1>
          <p className="muted">Five cards. Five independent chances. A new piece of the world.</p>
        </div>
        <span className="balance">
          <PackageOpen size={18} />
          {info?.packs ?? '…'} packs remaining
        </span>
      </div>
      <p className="pack-countdown" role="status">
        Your packs: {info?.packs ?? '…'} / {info?.capacity ?? 3} ·{' '}
        {remaining === null
          ? 'Packs Full — Open one to begin regenerating!'
          : `Next free pack: ${String(Math.floor(Math.ceil(remaining / 1000) / 60)).padStart(2, '0')}:${String(Math.ceil(remaining / 1000) % 60).padStart(2, '0')}`}
      </p>
      {packNotice && (
        <p className="notice" role="status">
          {packNotice}
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
          <button disabled={busy} onClick={() => open(true)}>
            Retry request
          </button>
        </p>
      )}
      {!result ? (
        <section className="pack-stage">
          <Booster />
          <button
            className="primary pack-open"
            disabled={busy || !info?.available || !info.packs}
            onClick={() => open()}
          >
            {busy ? 'Opening your pack…' : 'Open pack'}
            <Sparkles size={17} />
          </button>
          {info && !info.available && (
            <p role="alert">
              Pack unavailable: missing playable {info.missing.join(', ')} cards. No pack will be
              spent.
            </p>
          )}
        </section>
      ) : (
        <section className={`pack-results ${skipped ? 'skip-reveal' : ''}`}>
          {shown === 0 && !skipped && (
            <div className="pack-burst">
              <Booster opening />
            </div>
          )}
          <div className="section-top">
            <h2>{shown < 5 ? 'Meet your new discoveries…' : 'Your collection just grew.'}</h2>
            <span aria-live="polite">
              {shown <= 5 ? `Card ${shown || 1} of 5` : 'All five discoveries'}
            </span>
          </div>
          <div className={`card-grid reveal-grid ${shown <= 5 ? 'single-reveal' : ''}`}>
            {result.cards
              .filter((_, i) => shown > 5 || i === shown - 1)
              .map((c) => (
                <div
                  key={c.id}
                  className={`reveal-wrap ${'revealed'} reveal-${c.card?.rarity ?? 'common'}`}
                >
                  {c.card ? (
                    <Card card={c.card} onInspect={() => setInspected(c.card)} />
                  ) : (
                    <div className="card-back" aria-label={'Card definition unavailable'}>
                      ✦<small>{'Unavailable'}</small>
                    </div>
                  )}
                </div>
              ))}
          </div>
          <div className="pack-actions">
            {shown > 0 && shown <= 5 && (
              <button className="primary" onClick={() => setShown((n) => n + 1)}>
                {shown === 5 ? 'Show all cards' : 'Next card'}
              </button>
            )}
            {shown > 5 && <a href="#/collection">View collection →</a>}
            {shown > 5 && (
              <button
                className="primary"
                disabled={!info?.packs || !info.available}
                onClick={() => {
                  setResult(null);
                  setShown(0);
                }}
              >
                Open another pack
              </button>
            )}
          </div>
        </section>
      )}
      <div className="pack-odds">
        <span>
          Odds per card{info?.policy === 'renormalize' ? ' · adjusted to available pools' : ''}
        </span>
        {Object.entries(info?.odds ?? {}).map(([r, p]) => (
          <span key={r} className={`odds-${r}`}>
            {r} <b>{(p * 100).toFixed((p * 100) % 1 ? 1 : 0)}%</b>
          </span>
        ))}
      </div>
      {history.length > 0 && (
        <details className="opening-history">
          <summary>Recent openings</summary>
          {history.map((h) => (
            <button
              key={h.id}
              onClick={() => {
                setResult(h);
                setSkipped(true);
                setShown(6);
              }}
            >
              View pack · {h.id.slice(0, 8)}
            </button>
          ))}
        </details>
      )}
      {inspected && <CardDetails card={inspected} onClose={() => setInspected(null)} />}
    </main>
  );
}

function Booster({ opening = false }: { opening?: boolean }) {
  return (
    <div className={`booster ${opening ? 'opening' : ''}`}>
      <span className="booster-seal" />
      <Sparkles size={42} />
      <strong>trivattle</strong>
      <span>THE WORLD’S KNOWLEDGE</span>
      <div className="pack-emblem">W</div>
      <b>DISCOVERY PACK</b>
      <small>5 COLLECTIBLE CARDS</small>
    </div>
  );
}
