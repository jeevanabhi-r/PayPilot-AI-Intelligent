import React, { useEffect, useMemo, useState } from 'react';
import { collection, deleteDoc, doc, onSnapshot } from 'firebase/firestore';
import { api, money } from '../api';
import { getDb } from '../firebase';

function PriceChart({ history, currency, title, minimum, maximum }) {
  if (!Array.isArray(history) || history.length < 2) {
    return <p className="price-history-empty">Historical price data unavailable. A chart requires at least two real provider observations.</p>;
  }
  const prices = history.map((entry) => entry.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const points = history.map((entry, index) => {
    const x = history.length === 1 ? 50 : 5 + index / (history.length - 1) * 90;
    const y = 42 - (entry.price - min) / range * 34;
    return `${x},${y}`;
  }).join(' ');
  return <div className="price-chart-wrap">
    <svg className="price-chart" viewBox="0 0 100 48" role="img" aria-label={`Observed ${currency} price history for ${title}`}>
      <line x1="5" y1="43" x2="95" y2="43" className="price-chart-axis"/>
      <polyline points={points} className="price-chart-line"/>
      {history.map((entry, index) => {
        const x = 5 + index / (history.length - 1) * 90;
        const y = 42 - (entry.price - min) / range * 34;
        return <circle key={`${entry.observedAt}-${index}`} cx={x} cy={y} r="1.5" className="price-chart-point">
          <title>{`${new Date(entry.observedAt).toLocaleString()}: ${money(entry.price, entry.currency)}`}</title>
        </circle>;
      })}
    </svg>
    <div className="price-chart-labels"><span>Historical min: {minimum === null ? 'Not available' : money(minimum, currency)}</span><span>Historical max: {maximum === null ? 'Not available' : money(maximum, currency)}</span></div>
  </div>;
}

function WishlistPriceCard({ item, onRefresh, onReload, onRemove }) {
  const [targetPrice, setTargetPrice] = useState(item.targetPrice ? String(item.targetPrice) : '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const isLive = item.dataType === 'LIVE' || (!item.dataType && item.external === true);
  const currency = item.currentCurrency || item.currency || 'USD';
  const displayedPrice = isLive ? item.currentPrice ?? item.price : item.price;
  const displayedPriceLabel = isLive
    ? item.currentPrice === null ? 'Last saved price' : 'Current observed price'
    : 'Sample price';

  useEffect(() => {
    setTargetPrice(item.targetPrice ? String(item.targetPrice) : '');
  }, [item.targetPrice]);

  async function saveTarget(event) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      await api(`/api/price-intelligence/${encodeURIComponent(item.id)}/target`, {
        method: 'PUT',
        body: JSON.stringify({ targetPrice: Number(targetPrice), targetCurrency: item.currency }),
      });
      setMessage('Target price saved.');
      await onReload();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function removeTarget() {
    setBusy(true);
    setMessage('');
    try {
      await api(`/api/price-intelligence/${encodeURIComponent(item.id)}/target`, { method: 'DELETE' });
      setTargetPrice('');
      setMessage('Target price removed.');
      await onReload();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function refreshPrice() {
    setBusy(true);
    setMessage('');
    try {
      const result = await onRefresh(item.id);
      setMessage(result.message);
      await onReload();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  return <article className="product price-intelligence-card">
    <small>{isLive ? 'LIVE · PROVIDER LISTING' : 'DEMO · SAMPLE DATA'}</small>
    <h3>{item.title || item.name}</h3>
    <p>{item.brand || 'Brand not provided'} · {item.category || 'Category unavailable'}</p>
    <strong>{displayedPriceLabel}: {displayedPrice ? money(displayedPrice, currency) : 'Not available'}</strong>
    {item.targetPrice !== null && item.targetPrice !== undefined && <p>Target price: {money(item.targetPrice, item.targetCurrency)}</p>}
    {item.changePercent !== null && item.changePercent !== undefined && <p className={item.changePercent < 0 ? 'good' : ''}>
      Change since previous observation: {item.changePercent > 0 ? '+' : ''}{item.changePercent}% ({item.changeAmount > 0 ? '+' : ''}{money(item.changeAmount, currency)})
      {item.changePercent < 0 && ` · ${Math.abs(item.changePercent)}% price drop`}
    </p>}
    {item.historyCount >= 2 && <p>Historical range ({item.historyCount} provider observations): {money(item.minimum, currency)} – {money(item.maximum, currency)}</p>}
    {!isLive && <p className="price-tracking-status">Sample data; price history and live price alerts are unavailable.</p>}
    {isLive && <p className="price-tracking-status">{item.trackingMessage || 'Price tracking data is unavailable. Try a provider refresh later.'}</p>}
    {isLive && <PriceChart history={item.history} currency={currency} title={item.title || item.name} minimum={item.minimum} maximum={item.maximum}/>}
    <form className="price-target-form" onSubmit={saveTarget}>
      <label htmlFor={`target-${item.id}`}>Target price ({item.currency})
        <input
          id={`target-${item.id}`}
          required
          type="number"
          min="0.01"
          max="1000000"
          step="0.01"
          value={targetPrice}
          onChange={(event) => setTargetPrice(event.target.value)}
        />
      </label>
      <button disabled={busy}>{busy ? 'Saving…' : item.targetPrice ? 'Update target' : 'Set target'}</button>
      {item.targetPrice !== null && item.targetPrice !== undefined && <button type="button" className="secondary" disabled={busy} onClick={removeTarget}>Delete target</button>}
    </form>
    {!isLive && item.targetPrice !== null && item.targetPrice !== undefined && <p className="price-tracking-status">This target is for sample data only and will not trigger live alerts.</p>}
    {isLive && <button type="button" className="secondary" disabled={busy} onClick={refreshPrice}>
      {busy ? 'Refreshing…' : 'Refresh LIVE price'}
    </button>}
    {message && <p className="notice price-card-message">{message}</p>}
    <button type="button" className="secondary" onClick={() => onRemove(item.id)}>Remove from wishlist</button>
  </article>;
}

export default function Wishlist({ user }) {
  const [savedItems, setSavedItems] = useState([]);
  const [trackedItems, setTrackedItems] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [trackingMessage, setTrackingMessage] = useState('');
  const [error, setError] = useState('');
  const trackedById = useMemo(() => new Map(trackedItems.map((item) => [item.id, item])), [trackedItems]);

  async function loadPriceIntelligence() {
    const result = await api('/api/price-intelligence');
    setTrackedItems(result.items || []);
    setAlerts(result.alerts || []);
    setTrackingMessage(result.monitoring || '');
    setError('');
  }

  useEffect(() => {
    let cancelled = false;
    let unsubscribe;
    getDb().then((db) => {
      if (cancelled) return;
      unsubscribe = onSnapshot(
        collection(db, 'users', user.uid, 'wishlist'),
        (snapshot) => setSavedItems(snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }))),
        (snapshotError) => setError(`Wishlist could not be loaded: ${snapshotError.message}`),
      );
    }).catch((loadError) => setError(`Wishlist could not be loaded: ${loadError.message}`));
    loadPriceIntelligence().catch((loadError) => {
      setError(`Price tracking is unavailable: ${loadError.message}`);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [user.uid]);

  async function refreshPrice(wishlistId) {
    const result = await api(`/api/price-intelligence/${encodeURIComponent(wishlistId)}/refresh`, { method: 'POST' });
    return result;
  }

  async function removeItem(wishlistId) {
    try {
      const db = await getDb();
      await deleteDoc(doc(db, 'users', user.uid, 'wishlist', wishlistId));
    } catch (removeError) {
      setError(`Could not remove saved product: ${removeError.message}`);
    }
  }

  const items = savedItems.map((saved) => ({
    ...saved,
    ...(trackedById.get(saved.id) || {}),
  }));
  const alertTypes = {
    'price-drop': 'LIVE price drop',
    'target-reached': 'LIVE target price reached',
  };

  return <section>
    <p className="eyebrow">SAVED PRODUCTS</p>
    <h1>Wishlist & price intelligence</h1>
    <p>Price history and alerts are based only on matching LIVE provider refreshes. PayPilot does not run background monitoring.</p>
    {trackingMessage && <p className="notice">{trackingMessage}</p>}
    {error && <p className="notice price-error">{error}</p>}
    {alerts.length > 0 && <section className="price-alerts" aria-label="Price alerts">
      <h2>Price alerts</h2>
      {alerts.map((alert) => <article key={alert.id}>
        <small>{alertTypes[alert.type] || 'Price notification'} · LIVE</small>
        <strong>{alert.title}</strong>
        <p>{alert.type === 'target-reached'
          ? `Observed at ${money(alert.currentPrice, alert.currency)}; target was ${money(alert.targetPrice, alert.currency)}.`
          : `Price decreased from ${money(alert.previousPrice, alert.currency)} to ${money(alert.currentPrice, alert.currency)}.`}</p>
        <time dateTime={alert.observedAt}>{new Date(alert.observedAt).toLocaleString()}</time>
      </article>)}
    </section>}
    {items.length
      ? <div className="grid">{items.map((item) => <WishlistPriceCard
        key={item.id}
        item={item}
        onRefresh={refreshPrice}
        onReload={loadPriceIntelligence}
        onRemove={removeItem}
      />)}</div>
      : <div className="empty">Save LIVE or DEMO products from Discover to view price intelligence.</div>}
  </section>;
}
