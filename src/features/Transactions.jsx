import React, { useEffect, useState } from 'react';
import { collection, limit, onSnapshot, orderBy, query } from 'firebase/firestore';
import { money } from '../api';
import { getDb } from '../firebase';

export default function Transactions({ user }) {
  const [items, setItems] = useState([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    let unsubscribe;
    getDb().then((db) => {
      if (cancelled) return;
      const transactionsQuery = query(
        collection(db, 'users', user.uid, 'transactions'),
        orderBy('createdAt', 'desc'),
        limit(50),
      );
      unsubscribe = onSnapshot(
        transactionsQuery,
        (snapshot) => setItems(snapshot.docs.map((document) => ({ id: document.id, ...document.data() }))),
        (snapshotError) => {
          setItems([]);
          setError(`Transactions could not be loaded: ${snapshotError.message}`);
        },
      );
    }).catch((loadError) => {
      if (!cancelled) setError(`Transactions could not be loaded: ${loadError.message}`);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [user.uid]);
  return <section><p className="eyebrow">VERIFIED PAYMENTS</p><h1>Order & transaction history</h1>{error && <p className="notice">{error}</p>}{items.length ? <div className="list">{items.map((item) => <article key={item.id}><div><b>{item.productName}</b><small>{item.orderId} · {item.createdAt?.toDate?.().toLocaleString() || 'Recorded recently'}</small></div><span className="good">{item.status}</span><strong>{money(item.amount, item.currency)}</strong></article>)}</div> : <div className="empty">Completed, server-verified PayPal transactions appear here. Simulated payments are never recorded.</div>}</section>;
}
