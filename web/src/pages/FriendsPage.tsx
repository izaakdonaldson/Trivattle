import { useEffect, useRef, useState } from 'react';
import type {
  FriendList,
  Friendship,
  PublicPlayer,
  TradeView,
} from '../../../src/player/social-types';
import { api, message, requestId } from '../api';
export function FriendsPage({ friendCode }: { friendCode: string }) {
  const [data, setData] = useState<FriendList | null>(null),
    [page, setPage] = useState(1),
    [code, setCode] = useState(''),
    [found, setFound] = useState<PublicPlayer | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [copied, setCopied] = useState(false);
  const serial = useRef(0);
  const load = () => {
    const n = ++serial.current;
    return api<FriendList>('/api/friends?page=' + page)
      .then((v) => {
        if (n === serial.current) setData(v);
      })
      .catch((e) => {
        if (n === serial.current) setError(message(e));
      });
  };
  useEffect(() => {
    void load();
    const update = () => void load();
    addEventListener('trivattle:friends', update);
    return () => removeEventListener('trivattle:friends', update);
  }, [page]);
  async function action(f: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await f();
      await load();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const act = (r: Friendship, action: string) =>
    api('/api/friends/' + r.id, { action, revision: r.revision });
  return (
    <main className="app-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">BETTER TOGETHER</p>
          <h1>Friends.</h1>
          <p>
            Your friend code: <strong data-testid="friend-code">{friendCode}</strong>{' '}
            <button
              onClick={() =>
                void navigator.clipboard
                  .writeText(friendCode)
                  .then(() => setCopied(true))
                  .catch(() => setError('Copy the code above to share it.'))
              }
            >
              {copied ? 'Copied' : 'Copy code'}
            </button>
          </p>
        </div>
      </div>
      <form
        className="friend-search"
        onSubmit={(e) => {
          e.preventDefault();
          void action(async () =>
            setFound(await api<PublicPlayer>('/api/players/by-code/' + encodeURIComponent(code))),
          );
        }}
      >
        <label>
          Friend code{' '}
          <input
            aria-label="Friend code"
            placeholder="ABCD-EFGH"
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              setFound(null);
            }}
            maxLength={20}
          />
        </label>
        <button disabled={busy}>Find player</button>
      </form>
      {found && (
        <div className="social-row">
          <span>
            {found.name} · {found.friendCode}
          </span>
          <button
            disabled={busy}
            onClick={() =>
              void action(async () => {
                await api('/api/friends/requests', { code: found.friendCode });
                setFound(null);
                setCode('');
              })
            }
          >
            Add friend
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!data && <p role="status">Loading friends…</p>}
      {(['Incoming requests', 'Outgoing requests', 'Your friends'] as const).map((label, i) => (
        <section className="social-section" key={label}>
          <h2>{label}</h2>
          {data?.items
            .filter((r) =>
              i === 2
                ? r.status === 'ACCEPTED'
                : r.status === 'PENDING' && r.incoming === (i === 0),
            )
            .map((r) => (
              <div className="social-row" key={r.id}>
                <span>
                  <strong>{r.player.name}</strong>
                  <small>{r.player.friendCode}</small>
                </span>
                <div className="social-actions">
                  {i === 0 ? (
                    <>
                      <button disabled={busy} onClick={() => void action(() => act(r, 'accept'))}>
                        Accept
                      </button>
                      <button disabled={busy} onClick={() => void action(() => act(r, 'decline'))}>
                        Decline
                      </button>
                    </>
                  ) : i === 1 ? (
                    <button disabled={busy} onClick={() => void action(() => act(r, 'cancel'))}>
                      Cancel request
                    </button>
                  ) : (
                    <>
                      <button
                        className="primary"
                        disabled={busy}
                        onClick={() =>
                          void action(async () => {
                            const key = 'trivattle-invite-' + friendCode + '-' + r.player.id;
                            const request = localStorage.getItem(key) ?? requestId();
                            localStorage.setItem(key, request);
                            const t = await api<TradeView>('/api/trades', {
                              friendId: r.player.id,
                              requestId: request,
                            });
                            localStorage.removeItem(key);
                            location.hash = '/trades/' + t.id;
                          })
                        }
                      >
                        Trade
                      </button>
                      <button disabled={busy} onClick={() => void action(() => act(r, 'remove'))}>
                        Remove friend
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
        </section>
      ))}
      {data && (
        <div className="pagination">
          <button disabled={page === 1} onClick={() => setPage(page - 1)}>
            Previous
          </button>
          <span>
            Page {page} · {data.total} relationships
          </span>
          <button disabled={page * data.pageSize >= data.total} onClick={() => setPage(page + 1)}>
            Next
          </button>
        </div>
      )}
    </main>
  );
}
