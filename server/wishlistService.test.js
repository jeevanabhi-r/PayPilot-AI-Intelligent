import test from 'node:test';
import assert from 'node:assert/strict';
import { createWishlistService } from './wishlistService.js';

const providerProduct = {
  productId: 'ebay:item-123',
  dataType: 'LIVE',
  title: 'Sony wireless headphones',
  brand: 'Sony',
  category: 'Headphones',
  price: 99.99,
  currency: 'USD',
  source: 'eBay Browse API',
  listingUrl: 'https://www.ebay.com/itm/item-123',
  retailerUrl: 'https://www.ebay.com/itm/item-123',
  availability: 'In stock',
  merchant: 'provider-seller',
  condition: 'New',
};

function memoryDb() {
  const saved = [];
  return {
    saved,
    collection(name) {
      assert.equal(name, 'users');
      return {
        doc(uid) {
          return {
            collection(subcollection) {
              assert.equal(subcollection, 'wishlist');
              return {
                async add(item) {
                  saved.push({ uid, item });
                  return { id: 'saved-item-id' };
                },
              };
            },
          };
        },
      };
    },
  };
}

test('LIVE wishlist saves re-fetch and persist the matching provider product only', async () => {
  const db = memoryDb();
  const queries = [];
  const service = createWishlistService({
    searchProducts: async (query) => {
      queries.push(query);
      return { products: [providerProduct] };
    },
    now: () => new Date('2026-11-01T10:00:00.000Z'),
  });

  const result = await service.saveVerifiedLiveProduct(db, 'user-1', {
    productId: providerProduct.productId,
    query: providerProduct.title,
    price: 0.01,
    source: 'forged source',
  });

  assert.deepEqual(queries, [providerProduct.title]);
  assert.equal(result.found, true);
  assert.equal(result.id, 'saved-item-id');
  assert.equal(db.saved[0].uid, 'user-1');
  assert.equal(db.saved[0].item.price, providerProduct.price);
  assert.equal(db.saved[0].item.source, 'eBay Browse API');
  assert.equal(db.saved[0].item.createdAt, '2026-11-01T10:00:00.000Z');
  assert.equal(db.saved[0].item.external, true);
});

test('LIVE wishlist save rejects unmatched and untrusted provider records', async () => {
  for (const product of [
    { ...providerProduct, productId: 'ebay:another-item' },
    { ...providerProduct, listingUrl: 'https://ebay.com.attacker/itm/item-123' },
    { ...providerProduct, source: 'Unknown provider' },
    { ...providerProduct, dataType: 'DEMO' },
  ]) {
    const db = memoryDb();
    const service = createWishlistService({
      searchProducts: async () => ({ products: [product] }),
    });
    const result = await service.saveVerifiedLiveProduct(db, 'user-1', {
      productId: providerProduct.productId,
      query: 'Sony headphones',
    });
    assert.equal(result.found, false);
    assert.equal(db.saved.length, 0);
  }
});

test('LIVE wishlist save validates client input before searching', async () => {
  let searchCalls = 0;
  const service = createWishlistService({
    searchProducts: async () => {
      searchCalls += 1;
      return { products: [providerProduct] };
    },
  });
  await assert.rejects(
    service.saveVerifiedLiveProduct(memoryDb(), 'user-1', { productId: '', query: 'x' }),
    /valid product ID and search query/,
  );
  assert.equal(searchCalls, 0);
});
