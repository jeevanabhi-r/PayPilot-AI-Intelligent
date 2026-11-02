import React, { useState } from 'react';
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  updateProfile,
} from 'firebase/auth';
import { auth } from '../firebase';

export default function Auth() {
  const [mode, setMode] = useState('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      if (mode === 'reset') {
        await sendPasswordResetEmail(auth, email);
        setMessage('Password-reset email sent.');
        return;
      }
      if (mode === 'signup') {
        const result = await createUserWithEmailAndPassword(auth, email, password);
        await updateProfile(result.user, { displayName: name });
        const { saveFirebaseUserProfile } = await import('../firebaseProfile');
        await saveFirebaseUserProfile(result.user, name, email);
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function google() {
    try {
      setBusy(true);
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <section>
        <p className="eyebrow">PAYPILOT AI</p>
        <h1>Commerce intelligence,<br /><i>under your control.</i></h1>
        <p>Research verified offers, keep a budget, and approve every PayPal purchase yourself.</p>
      </section>
      <form onSubmit={submit} className="card">
        <h2>{mode === 'reset' ? 'Reset password' : mode === 'signup' ? 'Create account' : 'Welcome back'}</h2>
        {message && <p className="notice" role="status">{message}</p>}
        {mode === 'signup' && (
          <label htmlFor="auth-name">
            Name
            <input
              id="auth-name"
              required
              autoComplete="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
        )}
        <label htmlFor="auth-email">
          Email
          <input
            id="auth-email"
            required
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        {mode !== 'reset' && (
          <label htmlFor="auth-password">
            Password
            <input
              id="auth-password"
              required
              minLength="6"
              type="password"
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
        )}
        <button disabled={busy}>
          {busy ? 'Working…' : mode === 'reset' ? 'Send reset link' : mode === 'signup' ? 'Create account' : 'Sign in'}
        </button>
        {mode !== 'reset' && (
          <button type="button" className="secondary" onClick={google}>
            Continue with Google
          </button>
        )}
        <nav aria-label="Account options">
          <button type="button" onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}>
            {mode === 'login' ? 'Create account' : 'Sign in'}
          </button>
          <button type="button" onClick={() => setMode('reset')}>Forgot password?</button>
        </nav>
      </form>
    </main>
  );
}
