import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Swords, Trophy } from 'lucide-react';
import type { LobbyView } from '../../../src/player/types';
import type { CardView, BattleEvent, Unit } from '../../../src/battle/types';
import { Card, CardDetails, Dialog } from '../Card';
import { api, message, requestId } from '../api';
import type { Send } from './LobbyPage';
export function BattlePage({
  room,
  send,
  busy,
  onExit,
}: {
  room: LobbyView;
  send: Send;
  busy: boolean;
  onExit: () => void;
}) {
  const [battle, setBattle] = useState(room.battle!);
  const own = battle.teams[battle.players.indexOf(room.self)]!,
    enemy = battle.teams[1 - battle.players.indexOf(room.self)]!;
  const [attacker, setAttacker] = useState(''),
    [attack, setAttack] = useState(''),
    [target, setTarget] = useState(''),
    [inspect, setInspect] = useState<CardView | null>(null),
    [error, setError] = useState(''),
    [dismissed, setDismissed] = useState(-1),
    [pulse, setPulse] = useState<BattleEvent | null>(null),
    [displayHP, setDisplayHP] = useState<Record<string, number>>({}),
    [displayUnits, setDisplayUnits] = useState<Record<string, Unit>>({}),
    [playing, setPlaying] = useState(false),
    [now, setNow] = useState(Date.now()),
    [chosenAnswer, setChosenAnswer] = useState<number | null>(null);
  const awaitingContinue = !!battle.feedback && !battle.pending && dismissed !== battle.revision;
  useLayoutEffect(() => {
    if (
      !awaitingContinue &&
      !playing &&
      lastEvents.current === battle.events.length &&
      room.battle!.revision > battle.revision
    )
      setBattle(room.battle!);
  }, [room.battle, awaitingContinue, playing, battle.revision]);
  useEffect(() => setChosenAnswer(null), [battle.pending?.question.id]);
  useEffect(() => {
    setNow(Date.now());
    const t = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, room.announcementUntil - Date.now()) + 20,
    );
    return () => clearTimeout(t);
  }, [room.announcementUntil]);
  const announcing = now < room.announcementUntil;
  const lastEvents = useRef(battle.events.length),
    previousUnits = useRef(Object.fromEntries(battle.teams.flat().map((u) => [u.instanceId, u])));
  useEffect(() => {
    setAttacker('');
    setAttack('');
    setTarget('');
  }, [battle.turn, battle.phase]);
  useLayoutEffect(() => {
    const events = battle.events.filter((e) => e.id > lastEvents.current);
    const old = previousUnits.current;
    const oldHP = Object.fromEntries(Object.values(old).map((u) => [u.instanceId, u.hp]));
    if (awaitingContinue) {
      setDisplayUnits(old);
      setDisplayHP(oldHP);
      setPlaying(false);
      setPulse(null);
      return;
    }
    lastEvents.current = battle.events.length;
    previousUnits.current = Object.fromEntries(battle.teams.flat().map((u) => [u.instanceId, u]));
    if (!events.length || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setPlaying(false);
      setDisplayUnits({});
      setDisplayHP({});
      setPulse(null);
      return;
    }
    let i = 0;
    setPlaying(true);
    setDisplayUnits(old);
    setDisplayHP(oldHP);
    let timer: ReturnType<typeof setTimeout>;
    const step = () => {
      const e = events[i++];
      if (!e) {
        setPlaying(false);
        setDisplayUnits({});
        setDisplayHP({});
        setPulse(null);
        return;
      }
      setPulse(e);
      if (e.subjectId && e.hp !== undefined) setDisplayHP((v) => ({ ...v, [e.subjectId!]: e.hp! }));
      timer = setTimeout(step, e.kind === 'damage' || e.kind === 'heal' ? 1100 : 650);
    };
    timer = setTimeout(step, 300);
    return () => clearTimeout(timer);
  }, [battle.revision, awaitingContinue]);
  const active =
    !room.paused &&
    !busy &&
    !playing &&
    !awaitingContinue &&
    battle.revision === room.battle!.revision &&
    room.status === 'in-battle' &&
    battle.currentPlayer === room.self &&
    battle.phase === 'SELECTING_ATTACK';
  const selected = own.find((u) => u.instanceId === attacker),
    selectedAttack = selected?.card.attacks.find((a) => a.id === attack);
  const name = (slot: string) => room.players.find((p) => p.slot === slot)?.name ?? slot;
  async function detail(u: Unit) {
    try {
      setInspect(
        await api<CardView>(`/api/lobbies/${room.id}/cards/${encodeURIComponent(u.instanceId)}`),
      );
    } catch (e) {
      setError(message(e));
    }
  }
  function matchup(u: Unit) {
    if (!selectedAttack) return '';
    const a = selectedAttack.type,
      d = u.card.type;
    const mult =
      a === 'basic' || d === 'basic'
        ? 1
        : battle.rules.counters[a] === d
          ? u.card.passive?.id === 'immune'
            ? 1
            : battle.rules.strong
          : battle.rules.counters[d] === a
            ? battle.rules.weak
            : 1;
    return mult > 1 ? `Super effective ×${mult}` : mult < 1 ? `Resisted ×${mult}` : 'Neutral ×1';
  }
  const row = (units: Unit[], isOwn: boolean) => (
    <section className={`team-zone ${isOwn ? 'own' : 'opponent'}`}>
      <div className="zone-heading">
        <h2>{isOwn ? 'Your team' : name(units[0]!.playerId)}</h2>
        <span>{units.filter((u) => (displayHP[u.instanceId] ?? u.hp) > 0).length}/5 standing</span>
      </div>
      <div className="battle-row">
        {units.map((u) => (
          <div
            className={`battle-slot ${pulse?.subjectId === u.instanceId ? `impact-${pulse.kind}` : ''}`}
            key={u.instanceId}
          >
            <Card
              card={u.card}
              unit={{ ...(displayUnits[u.instanceId] ?? u), hp: displayHP[u.instanceId] ?? u.hp }}
              selected={isOwn ? attacker === u.instanceId : target === u.instanceId}
              disabled={!active || (!isOwn && !attack)}
              onInspect={() => detail(u)}
              onSelect={() => {
                if (isOwn) {
                  setAttacker(u.instanceId);
                  setAttack('');
                  setTarget('');
                } else setTarget(u.instanceId);
              }}
              onAttack={
                isOwn
                  ? (id) => {
                      setAttacker(u.instanceId);
                      setAttack(id);
                      setTarget('');
                    }
                  : undefined
              }
              attackId={attacker === u.instanceId ? attack : undefined}
            />
            {!isOwn && <div className={`matchup-label ${attack ? 'shown' : ''}`}>{matchup(u)}</div>}
            {pulse?.subjectId === u.instanceId && pulse.amount !== undefined && (
              <span className={`floating ${pulse.kind === 'heal' ? 'healing' : 'damage'}`}>
                {pulse.kind === 'heal' ? '+' : '−'}
                {pulse.amount}
              </span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
  const terminal =
    battle.phase === 'BATTLE_FINISHED' || room.status === 'abandoned' || room.status === 'expired';
  const attackingUnit = battle.teams
    .flat()
    .find((u) => u.instanceId === battle.pending?.attackerId);
  const defendingUnit = battle.teams.flat().find((u) => u.instanceId === battle.pending?.targetId);
  const announcedAttack = attackingUnit?.card.attacks.find(
    (a) => a.id === battle.pending?.attackId,
  );
  return (
    <main className="arena online-arena">
      <header className="arena-heading">
        <div>
          <p className="eyebrow">THE KNOWLEDGE ARENA</p>
          <h1>
            {terminal && !awaitingContinue && !playing
              ? battle.winner
                ? `${name(battle.winner)} wins!`
                : 'Match ended'
              : room.paused
                ? 'Waiting for reconnection'
                : battle.phase === 'ANSWERING_TRIVIA'
                  ? battle.pending?.defenderId === room.self
                    ? 'Defend with knowledge.'
                    : 'Your opponent is answering…'
                  : battle.currentPlayer === room.self
                    ? 'Make your move.'
                    : `${name(battle.currentPlayer)} is choosing…`}
          </h1>
        </div>
        <span className="turn-chip">TURN {battle.turn}</span>
      </header>
      {error && <p role="alert">{error}</p>}
      {room.paused && (
        <p className="notice" role="status">
          Battle paused. Reconnect within two minutes to continue.
        </p>
      )}
      {row(enemy, false)}
      <section className="battle-center">
        <div className="turn-instruction">
          <Swords size={24} />
          <div>
            <b>
              {awaitingContinue
                ? 'Review the answer to continue.'
                : playing
                  ? 'Resolving the attack…'
                  : battle.currentPlayer !== room.self
                    ? `${name(battle.currentPlayer)}’s turn`
                    : 'Choose an attacker, an attack, and a target.'}
            </b>
            <small>
              {pulse?.message ??
                (battle.currentPlayer === room.self
                  ? 'Correct trivia reduces damage and prevents effects.'
                  : '')}
            </small>
          </div>
        </div>
        <button
          className="primary"
          disabled={!active || !attacker || !attack || !target}
          onClick={() =>
            send('battle:command', {
              command: {
                kind: 'attack',
                commandId: requestId(),
                revision: battle.revision,
                attackerId: attacker,
                attackId: attack,
                targetId: target,
              },
            })
          }
        >
          Confirm attack
        </button>
      </section>
      {row(own, true)}
      <details className="combat-log">
        <summary>Combat journal · {battle.events.length} events</summary>
        <ol>
          {battle.events.map((e) => (
            <li key={e.id}>
              <span>T{e.turn}</span>
              {e.message}
            </li>
          ))}
        </ol>
      </details>
      {announcing && battle.pending && !terminal && !room.paused && !inspect && (
        <Dialog title="Attack announcement" hideTitle className="online-attack-dialog">
          <div className="attack-preview">
            {attackingUnit && (
              <div inert>
                <Card card={attackingUnit.card} onInspect={() => {}} />
              </div>
            )}
            <p className="attack-description">
              <strong>{attackingUnit?.card.name}</strong> used <em>{announcedAttack?.name}</em> on{' '}
              <strong>{defendingUnit?.card.name}</strong>
            </p>
            {defendingUnit && (
              <div inert>
                <Card card={defendingUnit.card} onInspect={() => {}} />
              </div>
            )}
          </div>
        </Dialog>
      )}
      {battle.pending && !announcing && !terminal && !room.paused && !inspect && (
        <Dialog
          title={
            battle.pending.defenderId === room.self
              ? 'Defend with knowledge'
              : 'Waiting for your opponent’s answer'
          }
        >
          <p className="eyebrow">ANSWER TO REDUCE INCOMING DAMAGE</p>
          <h3>{battle.pending.question.text}</h3>
          <div className="answers">
            {battle.pending.question.options.map((option, i) => (
              <button
                key={i}
                aria-pressed={chosenAnswer === i}
                disabled={busy || battle.pending!.defenderId !== room.self}
                onClick={() => {
                  setChosenAnswer(i);
                  void send('battle:command', {
                    command: {
                      kind: 'answer',
                      commandId: requestId(),
                      revision: battle.revision,
                      questionId: battle.pending!.question.id,
                      answerIndex: i,
                    },
                  });
                }}
              >
                {option}
              </button>
            ))}
          </div>
        </Dialog>
      )}
      {battle.feedback &&
        dismissed !== battle.revision &&
        !playing &&
        !battle.pending &&
        !inspect &&
        (!terminal || !!battle.winner) && (
          <Dialog title={battle.feedback.correct ? 'Correct answer!' : 'The answer revealed'}>
            <p>{battle.feedback.question.text}</p>
            <div className="answer-results">
              {battle.feedback.question.options.map((option, i) => (
                <div
                  key={i}
                  className={`answer-result ${i === battle.feedback!.answerIndex ? (battle.feedback!.correct ? 'answer-correct' : 'answer-wrong') : ''}`}
                >
                  {option}
                  {i === battle.feedback!.answerIndex && (
                    <strong> — Selected {battle.feedback!.correct ? '✓' : '✕'}</strong>
                  )}
                  {i === battle.feedback!.correctIndex && i !== battle.feedback!.answerIndex && (
                    <strong> — Correct answer ✓</strong>
                  )}
                </div>
              ))}
            </div>
            <p>{battle.feedback.explanation}</p>
            <button className="primary" onClick={() => setDismissed(battle.revision)}>
              Continue
            </button>
          </Dialog>
        )}
      {terminal &&
        !playing &&
        !inspect &&
        (!battle.winner || !battle.feedback || dismissed === battle.revision) && (
          <Dialog title={battle.winner ? `${name(battle.winner)} wins!` : 'Match abandoned'}>
            <Trophy size={36} />
            <p>
              {battle.winner
                ? `A battle of ${battle.turn} turns.`
                : 'The match ended without a winner. Your cards are safe.'}
            </p>
            <div className="results-grid">
              {room.players.map((p) => (
                <div key={p.slot}>
                  <h3>{p.name}</h3>
                  <p>
                    {battle.stats[p.slot]?.damage ?? 0} damage ·{' '}
                    {battle.stats[p.slot]?.knockouts ?? 0} knockouts
                  </p>
                  <p>{battle.stats[p.slot]?.correct ?? 0} correct answers</p>
                </div>
              ))}
            </div>
            <button className="primary" onClick={onExit}>
              Find another battle
            </button>
            <a href="#/collection">View collection</a>
          </Dialog>
        )}
      {inspect && <CardDetails card={inspect} onClose={() => setInspect(null)} />}
    </main>
  );
}
