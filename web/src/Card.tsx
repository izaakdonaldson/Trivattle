import { useEffect, useLayoutEffect, useRef, useState, useId, type ReactNode } from 'react';
import {
  Flame,
  HeartPlus,
  Crosshair,
  ArrowDown,
  Waves,
  Shield,
  HeartPulse,
  ShieldCheck,
  Heart,
  Info,
} from 'lucide-react';
import type { CardView, Unit } from '../../src/battle/types';
const effects = {
  burn: Flame,
  heal: HeartPlus,
  pierce: Crosshair,
  weaken: ArrowDown,
  splash: Waves,
};
const passives = { stalwart: Shield, recovery: HeartPulse, immune: ShieldCheck };
export const descriptions: Record<string, string> = {
  burn: '5 damage at the end of the affected player’s next two turns. Reapplication refreshes duration.',
  heal: 'Restore 10 HP to the attacker, up to its maximum.',
  pierce: 'Ignore the target’s flat defense for this hit.',
  weaken: 'The target’s next attack has 20% less base power. Does not stack.',
  splash: 'Living adjacent cards take 20% of calculated primary damage, rounded down (minimum 1).',
  stalwart: 'Take 5% less direct attack damage.',
  recovery: 'Once per battle, restore 5 HP when surviving damage crosses below 40% HP.',
  immune: 'Super-effective attacks become neutral. Resistance and status effects still apply.',
};
const icons: Record<string, [number, number]> = {
  science: [100, 124],
  nature: [446, 124],
  technology: [798, 124],
  history: [1150, 124],
  culture: [265, 540],
  geography: [619, 540],
  basic: [983, 540],
};
const pictures: Record<string, [number, number]> = {
  science: [19, 18],
  nature: [584, 18],
  technology: [1151, 18],
  history: [19, 332],
  culture: [584, 332],
  geography: [1151, 332],
  basic: [584, 637],
};
export function TypeIcon({ type }: { type: string }) {
  const [x, y] = icons[type]!;
  return (
    <span
      title={type}
      aria-label={type}
      className="type-icon"
      style={{ backgroundPosition: `${(x / (1536 - 284)) * 100}% ${(y / (1024 - 280)) * 100}%` }}
    />
  );
}
export function Art({ card }: { card: CardView }) {
  return <CardArt key={`${card.versionId}:${card.image?.url ?? card.type}`} card={card} />;
}
function CardArt({ card }: { card: CardView }) {
  const [failed, setFailed] = useState(false),
    [loaded, setLoaded] = useState(false),
    [attempt, setAttempt] = useState(0);
  const img = useRef<HTMLImageElement>(null),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [x, y] = pictures[card.type]!;
  useLayoutEffect(() => {
    if (img.current?.complete && img.current.naturalWidth > 0) setLoaded(true);
  }, [attempt]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const src = card.image
    ? `/api/card-art/${encodeURIComponent(card.versionId)}?image=${encodeURIComponent(card.image.url)}&attempt=${attempt}`
    : '';
  return (
    <div
      role="img"
      aria-label={loaded ? card.name : `${card.type} illustration`}
      className="art placeholder"
      style={{ backgroundPosition: `${(x / (1712 - 543)) * 100}% ${(y / (919 - 296)) * 100}%` }}
    >
      {card.image && !failed && (
        <img
          ref={img}
          className={`article-image ${loaded ? 'loaded' : ''}`}
          src={src}
          alt=""
          loading="lazy"
          onLoad={() => setLoaded(true)}
          onError={() => {
            if (attempt < 2) {
              clearTimeout(timer.current);
              timer.current = setTimeout(() => setAttempt((n) => n + 1), 2500 * (attempt + 1));
            } else setFailed(true);
          }}
        />
      )}
    </div>
  );
}
export function Card({
  card,
  unit,
  selected,
  onInspect,
  onSelect,
  onAttack,
  attackId,
  disabled,
  children,
  selectOnCard = false,
  hideSelectButton = false,
}: {
  card: CardView;
  selectOnCard?: boolean;
  hideSelectButton?: boolean;
  unit?: Unit;
  selected?: boolean;
  onInspect: () => void;
  onSelect?: () => void;
  onAttack?: (id: string) => void;
  attackId?: string;
  disabled?: boolean;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null),
    frame = useRef(0);
  const dead = unit?.hp === 0;
  useEffect(() => {
    const node = ref.current!;
    const observer = new IntersectionObserver(([entry]) =>
      node.classList.toggle('visible', entry.isIntersecting),
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame.current);
    };
  }, []);
  function tilt(e: React.PointerEvent<HTMLElement>) {
    if (
      !matchMedia('(hover: hover) and (pointer: fine)').matches ||
      matchMedia('(prefers-reduced-motion: reduce)').matches
    )
      return;
    const rect = e.currentTarget.getBoundingClientRect(),
      x = (e.clientX - rect.left) / rect.width,
      y = (e.clientY - rect.top) / rect.height;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      ref.current?.style.setProperty('--rx', `${(0.5 - y) * 4}deg`);
      ref.current?.style.setProperty('--ry', `${(x - 0.5) * 4}deg`);
      ref.current?.style.setProperty('--shine-x', `${x * 100}%`);
    });
  }
  const Passive = card.passive ? passives[card.passive.id] : null;
  return (
    <article
      ref={ref}
      aria-label={card.name}
      className={`card ${card.rarity} ${selected ? 'selected' : ''} ${dead ? 'defeated' : ''} ${(unit || selectOnCard) && !disabled && !dead ? 'selectable' : ''}`}
      onClick={(e) => {
        if ((e.target as Element).closest('button')) return;
        if (unit || selectOnCard) {
          if (!disabled && !dead) onSelect?.();
        } else onInspect();
      }}
      onPointerMove={tilt}
      onPointerLeave={() => {
        cancelAnimationFrame(frame.current);
        ref.current?.style.setProperty('--rx', '0deg');
        ref.current?.style.setProperty('--ry', '0deg');
      }}
      data-instance={unit?.instanceId}
    >
      <span className="foil" />
      <span className="sparkle">✦</span>
      <header>
        <TypeIcon type={card.type} />
        <h3 title={card.name}>{card.name}</h3>
        <button className="card-info" onClick={onInspect} aria-label={`Inspect ${card.name}`}>
          <Info size={15} />
        </button>
      </header>
      <button
        className="card-cover"
        onClick={unit || selectOnCard ? onSelect : onInspect}
        disabled={unit || selectOnCard ? disabled || dead : false}
        aria-label={`${unit || selectOnCard ? 'Select' : 'View'} ${card.name}`}
        aria-pressed={unit || selectOnCard ? !!selected : undefined}
      >
        <Art card={card} />
      </button>
      <div className="stats">
        <span>
          <Heart size={17} fill="currentColor" /> <strong>{unit?.hp ?? card.hp}</strong>
          <small>{unit ? `/ ${card.hp}` : 'HP'}</small>
        </span>
        <span>
          <Shield size={17} />
          <strong>{card.defense}</strong>
          <small>DEF</small>
        </span>
      </div>
      {unit && (
        <div
          className="hp-track"
          role="meter"
          aria-label={`${card.name} health`}
          aria-valuenow={unit.hp}
          aria-valuemin={0}
          aria-valuemax={card.hp}
        >
          <span style={{ width: `${(unit.hp / card.hp) * 100}%` }} />
        </div>
      )}
      <div className="moves">
        {card.attacks.map((a) => {
          const Effect = a.effectId ? effects[a.effectId] : null;
          const Move = onAttack ? 'button' : 'div';
          return (
            <Move
              title={`${a.description} Base power ${a.power}.${a.effectId ? ' On incorrect trivia: ' + descriptions[a.effectId] : ''}`}
              className={`move ${attackId === a.id ? 'chosen' : ''}`}
              key={a.id}
              {...(onAttack ? { disabled: disabled || dead } : {})}
              onClick={() => onAttack?.(a.id)}
            >
              <TypeIcon type={a.type} />
              <b>{a.name}</b>
              <span>
                {Effect && <Effect size={15} />}
                <strong>{a.power}</strong>
              </span>
            </Move>
          );
        })}
      </div>
      {Passive && (
        <div className="passive">
          <Passive size={16} />
          <b>{card.passive!.id}</b>
          {unit?.recoveryUsed && <small>used</small>}
        </div>
      )}
      {unit && (
        <div className="statuses">
          {dead ? (
            <span>Knocked out</span>
          ) : (
            <>
              {unit.burnTurns > 0 && (
                <span>
                  <Flame size={13} />
                  Burn · {unit.burnTurns}
                </span>
              )}
              {unit.weakened && (
                <span>
                  <ArrowDown size={13} />
                  Weaken
                </span>
              )}
            </>
          )}
        </div>
      )}
      {onSelect && !unit && !hideSelectButton && (
        <button className="select-card" disabled={disabled || dead} onClick={onSelect}>
          {children ?? (selected ? 'Selected' : 'Choose card')}
        </button>
      )}
    </article>
  );
}
export function Dialog({
  hideTitle = false,
  className,
  title,
  children,
  onClose,
}: {
  title: string;
  hideTitle?: boolean;
  className?: string;
  children: ReactNode;
  onClose?: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      className={className}
      aria-labelledby={titleId}
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose?.();
      }}
    >
      <div className={hideTitle ? 'visually-hidden' : 'dialog-heading'}>
        <h2 id={titleId}>{title}</h2>
        {onClose && (
          <button aria-label="Close dialog" onClick={onClose}>
            ×
          </button>
        )}
      </div>
      {children}
    </dialog>
  );
}
export function CardDetails({ card, onClose }: { card: CardView; onClose: () => void }) {
  return (
    <Dialog title={card.name} onClose={onClose}>
      <Art card={card} />
      <p className="eyebrow">
        <TypeIcon type={card.type} /> {card.rarity} · {card.type} · {card.hp} HP · {card.defense}{' '}
        DEF
      </p>
      {card.summary && (
        <section className="article-summary">
          <h3>About this article</h3>
          <p>{card.summary}</p>
        </section>
      )}
      {card.attacks.map((a) => (
        <section key={a.id} className="detail-move">
          <h3>
            {a.name}{' '}
            <span>
              <TypeIcon type={a.type} /> {a.power} base power · {a.type}
            </span>
          </h3>
          <p>{a.description}</p>
          {a.effectId && (
            <p>
              <DetailIcon kind={a.effectId} /> <b>{a.effectId}:</b> {descriptions[a.effectId]} Only
              on an incorrect answer.
            </p>
          )}
        </section>
      ))}
      {card.passive && (
        <p className="passive-detail">
          <DetailIcon kind={card.passive.id} /> <b>{card.passive.id}:</b>{' '}
          {descriptions[card.passive.id]}
        </p>
      )}
      {card.url && (
        <a href={card.url} target="_blank" rel="noreferrer">
          Read the Wikipedia article ↗
        </a>
      )}
      {card.image && (
        <p className="credit">
          {card.image.attribution} · {card.image.license}
          {card.image.descriptionUrl && (
            <>
              {' '}
              ·{' '}
              <a href={card.image.descriptionUrl} target="_blank" rel="noreferrer">
                Image source
              </a>
            </>
          )}
        </p>
      )}
    </Dialog>
  );
}

function DetailIcon({ kind }: { kind: keyof typeof effects | keyof typeof passives }) {
  const Icon = { ...effects, ...passives }[kind];
  return <Icon aria-label={kind} size={18} className="detail-icon" />;
}
