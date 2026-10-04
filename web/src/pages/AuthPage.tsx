import { useState } from 'react';
import { Swords, ArrowRight } from 'lucide-react';
import { authClient } from '../api';
export function AuthPage() {
  const [register, setRegister] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <main className="auth-shell">
      <section className="auth-story">
        <Swords size={48} />
        <p className="eyebrow">THE WORLD IS IN YOUR CARDS</p>
        <h1>
          A little knowledge.
          <br />
          <em>A lot of power.</em>
        </h1>
        <p>
          Collect remarkable people, places, and ideas. Challenge a friend. Defend with what you
          know.
        </p>
        <div className="auth-chips">
          <span>5 cards per pack</span>
          <span>5 minds per team</span>
          <span>One friendly rivalry</span>
        </div>
      </section>
      <form
        className="auth-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          const d = new FormData(e.currentTarget);
          try {
            const input = { email: String(d.get('email')), password: String(d.get('password')) };
            const r = register
              ? await authClient.signUp.email({ ...input, name: String(d.get('name')) })
              : await authClient.signIn.email(input);
            if (r.error) setError(r.error.message ?? 'Authentication failed');
          } catch {
            setError('Unable to reach the server');
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="eyebrow">WELCOME TO TRIVATTLE</p>
        <h2>{register ? 'Start your collection' : 'Welcome back'}</h2>
        <p className="muted">
          {register
            ? 'Your starter packs are waiting. Open them to discover your first cards.'
            : 'Your cards and your next challenge are waiting.'}
        </p>
        {register && (
          <label>
            Display name
            <input name="name" required maxLength={60} autoComplete="nickname" />
          </label>
        )}
        <label>
          Email
          <input name="email" type="email" required autoComplete="email" />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            minLength={8}
            maxLength={128}
            required
            autoComplete={register ? 'new-password' : 'current-password'}
          />
        </label>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy}>
          {busy ? 'Please wait…' : register ? 'Create account' : 'Log in'}
          <ArrowRight size={16} />
        </button>
        <button
          type="button"
          className="quiet"
          onClick={() => {
            setRegister(!register);
            setError('');
          }}
        >
          {register ? 'Already have an account? Log in' : 'New here? Register'}
        </button>
      </form>
    </main>
  );
}
