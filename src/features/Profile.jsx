import React, { useEffect, useState } from 'react';
import { doc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore';
import { getDb } from '../firebase';

export default function Profile({ user }) {
  const [profile, setProfile] = useState({ preferences: { budget: '', categories: [] } });
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    let unsubscribe;
    getDb().then((db) => {
      if (cancelled) return;
      unsubscribe = onSnapshot(doc(db, 'users', user.uid), (snapshot) => {
        if (snapshot.exists()) setProfile(snapshot.data());
      });
    }).catch((loadError) => {
      if (!cancelled) setError(`Profile could not be loaded: ${loadError.message}`);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [user.uid]);

  async function save(event) {
    event.preventDefault();
    setError('');
    try {
      const db = await getDb();
      await setDoc(doc(db, 'users', user.uid), {
        preferences: profile.preferences || {},
        updatedAt: serverTimestamp(),
      }, { merge: true });
      setSaved('Saved.');
    } catch (saveError) {
      setError(`Profile could not be saved: ${saveError.message}`);
    }
  }

  return <section><p className="eyebrow">PROFILE & SETTINGS</p><h1>Your preferences</h1>{error && <p className="notice">{error}</p>}<form className="settings" onSubmit={save}><label>Shopping budget<input value={profile.preferences?.budget || ''} onChange={(event) => setProfile({ ...profile, preferences: { ...profile.preferences, budget: event.target.value } })} placeholder="e.g. under $100"/></label><label>Preferred categories<input value={(profile.preferences?.categories || []).join(', ')} onChange={(event) => setProfile({ ...profile, preferences: { ...profile.preferences, categories: event.target.value.split(',').map((category) => category.trim()).filter(Boolean) } })} placeholder="electronics, workspace"/></label><button>Save preferences</button>{saved && <p className="notice">{saved}</p>}</form></section>;
}
