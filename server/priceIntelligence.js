import crypto from 'node:crypto';
import { isValidLiveListingUrl, normalizeProduct } from './productModel.js';

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

function productKey(productId) {
  return crypto.createHash('sha256').update(productId).digest('hex');
}

function validPrice(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) <= 1_000_000;
}

export function getWishlistProductIdentity(item) {
  if (!item || typeof item !== 'object') return null;
  const listingUrl = item.listingUrl || item.retailerUrl;
  if (item.dataType === 'DEMO') {
    return { dataType: 'DEMO', productId: item.productId || null };
  }
  if ((item.dataType && item.dataType !== 'LIVE') || item.external !== true) return null;
  if (!isValidLiveListingUrl(listingUrl)) return null;
  const productId = typeof item.productId === 'string' && item.productId.trim()
    ? item.productId.trim()
    : null;
  return { dataType: 'LIVE', productId, listingUrl };
}

function sameListingUrl(left, right) {
  if (!isValidLiveListingUrl(left) || !isValidLiveListingUrl(right)) return false;
  const leftUrl = new URL(left);
  const rightUrl = new URL(right);
  return leftUrl.hostname.toLowerCase() === rightUrl.hostname.toLowerCase()
    && leftUrl.pathname.toLowerCase() === rightUrl.pathname.toLowerCase();
}

export function matchesSavedListing(identity, product) {
  return identity?.dataType === 'LIVE'
    && (identity.productId
      ? identity.productId === product.productId
      : sameListingUrl(identity.listingUrl, product.listingUrl));
}

function targetFields(item) {
  const price = item.targetPrice;
  const currency = typeof item.targetCurrency === 'string' ? item.targetCurrency.toUpperCase() : '';
  return validPrice(price) && CURRENCY_PATTERN.test(currency) && currency === item.currency
    ? { targetPrice: Number(price), targetCurrency: currency }
    : { targetPrice: null, targetCurrency: null };
}

function publicSnapshot(snapshot) {
  return {
    productId: snapshot.productId,
    source: snapshot.source,
    currency: snapshot.currency,
    price: snapshot.price,
    dataType: 'LIVE',
    observedAt: snapshot.observedAt,
  };
}

export function priceChangeSummary(snapshots) {
  const ordered = [...snapshots].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  const latest = ordered.at(-1) || null;
  const previous = ordered.at(-2) || null;
  const sameSeries = ordered.length >= 2 && ordered.every((snapshot) => (
    snapshot.currency === latest.currency && snapshot.source === latest.source
  ));
  return {
    latest: latest ? publicSnapshot(latest) : null,
    previous: sameSeries ? publicSnapshot(previous) : null,
    historyCount: ordered.length,
    minimum: sameSeries
      ? Math.min(...ordered.map((snapshot) => snapshot.price))
      : null,
    maximum: sameSeries
      ? Math.max(...ordered.map((snapshot) => snapshot.price))
      : null,
    changeAmount: sameSeries ? Number((latest.price - previous.price).toFixed(2)) : null,
    changePercent: sameSeries && previous.price > 0
      ? Number((((latest.price - previous.price) / previous.price) * 100).toFixed(2))
      : null,
  };
}

function makeAlertId(kind, productId, previousSnapshotId, price, currency, targetPrice = null) {
  return crypto.createHash('sha256')
    .update([kind, productId, previousSnapshotId || 'first-observation', price, currency, targetPrice ?? ''].join('|'))
    .digest('hex');
}

function providerRecord(input) {
  const product = normalizeProduct(input);
  if (!product || product.dataType !== 'LIVE') return null;
  return product;
}

