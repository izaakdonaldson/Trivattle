import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Swords,
  Sparkles,
  ArrowRight,
  Search,
  Trophy,
  BookOpen,
  RotateCcw,
  Zap,
} from 'lucide-react';
import type {
  BattleView,
  CardView,
  CardsResponse,
  Unit,
  AttackCommand,
  AnswerCommand,
  BattleEvent,
} from '../../src/battle/types';
import { Card, CardDetails, Dialog } from './Card';
import './style.css';
async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(
    path,
    body === undefined
      ? undefined
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  const value = await res.json();
  if (!res.ok) throw Error(value.error ?? 'Unable to reach the battle server');
  return value;
}
const player = (id: string) => (id === 'player-1' ? 'Player 1' : 'Player 2');
type CommandInput =
  Omit<AttackCommand, 'revision' | 'commandId'> | Omit<AnswerCommand, 'revision' | 'commandId'>;
function App() {
  const [battle, setBattle] = useState<BattleView | null>(null),
    [catalogue, setCatalogue] = useState<CardsResponse | null>(null),
    [teams, setTeams] = useState<[CardView[], CardView[]]>([[], []]),
    [builder, setBuilder] = useState(0),
    [q, setQ] = useState(''),
    [type, setType] = useState(''),
    [rarity, setRarity] = useState(''),
    [page, setPage] = useState(1),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [inspected, setInspected] = useState<CardView | null>(null),
    [loading, setLoading] = useState(true),
    [ready, setReady] = useState(false),
    [feedback, setFeedback] = useState(false),
    [viewPlayer, setViewPlayer] = useState('player-1'),
    [attacker, setAttacker] = useState(''),
    [move, setMove] = useState(''),
    [target, setTarget] = useState(''),
    [events, setEvents] = useState<BattleEvent[]>([]),
    [playing, setPlaying] = useState(false),
    [displayHP, setDisplayHP] = useState<Record<string, number>>({}),
    [pulse, setPulse] = useState<BattleEvent | null>(null),
    [catalogueLoading, setCatalogueLoading] = useState(false);
  useEffect(() => {
    const id = localStorage.getItem('trivattle-match');
    if (!id) {
      setLoading(false);
      return;
    }
    api<BattleView>(`/api/battles/${id}`)
      .then((s) => {
        setBattle(s);
        setViewPlayer(s.currentPlayer);
        if (s.feedback) {
          setFeedback(true);
          setViewPlayer(s.events.findLast((e) => e.kind === 'attack')?.playerId ?? s.currentPlayer);
        }
      })
      .catch((e) => {
        setError(e.message);
        localStorage.removeItem('trivattle-match');
      })
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    if (battle) return;
    let active = true;
    setCatalogueLoading(true);
    const timer = setTimeout(
      () =>
        api<CardsResponse>(
          `/api/cards?${new URLSearchParams({ q, type, rarity, page: String(page) })}`,
        )
          .then((c) => {
            if (active) setCatalogue(c);
          })
          .catch((e) => {
            if (active) setError(e.message);
          })
          .finally(() => {
            if (active) setCatalogueLoading(false);
          }),
      180,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [q, type, rarity, page, battle]);
  useEffect(() => {
    if (!playing) return;
    let cancelled = false;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let timer: ReturnType<typeof setTimeout>;
    let index = 0;
    const next = () => {
      if (cancelled) return;
      const e = events[index++];
      if (!e) {
        setPlaying(false);
        setPulse(null);
        setDisplayHP({});
        return;
      }
      setPulse(e);
      if (e.subjectId && e.hp !== undefined)
        setDisplayHP((old) => ({ ...old, [e.subjectId!]: e.hp! }));
      timer = setTimeout(
        next,
        e.kind === 'attack'
          ? 1300
          : reduced
            ? 0
            : e.kind === 'damage' || e.kind === 'heal' || e.kind === 'passive'
              ? 220
              : 70,
      );
    };
    next();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [playing, events]);
  async function start(quick = false, rematch = false) {
    setBusy(true);
    setError('');
    try {
      const selected =
        rematch && battle
          ? battle.teams.map((t) => t.map((u) => u.card.versionId))
          : teams.map((t) => t.map((c) => c.versionId));
      const s = await api<BattleView>(
        '/api/battles',
        quick ? { quickStart: true } : { teams: selected },
      );
      localStorage.setItem('trivattle-match', s.id);
      setBattle(s);
      setViewPlayer(s.currentPlayer);
      setReady(false);
      setFeedback(false);
      setAttacker('');
      setMove('');
      setTarget('');
      setEvents([]);
      setDisplayHP({});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function submit(command: CommandInput) {
    if (!battle) return;
    setBusy(true);
    setError('');
    try {
      const s = await api<BattleView>(`/api/battles/${battle.id}/commands`, {
        ...command,
        revision: battle.revision,
        commandId: crypto.randomUUID(),
      });
      const previousAttack = battle.pending
        ? battle.events.findLast((e) => e.kind === 'attack')
        : undefined;
      const fresh = [
        ...(previousAttack ? [previousAttack] : []),
        ...s.events.filter((e) => e.id > battle.events.length),
      ];
      setBattle(s);
      setReady(false);
      if (s.phase !== 'ANSWERING_TRIVIA') {
        setDisplayHP(Object.fromEntries(battle.teams.flat().map((c) => [c.instanceId, c.hp])));
        setEvents(fresh);
        setPlaying(true);
        setFeedback(true);
      }
    } catch (e) {
      setError((e as Error).message); // Reconcile after a lost response without replaying a command.
      try {
        const s = await api<BattleView>(`/api/battles/${battle.id}`);
        if (s.revision !== battle.revision) {
          setBattle(s);
          setFeedback(!!s.feedback || s.phase === 'BATTLE_FINISHED');
          setReady(false);
        }
      } catch {
        /* Keep the existing board and visible error. */
      }
    } finally {
      setBusy(false);
    }
  }
  function continueTurn() {
    setFeedback(false);
    setReady(false);
    setViewPlayer(battle!.currentPlayer);
    setAttacker('');
    setMove('');
    setTarget('');
    setEvents([]);
  }
  function exit() {
    localStorage.removeItem('trivattle-match');
    setBattle(null);
    setFeedback(false);
    setReady(false);
    setError('');
  }
  function add(c: CardView) {
    setTeams((old) => {
      const copy: [CardView[], CardView[]] = [[...old[0]], [...old[1]]];
      if (copy[builder].length < 5) copy[builder].push(c);
      return copy;
    });
  }
  const units = battle?.teams.flat() ?? [],
    selected = units.find((c) => c.instanceId === attacker),
    selectedMove = selected?.card.attacks.find((a) => a.id === move),
    victim = units.find((c) => c.instanceId === target);
  const locked = busy || playing || feedback || battle?.phase !== 'SELECTING_ATTACK';
  function matchup(u: Unit) {
    if (!battle || !selectedMove) return '';
    const a = selectedMove.type,
      d = u.card.type,
      c = battle.rules.counters;
    const value =
      a === 'basic' || d === 'basic'
        ? 1
        : c[a] === d
          ? u.card.passive?.id === 'immune'
            ? 1
            : battle.rules.strong
          : c[d] === a
            ? battle.rules.weak
            : 1;
    return value > 1
      ? `Super effective ×${value}`
      : value < 1
        ? `Resisted ×${value}`
        : 'Neutral ×1';
  }
  async function inspectUnit(unit: Unit) {
    if (playing || feedback) return;
    try {
      const detail = await api<CardView>(
        `/api/battles/${battle!.id}/cards/${encodeURIComponent(unit.instanceId)}?playerId=${battle!.currentPlayer}`,
      );
      setInspected(detail);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function row(owner: string) {
    const team = battle!.teams[battle!.players.indexOf(owner)]!;
    const own = owner === viewPlayer;
    return (
      <section className={`team-zone ${own ? 'own' : 'opponent'}`}>
        <div className="team-label">
          <span className={`player-dot ${owner}`} />
          <b>{player(owner)}</b>
          <span>{own ? 'YOUR TEAM' : 'OPPOSING TEAM'}</span>
          <small>{team.filter((c) => c.hp > 0).length}/5 standing</small>
        </div>
        <div className="battle-row">
          {team.map((unit) => {
            const shown = { ...unit, hp: displayHP[unit.instanceId] ?? unit.hp };
            return (
              <div
                className={`battle-slot ${pulse?.subjectId === unit.instanceId ? `impact impact-${pulse.kind}` : ''}`}
                key={unit.instanceId}
              >
                <span className="position">0{unit.position + 1}</span>
                <Card
                  card={unit.card}
                  unit={shown}
                  selected={own ? attacker === unit.instanceId : target === unit.instanceId}
                  attackId={own && attacker === unit.instanceId ? move : undefined}
                  disabled={!!locked || (!own && !move)}
                  onInspect={() => inspectUnit(unit)}
                  onSelect={() => {
                    if (own) {
                      setAttacker(unit.instanceId);
                      setMove('');
                      setTarget('');
                    } else setTarget(unit.instanceId);
                  }}
                  onAttack={
                    own
                      ? (id) => {
                          setAttacker(unit.instanceId);
                          setMove(id);
                          setTarget('');
                        }
                      : undefined
                  }
                />
                {!own && (
                  <div
                    className={`matchup-label ${move && unit.hp > 0 ? 'shown' : ''}`}
                    aria-live="polite"
                  >
                    {move && unit.hp > 0 ? matchup(unit) : ''}
                  </div>
                )}
                {pulse?.subjectId === unit.instanceId && pulse.amount !== undefined && (
                  <span
                    key={pulse.id}
                    className={`floating ${pulse.kind === 'damage' ? 'damage' : 'healing'}`}
                  >
                    {pulse.kind === 'damage' ? '−' : '+'}
                    {pulse.amount}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </section>
    );
  }
  return (
    <>
      <nav className="topbar">
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            if (!battle) window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
        >
          <span className="brand-mark">
            <Swords size={24} />
          </span>
          trivattle<span className="beta">BATTLE LAB</span>
        </a>
        <div className="nav-meta">
          <span className="online-dot" />
          LOCAL TWO-PLAYER
          {battle && (
            <button className="quiet" disabled={busy || playing} onClick={exit}>
              Leave battle
            </button>
          )}
        </div>
      </nav>
      {error && (
        <div className="error" role="alert">
          {error}
          <button onClick={() => setError('')} aria-label="Dismiss error">
            ×
          </button>
        </div>
      )}
      {loading ? (
        <main className="loading">Opening the arena…</main>
      ) : !battle ? (
        <main className="setup">
          <section className="hero">
            <div>
              <div className="eyebrow">
                <Sparkles size={14} /> A LITTLE KNOWLEDGE. A LOT OF POWER.
              </div>
              <h1>
                The world is
                <br />
                in your <em>cards.</em>
              </h1>
              <p>
                Build your five. Pick your rivals. Defend with trivia.
                <br />
                Every article has a fighting chance.
              </p>
            </div>
            <div className="hero-aside">
              <span className="hero-orbit">
                <Swords size={56} />
              </span>
              <button className="primary" disabled={busy} onClick={() => start(true)}>
                <Zap size={17} /> Quick battle <ArrowRight size={17} />
              </button>
              <small>Two teams. Ten real Wikipedia cards.</small>
            </div>
          </section>
          <section className="builder">
            <div className="section-top">
              <div>
                <div className="eyebrow">01 / ASSEMBLE YOUR TEAM</div>
                <h2>Five minds are better than one.</h2>
              </div>
              <div className="player-tabs">
                {[0, 1].map((p) => (
                  <button
                    key={p}
                    className={builder === p ? 'active' : ''}
                    onClick={() => setBuilder(p)}
                  >
                    Player {p + 1}
                    <span>{teams[p].length}/5</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="team-builder">
              {Array.from({ length: 5 }, (_, i) => {
                const c = teams[builder][i];
                return (
                  <div className={`builder-slot ${c ? 'filled' : ''}`} key={i}>
                    <span>0{i + 1}</span>
                    {c ? (
                      <>
                        <button className="slot-name" onClick={() => setInspected(c)}>
                          {c.name}
                        </button>
                        <button
                          aria-label={`Remove slot ${i + 1}`}
                          onClick={() =>
                            setTeams((old) => {
                              const copy: [CardView[], CardView[]] = [[...old[0]], [...old[1]]];
                              copy[builder].splice(i, 1);
                              return copy;
                            })
                          }
                        >
                          ×
                        </button>
                      </>
                    ) : (
                      <small>Pick a card below</small>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="builder-bottom">
              <span>
                <BookOpen size={15} /> Same article, different strategy. Duplicate cards are
                allowed.
              </span>
              <button
                className="primary"
                disabled={busy || teams.some((t) => t.length !== 5)}
                onClick={() => start()}
              >
                Enter the arena <ArrowRight size={16} />
              </button>
            </div>
          </section>
          <section className="catalogue">
            <div className="section-top">
              <div>
                <div className="eyebrow">02 / EXPLORE THE CATALOGUE</div>
                <h2>Pick your power players.</h2>
              </div>
              <span className="count">{catalogue?.total ?? '…'} cards</span>
            </div>
            <div className="filters">
              <label className="search">
                <Search size={17} />
                <input
                  aria-label="Search cards"
                  placeholder="Search the world's knowledge…"
                  value={q}
                  onChange={(e) => {
                    setQ(e.target.value);
                    setPage(1);
                  }}
                />
              </label>
              <select
                aria-label="Filter by type"
                value={type}
                onChange={(e) => {
                  setType(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">All types</option>
                {[
                  'science',
                  'nature',
                  'technology',
                  'history',
                  'culture',
                  'geography',
                  'basic',
                ].map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
              <select
                aria-label="Filter by rarity"
                value={rarity}
                onChange={(e) => {
                  setRarity(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">All rarities</option>
                {['common', 'uncommon', 'rare', 'epic', 'legendary'].map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            </div>
            {catalogueLoading && (
              <p role="status" className="muted">
                Finding cards…
              </p>
            )}
            <div className={`card-grid ${catalogueLoading ? 'fetching' : ''}`}>
              {catalogue?.cards.map((c) => (
                <Card
                  key={c.versionId}
                  card={c}
                  onInspect={() => setInspected(c)}
                  onSelect={() => add(c)}
                  disabled={teams[builder].length === 5}
                >
                  + Add to Player {builder + 1}
                </Card>
              ))}
            </div>
            {catalogue?.total === 0 && (
              <div className="empty">
                <BookOpen size={32} />
                <h3>No playable cards found</h3>
                <p>
                  {q || type || rarity
                    ? 'Try a different search or filter.'
                    : 'Publish cards with complete validated trivia using the existing catalogue pipeline, then refresh this page.'}
                </p>
              </div>
            )}
            <div className="pagination">
              <button
                disabled={page === 1 || catalogueLoading}
                onClick={() => setPage((p) => p - 1)}
              >
                ← Previous
              </button>
              <span>
                Page {page} of {Math.max(1, Math.ceil((catalogue?.total ?? 0) / 20))}
              </span>
              <button
                disabled={page * 20 >= (catalogue?.total ?? 0) || catalogueLoading}
                onClick={() => setPage((p) => p + 1)}
              >
                Next →
              </button>
            </div>
          </section>
        </main>
      ) : (
        <main className="arena">
          <header className="arena-heading">
            <div>
              <div className="eyebrow">THE KNOWLEDGE ARENA</div>
              <h1>Make your move.</h1>
            </div>
            <span className="turn-chip">
              TURN {battle.turn} <span>·</span>{' '}
              {player(feedback ? viewPlayer : battle.currentPlayer)}
            </span>
          </header>
          {row(battle.players[1 - battle.players.indexOf(viewPlayer)]!)}
          <section className="battle-center">
            <div className="turn-instruction">
              <span className="arena-symbol">
                <Swords size={21} />
              </span>
              <div>
                <b>
                  {playing
                    ? 'Resolving the attack…'
                    : feedback
                      ? 'The dust settles.'
                      : battle.pending
                        ? `${player(battle.pending.defenderId)}, defend with knowledge.`
                        : !attacker
                          ? 'Select a card and an attack.'
                          : !move
                            ? 'Choose an attack.'
                            : !target
                              ? 'Choose an opposing target.'
                              : 'Ready to strike.'}
                </b>
                <small>
                  {selected
                    ? `${selected.card.name}${selectedMove ? ' → ' + selectedMove.name : ''}${victim ? ' → ' + victim.card.name : ''}`
                    : 'Five cards. One move. Make it count.'}
                </small>
              </div>
            </div>
            <button
              className="primary"
              disabled={!!locked || !attacker || !move || !target}
              onClick={() =>
                submit({
                  kind: 'attack',
                  playerId: battle.currentPlayer,
                  attackerId: attacker,
                  attackId: move,
                  targetId: target,
                })
              }
            >
              Confirm attack <ArrowRight size={17} />
            </button>
            <div className="latest-event" aria-live="polite">
              {pulse?.message ??
                battle.events.at(-1)?.message ??
                'Correct trivia reduces incoming damage and prevents attack effects.'}
            </div>
          </section>
          {row(viewPlayer)}
          <details className="combat-log">
            <summary>
              Combat journal <span>{battle.events.length} events</span>
            </summary>
            <ol>
              {battle.events.map((e) => (
                <li key={e.id}>
                  <span>T{e.turn}</span>
                  {e.message}
                </li>
              ))}
            </ol>
          </details>
        </main>
      )}
      {playing && pulse?.kind === 'attack' && (
        <div className="attack-announcement" role="status">
          <span className="attack-announcement-icon">
            <Swords size={32} />
          </span>
          <span>
            <small>ATTACK INCOMING</small>
            <strong>{pulse.message}</strong>
          </span>
        </div>
      )}
      {battle?.pending && !inspected && (
        <Dialog
          title={
            ready ? 'Knowledge is your shield.' : `${player(battle.pending.defenderId)}, you’re up.`
          }
        >
          {error && (
            <div className="dialog-error" role="alert">
              <p>{error}</p>
              <button onClick={exit}>Return to setup</button>
            </div>
          )}
          {!ready ? (
            <div className="handoff">
              <div className="round-icon">
                <ShieldIcon />
              </div>
              <p>
                Pass the device to <b>{player(battle.pending.defenderId)}</b>.
              </p>
              <p className="muted">
                Your opponent has chosen their attack.
                <br />A correct answer reduces incoming damage by{' '}
                {Math.round((1 - battle.rules.correctMultiplier) * 100)}% and blocks its special
                effect.
              </p>
              <button className="primary" onClick={() => setReady(true)}>
                Ready for Trivia <ArrowRight size={17} />
              </button>
            </div>
          ) : (
            <>
              <p className="eyebrow">
                DEFEND AGAINST{' '}
                {units.find((c) => c.instanceId === battle.pending?.attackerId)?.card.name}
              </p>
              <h3 className="question">{battle.pending.question.text}</h3>
              <div className="answers">
                {battle.pending.question.options.map((option, i) => (
                  <button
                    disabled={busy}
                    key={i}
                    onClick={() =>
                      submit({
                        kind: 'answer',
                        playerId: battle.pending!.defenderId,
                        questionId: battle.pending!.question.id,
                        answerIndex: i,
                      })
                    }
                  >
                    <span>{'ABCD'[i]}</span>
                    {option}
                  </button>
                ))}
              </div>
              <p className="muted">Take your time. Knowledge beats speed.</p>
            </>
          )}
        </Dialog>
      )}
      {battle && feedback && !playing && !inspected && (
        <Dialog
          title={
            battle.winner
              ? `${player(battle.winner)} takes the crown!`
              : battle.feedback
                ? battle.feedback.correct
                  ? 'Brilliant defense.'
                  : 'A little wiser. A little bruised.'
                : 'The well of knowledge runs dry.'
          }
        >
          {error && (
            <div className="dialog-error" role="alert">
              <p>{error}</p>
              <button onClick={exit}>Return to setup</button>
            </div>
          )}
          <div className={`result-icon ${battle.winner ? 'victory' : ''}`}>
            {battle.winner ? (
              <Trophy size={42} />
            ) : battle.feedback?.correct ? (
              <Sparkles size={36} />
            ) : (
              <BookOpen size={36} />
            )}
          </div>
          {battle.feedback && (
            <>
              <p className="eyebrow">
                {battle.feedback.correct ? 'CORRECT ANSWER' : 'THE CORRECT ANSWER'}
              </p>
              <h3>{battle.feedback.question.options[battle.feedback.correctIndex]}</h3>
              <p>{battle.feedback.explanation}</p>
            </>
          )}
          <div className="resolution-log">
            {(events.length ? events : battle.events.slice(-8))
              .filter((e) => e.kind !== 'turn')
              .map((e) => (
                <p key={e.id}>{e.message}</p>
              ))}
          </div>
          {battle.winner ? (
            <>
              <div className="match-stats">
                {battle.players.map((p) => (
                  <div key={p}>
                    <b>{player(p)}</b>
                    <span>{battle.stats[p].damage} damage dealt</span>
                    <span>
                      {battle.stats[p].correct}/{battle.stats[p].answered} trivia correct
                    </span>
                    <span>{battle.stats[p].knockouts} knockouts</span>
                  </div>
                ))}
              </div>
              <p className="muted">{battle.turn} turns of world-class knowledge.</p>
              <div className="dialog-actions">
                <button className="primary" disabled={busy} onClick={() => start(false, true)}>
                  <RotateCcw size={16} /> Rematch
                </button>
                <button onClick={exit}>Choose new teams</button>
              </div>
            </>
          ) : (
            <button className="primary wide" onClick={continueTurn}>
              Continue to {player(battle.currentPlayer)} <ArrowRight size={17} />
            </button>
          )}
        </Dialog>
      )}
      {battle?.winner && !feedback && !playing && (
        <Dialog title={`${player(battle.winner)} wins!`}>
          <button className="primary" onClick={() => start(false, true)}>
            Rematch
          </button>
          <button onClick={exit}>Choose new teams</button>
        </Dialog>
      )}
      {inspected && <CardDetails card={inspected} onClose={() => setInspected(null)} />}
      <footer>
        BUILT FROM THE WORLD’S KNOWLEDGE<span>Wikipedia cards. Real trivia. Friendly rivalry.</span>
      </footer>
    </>
  );
}
function ShieldIcon() {
  return <BookOpen size={36} />;
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
