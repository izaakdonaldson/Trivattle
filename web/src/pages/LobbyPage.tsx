import { useEffect, useState } from 'react';
import { Copy, Swords, ArrowLeft, ArrowRight, X } from 'lucide-react';
import type { LobbyView, Owned } from '../../../src/player/types';
import type { CardView } from '../../../src/battle/types';
import { Card, CardDetails } from '../Card';
import { OwnedGrid } from './CollectionPage';
export type Send = (event: string, extra?: Record<string, unknown>) => Promise<boolean>;
export function LobbyPage({ room, send, busy }: { room: LobbyView; send: Send; busy: boolean }) {
  const [draft, setDraft] = useState<(Owned | null)[]>(room.selection),
    [inspect, setInspect] = useState<CardView | null>(null),
    [replace, setReplace] = useState<number | null>(null),
    [copied, setCopied] = useState(false);
  const own = room.players.find((p) => p.slot === room.self)!,
    opponent = room.players.find((p) => p.slot !== room.self);
  useEffect(() => {
    setDraft(room.selection);
  }, [room.id, JSON.stringify(room.selection.map((c) => c?.id ?? null))]);
  const selected = draft.map((c) => c?.id ?? '');
  const dirty = JSON.stringify(selected) !== JSON.stringify(room.selection.map((c) => c?.id ?? ''));
  const change = (next: (Owned | null)[]) => {
    setDraft(next);
  };
  const move = (i: number, delta: number) => {
    const next = [...draft];
    [next[i], next[i + delta]] = [next[i + delta], next[i]];
    change(next);
  };
  return (
    <main className="app-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">A FRIENDLY RIVALRY</p>
          <h1>Your battle room.</h1>
          <p className="muted">Your five stay private until both players are ready.</p>
        </div>
        <div className="join-code">
          <small>JOIN CODE</small>
          <strong>{room.code}</strong>
          <button
            aria-label="Copy invitation"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(`${location.origin}/#/join/${room.code}`);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            <Copy size={15} />
            {copied ? 'Copied' : 'Copy invite'}
          </button>
        </div>
      </div>
      <div className="players-strip">
        {room.players.map((p) => (
          <div key={p.slot}>
            <span className={`presence ${p.connected ? 'connected' : ''}`} />
            <b>
              {p.name}
              {p.slot === room.self ? ' (you)' : ''}
            </b>
            <span>{p.ready ? 'Ready' : p.connected ? 'Choosing cards' : 'Reconnecting…'}</span>
          </div>
        ))}
        {!opponent && <div>Waiting for your opponent to join…</div>}
      </div>
      {room.paused && (
        <p role="status" className="notice">
          Waiting for a connection. Your selections are safe.
        </p>
      )}
      <section className="private-opponent">
        <span className="eyebrow">{opponent?.name ?? 'OPPONENT'} · PRIVATE SELECTION</span>
        <div className="mini-backs">
          {Array.from({ length: 5 }, (_, i) => (
            <div className="card-back" key={i}>
              ✦
            </div>
          ))}
        </div>
      </section>
      <div className="section-top">
        <div>
          <h2>Your five.</h2>
          <p className="muted">Arrange positions 1–5. Splash hits adjacent positions.</p>
        </div>
        <button disabled={busy} onClick={() => send('lobby:leave')}>
          Leave lobby
        </button>
      </div>
      <div className="lobby-slots">
        {draft.map((c, i) => (
          <div key={i} className={`selection-slot ${replace === i ? 'replacing' : ''}`}>
            <span className="slot-number">POSITION {i + 1}</span>
            {c?.card ? (
              <Card card={c.card} onInspect={() => setInspect(c.card)} />
            ) : (
              <div className="empty-slot">
                {i + 1}
                <small>Choose a card below</small>
              </div>
            )}
            <div className="slot-controls">
              <button
                aria-label={`Move slot ${i + 1} left`}
                disabled={own.ready || busy || i === 0}
                onClick={() => move(i, -1)}
              >
                <ArrowLeft size={14} />
              </button>
              <button
                aria-label={`Move slot ${i + 1} right`}
                disabled={own.ready || busy || i === 4}
                onClick={() => move(i, 1)}
              >
                <ArrowRight size={14} />
              </button>
              <button
                disabled={own.ready || busy}
                onClick={() => setReplace(replace === i ? null : i)}
              >
                {replace === i ? 'Cancel' : 'Replace'}
              </button>
              <button
                aria-label={`Remove slot ${i + 1}`}
                disabled={own.ready || busy || !c}
                onClick={() => change(draft.map((x, n) => (n === i ? null : x)))}
              >
                <X size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="ready-bar">
        <span>
          {draft.filter(Boolean).length}/5 selected ·{' '}
          {own.ready ? 'Locked and ready' : dirty ? 'Unsynced selection' : 'Selection synced'}
        </span>
        {own.ready ? (
          <button disabled={busy || room.paused} onClick={() => send('lobby:unready')}>
            Unready to edit
          </button>
        ) : (
          <>
            <button
              disabled={busy || !dirty || !opponent || room.paused}
              onClick={() => send('lobby:select', { selection: draft.map((c) => c?.id ?? null) })}
            >
              Sync selection
            </button>
            <button
              className="primary"
              disabled={busy || room.paused || !opponent || draft.some((c) => !c)}
              onClick={async () => {
                if (
                  dirty &&
                  !(await send('lobby:select', { selection: draft.map((c) => c?.id ?? null) }))
                )
                  return;
                await send('lobby:ready');
              }}
            >
              <Swords size={16} />
              Ready
            </button>
          </>
        )}
      </div>
      {!own.ready && opponent && (
        <>
          <h2 className="collection-label">Choose from your collection</h2>
          <OwnedGrid
            selected={selected}
            select={(c) => {
              if (own.ready) return;
              const i = replace ?? draft.findIndex((x) => !x);
              if (i < 0) return;
              change(draft.map((x, n) => (n === i ? c : x)));
              setReplace(null);
            }}
          />
        </>
      )}
      {inspect && <CardDetails card={inspect} onClose={() => setInspect(null)} />}
    </main>
  );
}
