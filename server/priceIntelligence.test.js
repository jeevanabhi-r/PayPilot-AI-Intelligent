import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequireUser } from './auth.js';
import { createPriceIntelligenceService, priceChangeSummary } from './priceIntelligence.js';

class MemorySnapshot {
  constructor(id, data) {
    this.id = id;
    this.exists = data !== undefined;
    this._data = data;
  }

  data() {
    return this._data;
  }
}

class MemoryDocument {
  constructor(db, path) {
    this.db = db;
    this.path = path;
    this.id = path.split('/').at(-1);
  }

  collection(name) {
    return new MemoryCollection(this.db, `${this.path}/${name}`);
  }

  async get() {
    return new MemorySnapshot(this.id, this.db.values.get(this.path));
  }

  async set(data, options = {}) {
    const previous = this.db.values.get(this.path) || {};
    this.db.values.set(this.path, options.merge ? { ...previous, ...data } : data);
  }

  async update(data) {
    const previous = this.db.values.get(this.path);
    if (!previous) throw new Error('Document does not exist');
    this.db.values.set(this.path, { ...previous, ...data });
  }

  async create(data) {
    if (this.db.values.has(this.path)) throw new Error('Document already exists');
    this.db.values.set(this.path, data);
  }

  async delete() {
    this.db.values.delete(this.path);
  }
}

class MemoryCollection {
  constructor(db, path) {
    this.db = db;
    this.path = path;
  }

  doc(id = `auto-${++this.db.autoId}`) {
    return new MemoryDocument(this.db, `${this.path}/${id}`);
  }

  orderBy() {
    return this;
  }

  limit() {
    return this;
  }

  async get() {
    const prefix = `${this.path}/`;
    const docs = [...this.db.values.entries()]
      .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .map(([path, data]) => new MemorySnapshot(path.split('/').at(-1), data));
    return { docs, empty: docs.length === 0 };
  }
}

class MemoryFirestore {
  constructor() {
    this.values = new Map();
    this.autoId = 0;
  }

  collection(name) {
    return new MemoryCollection(this, name);
  }

  async runTransaction(callback) {
    return callback({
      get: (reference) => reference.get(),
      create: (reference, data) => reference.create(data),
      set: (reference, data, options) => reference.set(data, options),
      update: (reference, data) => reference.update(data),
    });
  }

  async saveWishlist(uid, wishlistId, item) {
    await this.collection('users').doc(uid).collection('wishlist').doc(wishlistId).set(item);
  }
}

function savedLive(overrides = {}) {
  return {
    productId: 'ebay:product-1',
    dataType: 'LIVE',
    title: 'Sony headphones',
    name: 'Sony headphones',
    price: 100,
    currency: 'USD',
    external: true,
    source: 'eBay Browse API',
    listingUrl: 'https://www.ebay.com/itm/product-1',
    retailerUrl: 'https://www.ebay.com/itm/product-1',
    targetPrice: null,
    targetCurrency: null,
    ...overrides,
  };
}

function providerProduct(price, overrides = {}) {
  return {
    productId: 'ebay:product-1',
    title: 'Sony headphones',
    brand: 'Sony',
    category: 'Headphones',
    price,
    currency: 'USD',
    specifications: {},
    dataType: 'LIVE',
    source: 'eBay Browse API',
    listingUrl: 'https://www.ebay.com/itm/product-1',
    ...overrides,
  };
}

function clock() {
  let time = Date.parse('2026-10-01T00:00:00.000Z');
  return {
    now: () => new Date(time),
    advance: () => { time += 60_000; },
  };
}

test('price snapshots are created only from matching validated LIVE provider observations', async () => {
  const db = new MemoryFirestore();
  await db.saveWishlist('user-a', 'wish-a', savedLive());
  const time = clock();
  const service = createPriceIntelligenceService({ now: time.now });
  const result = await service.recordObservation(db, 'user-a', 'wish-a', providerProduct(100));
  assert.equal(result.recorded, true);
  assert.equal(result.snapshot.price, 100);
  assert.equal(result.snapshot.currency, 'USD');
  assert.equal(result.snapshot.source, 'eBay Browse API');
  assert.equal(result.snapshot.dataType, 'LIVE');
  const listing = await service.listUserPrices(db, 'user-a');
  assert.equal(listing.items[0].historyCount, 1);
  assert.equal(listing.items[0].trackingStatus, 'collecting-history');
  assert.equal(listing.items[0].minimum, null);
});

test('historical minimum and maximum require at least two real observations', () => {
  const first = { price: 80, currency: 'USD', source: 'eBay Browse API', observedAt: '2026-10-01T00:00:00.000Z' };
  assert.equal(priceChangeSummary([first]).minimum, null);
  const second = { ...first, price: 60, observedAt: '2026-10-02T00:00:00.000Z' };
  const third = { ...first, price: 90, observedAt: '2026-10-03T00:00:00.000Z' };
  const summary = priceChangeSummary([first, second, third]);
  assert.equal(summary.minimum, 60);
  assert.equal(summary.maximum, 90);
  assert.equal(summary.changeAmount, 30);
  assert.equal(summary.changePercent, 50);
});