export function createPriceIntelligenceService({ now = () => new Date() } = {}) {
  function wishlistCollection(db, uid) {
    return db.collection('users').doc(uid).collection('wishlist');
  }

  function historyCollection(db, uid, productId) {
    return db.collection('users').doc(uid)
      .collection('priceTracking').doc(productKey(productId))
      .collection('snapshots');
  }

  function trackingDocument(db, uid, productId) {
    return db.collection('users').doc(uid).collection('priceTracking').doc(productKey(productId));
  }

  function alertCollection(db, uid) {
    return db.collection('users').doc(uid).collection('priceAlerts');
  }

  async function recordObservation(db, uid, wishlistId, inputProduct) {
    const product = providerRecord(inputProduct);
    if (!product) return { recorded: false, reason: 'Only validated LIVE provider products can be tracked.' };
    const itemRef = wishlistCollection(db, uid).doc(wishlistId);
    const itemSnapshot = await itemRef.get();
    if (!itemSnapshot.exists) return { recorded: false, reason: 'The saved product was not found.' };
    const item = itemSnapshot.data();
    const identity = getWishlistProductIdentity(item);
    if (!matchesSavedListing(identity, product)) {
      return { recorded: false, reason: 'Provider result does not match the saved LIVE listing.' };
    }

    const trackingRef = trackingDocument(db, uid, product.productId);
    const snapshotRef = historyCollection(db, uid, product.productId).doc();
    const observedAt = now().toISOString();
    const alerts = alertCollection(db, uid);
    let result = { recorded: true, snapshot: null, alertsCreated: [] };
    await db.runTransaction(async (transaction) => {
      const [trackingSnapshot, currentItemSnapshot] = await Promise.all([
        transaction.get(trackingRef),
        transaction.get(itemRef),
      ]);
      if (!currentItemSnapshot.exists) {
        result = { recorded: false, reason: 'The saved product was not found.' };
        return;
      }
      const currentItem = currentItemSnapshot.data();
      const currentIdentity = getWishlistProductIdentity(currentItem);
      if (!matchesSavedListing(currentIdentity, product)) {
        result = { recorded: false, reason: 'Provider result does not match the saved LIVE listing.' };
        return;
      }

      const previousTracking = trackingSnapshot.exists ? trackingSnapshot.data() : null;
      const sameSeries = previousTracking
        && previousTracking.currency === product.currency
        && previousTracking.source === product.source;
      const snapshot = {
        productId: product.productId,
        source: product.source,
        currency: product.currency,
        price: product.price,
        dataType: 'LIVE',
        observedAt,
      };
      const target = targetFields(currentItem);
      const alertsCreated = [];
      const previousPrice = sameSeries ? previousTracking.latestPrice : null;
      const previousSnapshotId = sameSeries ? previousTracking.latestSnapshotId : null;
      const alertCandidates = [];
      if (previousPrice !== null && product.price < previousPrice) {
        const alertId = makeAlertId('price-drop', product.productId, previousSnapshotId, product.price, product.currency);
        alertCandidates.push({
          ref: alerts.doc(alertId),
          data: {
            productId: product.productId,
            wishlistId,
            title: product.title,
            type: 'price-drop',
            previousPrice,
            currentPrice: product.price,
            currency: product.currency,
            source: product.source,
            observedAt,
            read: false,
          },
        });
      }
      const reachedTarget = target.targetPrice !== null
        && target.targetCurrency === product.currency
        && product.price <= target.targetPrice
        && (previousPrice === null
          || previousPrice > target.targetPrice
          || (currentItem.targetUpdatedAt
            && Date.parse(currentItem.targetUpdatedAt) > Date.parse(previousTracking?.latestAt || '')));
      if (reachedTarget) {
        const alertId = makeAlertId('target-reached', product.productId, previousSnapshotId, product.price, product.currency, target.targetPrice);
        alertCandidates.push({
          ref: alerts.doc(alertId),
          data: {
            productId: product.productId,
            wishlistId,
            title: product.title,
            type: 'target-reached',
            targetPrice: target.targetPrice,
            currentPrice: product.price,
            currency: product.currency,
            source: product.source,
            observedAt,
            read: false,
          },
        });
      }
      const existingAlertSnapshots = await Promise.all(alertCandidates.map(({ ref }) => transaction.get(ref)));
      transaction.create(snapshotRef, snapshot);
      alertCandidates.forEach(({ ref, data }, index) => {
        if (existingAlertSnapshots[index].exists) return;
        transaction.create(ref, data);
        alertsCreated.push(data);
      });
      const resetSeries = !sameSeries;
      transaction.set(trackingRef, {
        productId: product.productId,
        source: product.source,
        currency: product.currency,
        latestPrice: product.price,
        latestAt: observedAt,
        latestSnapshotId: snapshotRef.id,
        observationCount: resetSeries ? 1 : (previousTracking.observationCount || 0) + 1,
        minimum: resetSeries ? product.price : Math.min(previousTracking.minimum, product.price),
        maximum: resetSeries ? product.price : Math.max(previousTracking.maximum, product.price),
      });
      if (!currentIdentity.productId) {
        transaction.update(itemRef, {
          productId: product.productId,
          dataType: 'LIVE',
          title: currentItem.title || currentItem.name || product.title,
        });
      }
      result = { recorded: true, snapshot: publicSnapshot(snapshot), alertsCreated };
    });
    return result;
  }

  async function observeSearchResults(db, uid, products) {
    if (!db || !Array.isArray(products) || !products.length) return { recordedCount: 0, errors: [] };
    const wishlistSnapshot = await wishlistCollection(db, uid).get();
    const liveItems = wishlistSnapshot.docs
      .map((doc) => ({ id: doc.id, ...doc.data(), identity: getWishlistProductIdentity(doc.data()) }))
      .filter((item) => item.identity?.dataType === 'LIVE');
    const byProductId = new Map(liveItems.filter((item) => item.identity.productId)
      .map((item) => [item.identity.productId, item]));
    const recorded = [];
    const errors = [];
    for (const candidate of products) {
      if (candidate?.dataType !== 'LIVE') continue;
      const product = providerRecord(candidate);
      const item = product && (
        byProductId.get(product.productId)
        || liveItems.find((saved) => !saved.identity.productId && sameListingUrl(saved.identity.listingUrl, product.listingUrl))
      );
      if (!item) continue;
      try {
        const observation = await recordObservation(db, uid, item.id, product);
        if (observation.recorded) recorded.push(observation);
        else errors.push({ productId: product.productId, reason: observation.reason });
      } catch (error) {
        errors.push({ productId: product.productId, reason: error.message });
      }
    }
    return { recordedCount: recorded.length, errors };
  }

  async function listUserPrices(db, uid) {
    const savedSnapshot = await wishlistCollection(db, uid).get();
    const alertsSnapshot = await alertCollection(db, uid).get();
    const alerts = alertsSnapshot.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))
      .slice(0, 100);
    const items = [];
    for (const doc of savedSnapshot.docs) {
      const product = doc.data();
      const identity = getWishlistProductIdentity(product);
      const target = targetFields(product);
      if (identity?.dataType !== 'LIVE') {
        items.push({
          id: doc.id,
          ...product,
          ...target,
          trackingStatus: product.dataType === 'DEMO' ? 'sample-unavailable' : 'unavailable',
          trackingMessage: product.dataType === 'DEMO'
            ? 'Sample products do not have live price tracking or price alerts.'
            : 'This saved product does not have a verifiable LIVE provider listing.',
          history: [],
          historyCount: 0,
          minimum: null,
          maximum: null,
          currentPrice: null,
        });
        continue;
      }
      if (!identity.productId) {
        items.push({
          id: doc.id,
          ...product,
          ...target,
          trackingStatus: 'awaiting-refresh',
          trackingMessage: 'This older saved listing needs one exact LIVE provider refresh before price tracking can begin.',
          history: [],
          historyCount: 0,
          minimum: null,
          maximum: null,
          currentPrice: null,
        });
        continue;
      }
      const trackingSnapshot = await trackingDocument(db, uid, identity.productId).get();
      const tracking = trackingSnapshot.exists ? trackingSnapshot.data() : null;
      const snapshotsQuery = historyCollection(db, uid, identity.productId).orderBy('observedAt', 'desc').limit(100);
      const historySnapshot = await snapshotsQuery.get();
      const series = historySnapshot.docs.map((snapshot) => snapshot.data())
        .filter((snapshot) => snapshot.dataType === 'LIVE'
          && snapshot.productId === identity.productId
          && snapshot.source === tracking?.source
          && snapshot.currency === tracking?.currency)
        .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
      const change = priceChangeSummary(series);
      const enoughHistory = Number(tracking?.observationCount) >= 2
        && tracking?.source === product.source;
      const currencyMismatch = Boolean(tracking?.currency && product.currency && tracking.currency !== product.currency);
      const baseMessage = enoughHistory
        ? 'History updates when a provider refresh occurs; no background monitoring is configured.'
        : 'Price history starts after a matching LIVE provider refresh; no background monitoring is configured.';
      const currencyMessage = currencyMismatch
        ? ` Provider currency changed to ${tracking.currency}; values are kept separate from the saved ${product.currency} currency.${target.targetPrice !== null ? ' Target-price alerts are disabled until provider currency matches the saved currency.' : ''}`
        : '';
      items.push({
        id: doc.id,
        ...product,
        productId: identity.productId,
        dataType: 'LIVE',
        ...target,
        trackingStatus: enoughHistory ? 'tracking' : series.length >= 1 ? 'collecting-history' : 'awaiting-refresh',
        trackingMessage: `${baseMessage}${currencyMessage}`,
        history: series.map(publicSnapshot),
        ...change,
        historyCount: tracking?.observationCount || 0,
        minimum: enoughHistory ? tracking.minimum : null,
        maximum: enoughHistory ? tracking.maximum : null,
        currentPrice: change.latest?.price ?? null,
        currentCurrency: change.latest?.currency || product.currency || null,
      });
    }
    return { items, alerts };
  }

  async function setTarget(db, uid, wishlistId, price, currency) {
    if (!validPrice(price)) throw new TypeError('Target price must be greater than zero and at most 1,000,000.');
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new TypeError('Provide a valid three-letter target currency.');
    }
    const itemRef = wishlistCollection(db, uid).doc(wishlistId);
    const snapshot = await itemRef.get();
    if (!snapshot.exists) return { found: false };
    const item = snapshot.data();
    if (currency !== String(item.currency || '').toUpperCase()) {
      throw new TypeError('Target currency must match the saved product currency; conversions are not performed.');
    }
    const updatedAt = now().toISOString();
    await itemRef.update({ targetPrice: Number(price), targetCurrency: currency, targetUpdatedAt: updatedAt });
    return { found: true, targetPrice: Number(price), targetCurrency: currency, targetUpdatedAt: updatedAt };
  }

  async function deleteTarget(db, uid, wishlistId) {
    const itemRef = wishlistCollection(db, uid).doc(wishlistId);
    const snapshot = await itemRef.get();
    if (!snapshot.exists) return { found: false };
    await itemRef.update({ targetPrice: null, targetCurrency: null, targetUpdatedAt: now().toISOString() });
    return { found: true };
  }

  async function getSavedLiveItem(db, uid, wishlistId) {
    const snapshot = await wishlistCollection(db, uid).doc(wishlistId).get();
    if (!snapshot.exists) return null;
    const item = snapshot.data();
    const identity = getWishlistProductIdentity(item);
    return identity?.dataType === 'LIVE' ? { item, identity } : null;
  }

  return {
    recordObservation,
    observeSearchResults,
    listUserPrices,
    setTarget,
    deleteTarget,
    getSavedLiveItem,
    matchesSavedListing,
  };
}

export const priceIntelligence = createPriceIntelligenceService();
