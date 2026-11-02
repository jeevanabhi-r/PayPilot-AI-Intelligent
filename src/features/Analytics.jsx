import React, { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot } from 'firebase/firestore';
import { money } from '../api';
import { getDb } from '../firebase';

export default function Analytics({ user }) {
  const [items, setItems] = useState([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    let unsubscribe;
    getDb().then((db) => {
      if (cancelled) return;
      unsubscribe = onSnapshot(
        collection(db, 'users', user.uid, 'transactions'),
        (snapshot) => setItems(snapshot.docs.map((document) => document.data())),
        (snapshotError) => {
          setItems([]);
          setError(`Analytics could not be loaded: ${snapshotError.message}`);
        },
      );
    }).catch((loadError) => {
      if (!cancelled) setError(`Analytics could not be loaded: ${loadError.message}`);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [user.uid]);
  const total = useMemo(() => items.reduce((sum, item) => sum + Number(item.amount || 0), 0), [items]);
  return <section><p className="eyebrow">SPENDING INSIGHTS</p><h1>Measured from verified purchases</h1>{error && <p className="notice">{error}</p>}<div className="metrics"><article><small>Completed purchases</small><strong>{items.length}</strong></article><article><small>Total spend</small><strong>{money(total)}</strong></article><article><small>Average order</small><strong>{money(items.length ? total / items.length : 0)}</strong></article></div><div className="empty">Analytics uses PayPilot’s recorded, verified transaction history—not a bank balance or estimates.</div></section>;
}