test('historical prices in different currencies are never aggregated', () => {
  const summary = priceChangeSummary([
    { price: 100, currency: 'USD', source: 'eBay Browse API', observedAt: '2026-10-01T00:00:00.000Z' },
    { price: 80, currency: 'EUR', source: 'eBay Browse API', observedAt: '2026-10-02T00:00:00.000Z' },
  ]);
  assert.equal(summary.minimum, null);
  assert.equal(summary.maximum, null);
  assert.equal(summary.changeAmount, null);
  assert.equal(summary.changePercent, null);
});

test('price decreases create one notification for each distinct observed drop', async () => {
  const db = new MemoryFirestore();
  await db.saveWishlist('user-a', 'wish-a', savedLive());
  const time = clock();
  const service = createPriceIntelligenceService({ now: time.now });
  await service.recordObservation(db, 'user-a', 'wish-a', providerProduct(100));
  time.advance();
  const drop = await service.recordObservation(db, 'user-a', 'wish-a', providerProduct(80));
  assert.equal(drop.alertsCreated.length, 1);
  assert.equal(drop.alertsCreated[0].type, 'price-drop');
  time.advance();
  const repeatedPrice = await service.recordObservation(db, 'user-a', 'wish-a', providerProduct(80));
  assert.equal(repeatedPrice.alertsCreated.length, 0);
  const result = await service.listUserPrices(db, 'user-a');
  assert.equal(result.alerts.filter((alert) => alert.type === 'price-drop').length, 1);
  assert.equal(result.items[0].changeAmount, 0);
});

test('target-price matches create user-scoped alerts once when the threshold is reached', async () => {
  const db = new MemoryFirestore();
  await db.saveWishlist('user-a', 'wish-a', savedLive());
  const time = clock();
  const service = createPriceIntelligenceService({ now: time.now });
  await service.recordObservation(db, 'user-a', 'wish-a', providerProduct(100));
  assert.equal((await service.setTarget(db, 'user-a', 'wish-a', 80, 'USD')).targetPrice, 80);
  time.advance();
  const reached = await service.recordObservation(db, 'user-a', 'wish-a', providerProduct(80));
  assert.ok(reached.alertsCreated.some((alert) => alert.type === 'target-reached'));
  time.advance();
  const belowTarget = await service.recordObservation(db, 'user-a', 'wish-a', providerProduct(70));
  assert.equal(belowTarget.alertsCreated.filter((alert) => alert.type === 'target-reached').length, 0);
  const result = await service.listUserPrices(db, 'user-a');
  assert.equal(result.alerts.filter((alert) => alert.type === 'target-reached').length, 1);
});

test('setting a target above an already observed price alerts on the next provider refresh', async () => {
  const db = new MemoryFirestore();
  await db.saveWishlist('user-a', 'wish-a', savedLive());
  const time = clock();
  const service = createPriceIntelligenceService({ now: time.now });
  await service.recordObservation(db, 'user-a', 'wish-a', providerProduct(70));
  time.advance();
  await service.setTarget(db, 'user-a', 'wish-a', 80, 'USD');
  time.advance();
  const result = await service.recordObservation(db, 'user-a', 'wish-a', providerProduct(70));
  assert.ok(result.alertsCreated.some((alert) => alert.type === 'target-reached'));
});

test('target price requires a positive amount and the saved product currency', async () => {
  const db = new MemoryFirestore();
  await db.saveWishlist('user-a', 'wish-a', savedLive());
  const service = createPriceIntelligenceService();
  await assert.rejects(service.setTarget(db, 'user-a', 'wish-a', 0, 'USD'), /greater than zero/);
  await assert.rejects(service.setTarget(db, 'user-a', 'wish-a', 80, 'EUR'), /must match/);
  const target = await service.setTarget(db, 'user-a', 'wish-a', 80.5, 'USD');
  assert.equal(target.targetPrice, 80.5);
  assert.deepEqual(await service.deleteTarget(db, 'user-a', 'wish-a'), { found: true });
});

test('provider currency changes reset the comparison series and never create cross-currency drops', async () => {
  const db = new MemoryFirestore();
  await db.saveWishlist('user-a', 'wish-a', savedLive());
  const time = clock();
  const service = createPriceIntelligenceService({ now: time.now });
  await service.recordObservation(db, 'user-a', 'wish-a', providerProduct(100, { currency: 'USD' }));
  time.advance();
  const changedCurrency = await service.recordObservation(db, 'user-a', 'wish-a', providerProduct(90, { currency: 'EUR' }));
  assert.equal(changedCurrency.alertsCreated.length, 0);
  const result = await service.listUserPrices(db, 'user-a');
  assert.equal(result.items[0].historyCount, 1);
  assert.equal(result.items[0].changePercent, null);
  await assert.rejects(service.setTarget(db, 'user-a', 'wish-a', 80, 'EUR'), /must match/);
});

