import React, { useEffect, useRef, useState, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { io, type Socket } from 'socket.io-client';
import { Swords, Layers, PackageOpen, LogOut, ArrowRight } from 'lucide-react';
import type { LobbyView, Me, Reply } from '../../src/player/types';
import { api, authClient, message, requestId } from './api';
import { AuthPage } from './pages/AuthPage';
import { CollectionPage, CataloguePage } from './pages/CollectionPage';
import { TradesPage, TradePage } from './pages/TradesPage';
import { FriendsPage } from './pages/FriendsPage';
import { PacksPage } from './pages/PacksPage';
import { LobbyPage } from './pages/LobbyPage';
import { BattlePage } from './pages/BattlePage';
import './style.css';
import './online.css';
const LocalBattle = lazy(() => import('./LocalBattle'));
function App() {
  const { data: session, isPending } = authClient.useSession();
  const [route, setRoute] = useState(location.hash || '#/collection'),
    [me, setMe] = useState<Me | null>(null),
    [room, setRoom] = useState<LobbyView | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [refresh, setRefresh] = useState(0),
    [tradeNotice, setTradeNotice] = useState(false),
    [friendNotice, setFriendNotice] = useState(false),
    [connected, setConnected] = useState(false),
    [code, setCode] = useState('');
  const socket = useRef<Socket | null>(null),
    current = useRef<LobbyView | null>(null);
  function apply(v: LobbyView | null) {
    if (v && current.current?.id === v.id && v.revision < current.current.revision) return;
    current.current = v;
    setRoom(v);
    if (session?.user.id) {
      if (v) localStorage.setItem(`trivattle-room-${session.user.id}`, v.id);
      else localStorage.removeItem(`trivattle-room-${session.user.id}`);
    }
  }
  const accountId = useRef(session?.user.id);
  accountId.current = session?.user.id;
  async function bootstrap() {
    const account = accountId.current;
    try {
      const value = await api<Me>('/api/me/bootstrap', {});
      if (accountId.current !== account) return;
      setMe(value);
      setError('');
    } catch (e) {
      setError(message(e));
    }
  }
  useEffect(() => {
    const f = () => setRoute(location.hash || '#/collection');
    addEventListener('hashchange', f);
    return () => removeEventListener('hashchange', f);
  }, []);
  useEffect(() => {
    if (route.startsWith('#/join/')) setCode(route.split('/')[2] ?? '');
  }, [route]);
  useEffect(() => {
    setMe(null);
    setTradeNotice(false);
    setFriendNotice(false);
    apply(null);
    if (!session?.user.id) return;
    let active = true;
    void bootstrap();
    const s = io({ autoConnect: false });
    socket.current = s;
    s.on('connect', () => {
      setConnected(true);
      dispatchEvent(new Event('trivattle:friends'));
      dispatchEvent(new Event('trivattle:trades'));
      dispatchEvent(new Event('trivattle:inventory'));
      api<LobbyView | null>('/api/lobbies/current')
        .then((v) => {
          if (active) apply(v);
        })
        .catch((e) => {
          if (active) setError(message(e));
        });
    });
    s.on('trade:updated', () => {
      setTradeNotice(true);
      dispatchEvent(new Event('trivattle:trades'));
    });
    s.on('friends:updated', () => {
      setFriendNotice(true);
      dispatchEvent(new Event('trivattle:friends'));
    });
    s.on('inventory:updated', () => {
      void bootstrap();
      setRefresh((n) => n + 1);
      dispatchEvent(new Event('trivattle:inventory'));
    });
    s.on('disconnect', (reason) => {
      setConnected(false);
      if (reason === 'io server disconnect') void authClient.getSession();
    });
    s.on('connect_error', () => {
      setConnected(false);
      setError('Realtime connection unavailable. Reconnecting…');
    });
    s.on('lobby:update', (v: LobbyView) => {
      if (active) apply(v);
    });
    s.connect();
    return () => {
      active = false;
      s.disconnect();
      socket.current = null;
    };
  }, [session?.user.id]);
  async function send(event: string, extra: Record<string, unknown> = {}) {
    const r = current.current;
    if (!socket.current?.connected || !r) {
      setError('Waiting for connection');
      return false;
    }
    setBusy(true);
    setError('');
    try {
      const reply = (await socket.current.timeout(8000).emitWithAck(event, {
        roomId: r.id,
        requestId: requestId(),
        revision: r.revision,
        ...extra,
      })) as Reply;
      if (!reply.ok) throw Error(reply.error);
      apply(reply.view);
      return true;
    } catch (e) {
      setError(message(e));
      try {
        apply(await api<LobbyView>(`/api/lobbies/${r.id}`));
      } catch {}
      return false;
    } finally {
      setBusy(false);
    }
  }
  // UI event handlers use this wrapper so rejected acknowledgments stay visible without unhandled promises.
  const safeSend = async (event: string, extra?: Record<string, unknown>) => send(event, extra);
  async function enter(join: boolean) {
    setBusy(true);
    setError('');
    try {
      apply(
        await api<LobbyView>(join ? '/api/lobbies/join' : '/api/lobbies', join ? { code } : {}),
      );
      location.hash = '/battle';
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  if (route === '#/lab')
    return (
      <Suspense fallback={<p>Opening Battle Lab…</p>}>
        <LocalBattle />
      </Suspense>
    );
  return (
    <>
      <nav className="topbar app-nav">
        <a className="brand" href="#/collection">
          <span className="brand-mark">
            <Swords size={24} />
          </span>
          trivattle
        </a>
        {session && (
          <>
            <div className="nav-links">
              <a
                className={route.startsWith('#/trades') ? 'active' : ''}
                href="#/trades"
                onClick={() => setTradeNotice(false)}
              >
                Trades {tradeNotice && <small aria-label="New trading activity">•</small>}
              </a>
              <a
                className={route === '#/friends' ? 'active' : ''}
                href="#/friends"
                onClick={() => setFriendNotice(false)}
              >
                Friends {friendNotice && <small aria-label="New friend activity">•</small>}
              </a>
              <a className={route === '#/collection' ? 'active' : ''} href="#/collection">
                <Layers size={16} />
                Collection
              </a>
              <a className={route === '#/catalogue' ? 'active' : ''} href="#/catalogue">
                <Layers size={16} />
                All cards
              </a>
              <a className={route === '#/packs' ? 'active' : ''} href="#/packs">
                <PackageOpen size={16} />
                Packs {me && <small>{me.packs}</small>}
              </a>
              <a
                className={route.includes('battle') || route.includes('join') ? 'active' : ''}
                href="#/battle"
              >
                <Swords size={16} />
                Battle
              </a>
            </div>
            <div className="account-nav">
              <span>{session.user.name}</span>
              <button
                aria-label="Log out"
                onClick={async () => {
                  await authClient.signOut();
                  socket.current?.disconnect();
                  setMe(null);
                  apply(null);
                }}
              >
                <LogOut size={16} />
              </button>
            </div>
          </>
        )}
      </nav>
      {isPending ? (
        <main className="loading">Opening Trivattle…</main>
      ) : !session ? (
        <AuthPage />
      ) : (
        <>
          {error && (
            <div className="error app-error" role="alert">
              {error}
              <button aria-label="Dismiss error" onClick={() => setError('')}>
                ×
              </button>
            </div>
          )}
          {!me ? (
            <main className="loading">
              <h2>Preparing your starter packs</h2>
              <button onClick={bootstrap}>Retry onboarding</button>
            </main>
          ) : route === '#/packs' ? (
            <PacksPage
              userId={me.id}
              onOpened={() => {
                setRefresh((v) => v + 1);
                api<Me>('/api/me').then(setMe);
              }}
            />
          ) : route === '#/trades' || route === '#/trades/history' ? (
            <TradesPage key={route} history={route.endsWith('/history')} />
          ) : route.startsWith('#/trades/') ? (
            <TradePage key={route} id={route.split('/')[2]!} connected={connected} />
          ) : route === '#/friends' ? (
            <FriendsPage friendCode={me.friendCode} />
          ) : route === '#/catalogue' ? (
            <CataloguePage />
          ) : route === '#/collection' ? (
            <CollectionPage refresh={refresh} />
          ) : (
            <>
              {!connected && (
                <p className="notice" role="status">
                  Connecting to the arena…
                </p>
              )}
              {room?.battle ? (
                <BattlePage
                  room={room}
                  busy={busy || !connected}
                  send={safeSend}
                  onExit={() => {
                    void send('lobby:leave');
                  }}
                />
              ) : room && ['waiting', 'selecting', 'ready-to-start'].includes(room.status) ? (
                <LobbyPage room={room} busy={busy || !connected} send={safeSend} />
              ) : (
                <main className="app-page battle-home">
                  <p className="eyebrow">BETTER WITH A RIVAL</p>
                  <h1>
                    Bring your five.
                    <br />
                    <em>Challenge a friend.</em>
                  </h1>
                  <p>Choose your cards privately. Reveal together. Let knowledge decide.</p>
                  {room && (
                    <p className="notice">That lobby has ended. Create or join a new one.</p>
                  )}
                  <div className="lobby-actions">
                    <section>
                      <Swords size={32} />
                      <h2>Make the first move.</h2>
                      <p>Create a room and share the invitation.</p>
                      <button
                        className="primary"
                        disabled={busy || !connected}
                        onClick={() => enter(false)}
                      >
                        Create Battle
                        <ArrowRight size={16} />
                      </button>
                    </section>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void enter(true);
                      }}
                    >
                      <h2>Have a code?</h2>
                      <label>
                        Join code
                        <input
                          aria-label="Join code"
                          value={code}
                          maxLength={6}
                          placeholder="ABC234"
                          onChange={(e) => setCode(e.target.value.toUpperCase())}
                        />
                      </label>
                      <button disabled={busy || !connected || code.length !== 6}>
                        Join Battle
                        <ArrowRight size={16} />
                      </button>
                    </form>
                  </div>
                </main>
              )}
            </>
          )}
        </>
      )}
      <footer>
        BUILT FROM THE WORLD’S KNOWLEDGE<span>Wikipedia cards. Real trivia. Friendly rivalry.</span>
      </footer>
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