test('missing history is unavailable, not synthesized from the saved product price', async () => {
  const db = new MemoryFirestore();
  await db.saveWishlist('user-a', 'wish-a', savedLive());
  const service = createPriceIntelligenceService();
  const result = await service.listUserPrices(db, 'user-a');
  assert.equal(result.items[0].history.length, 0);
  assert.equal(result.items[0].currentPrice, null);
  assert.equal(result.items[0].minimum, null);
  assert.equal(result.items[0].trackingStatus, 'awaiting-refresh');
});

test('DEMO products never create LIVE price snapshots or alerts', async () => {
  const db = new MemoryFirestore();
  await db.saveWishlist('user-a', 'demo', {
    productId: 'demo-headphones',
    dataType: 'DEMO',
    name: 'Sample headphones',
    title: 'Sample headphones',
    price: 50,
    currency: 'USD',
    external: false,
    source: 'PayPilot Curated Demo Catalogue',
  });
  const service = createPriceIntelligenceService();
  const result = await service.recordObservation(db, 'user-a', 'demo', {
    ...providerProduct(40),
    productId: 'demo-headphones',
    dataType: 'DEMO',
    listingUrl: null,
  });
  assert.equal(result.recorded, false);
  assert.match(result.reason, /Only validated LIVE/);
  const wishlist = await service.listUserPrices(db, 'user-a');
  assert.equal(wishlist.items[0].trackingStatus, 'sample-unavailable');
  assert.deepEqual(wishlist.alerts, []);
});

test('wishlist observations and alerts remain scoped to the authenticated user', async () => {
  const db = new MemoryFirestore();
  await db.saveWishlist('user-a', 'wish-a', savedLive());
  await db.saveWishlist('user-b', 'wish-b', savedLive());
  const time = clock();
  const service = createPriceIntelligenceService({ now: time.now });
  await service.recordObservation(db, 'user-a', 'wish-a', providerProduct(100));
  time.advance();
  await service.recordObservation(db, 'user-a', 'wish-a', providerProduct(80));
  const userA = await service.listUserPrices(db, 'user-a');
  const userB = await service.listUserPrices(db, 'user-b');
  assert.equal(userA.items[0].historyCount, 2);
  assert.equal(userA.alerts.length, 1);
  assert.equal(userB.items[0].historyCount, 0);
  assert.equal(userB.alerts.length, 0);
});

test('wishlist provider refresh integration records only exact saved LIVE product matches', async () => {
  const db = new MemoryFirestore();
  await db.saveWishlist('user-a', 'wish-a', savedLive());
  const service = createPriceIntelligenceService({ now: clock().now });
  const result = await service.observeSearchResults(db, 'user-a', [
    providerProduct(88),
    { ...providerProduct(20), productId: 'ebay:another-listing' },
    { ...providerProduct(1), dataType: 'DEMO', productId: 'demo-product', listingUrl: null },
  ]);
  assert.equal(result.recordedCount, 1);
  const listing = await service.listUserPrices(db, 'user-a');
  assert.equal(listing.items[0].historyCount, 1);
  assert.equal(listing.items[0].currentPrice, 88);
});

test('legacy wishlist entries bind to the exact provider URL before gaining a product ID', async () => {
  const db = new MemoryFirestore();
  await db.saveWishlist('user-a', 'legacy', {
    name: 'Sony headphones',
    price: 100,
    currency: 'USD',
    external: true,
    source: 'eBay Browse API',
    retailerUrl: 'https://www.ebay.com/itm/product-1?old=1',
  });
  const service = createPriceIntelligenceService({ now: clock().now });
  const result = await service.observeSearchResults(db, 'user-a', [providerProduct(90)]);
  assert.equal(result.recordedCount, 1);
  const saved = await db.collection('users').doc('user-a').collection('wishlist').doc('legacy').get();
  assert.equal(saved.data().productId, 'ebay:product-1');
  const listing = await service.listUserPrices(db, 'user-a');
  assert.equal(listing.items[0].currentPrice, 90);
});

test('unauthorized requests are rejected before price intelligence handlers proceed', async () => {
  let proceeded = false;
  const response = {
    statusCode: null,
    status(code) { this.statusCode = code; return this; },
    json() { return this; },
  };
  const requireUser = createRequireUser(() => ({
    verifyIdToken: async () => { throw new Error('invalid token'); },
  }));
  await requireUser({ headers: { authorization: 'Bearer invalid' } }, response, () => { proceeded = true; });
  assert.equal(response.statusCode, 401);
  assert.equal(proceeded, false);
});
