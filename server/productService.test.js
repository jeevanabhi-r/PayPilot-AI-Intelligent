import test from 'node:test';
import assert from 'node:assert/strict';
import { demoProducts } from './demoProducts.js';
import { deduplicateProducts, normalizeProduct, productSourceMatches } from './productModel.js';
import { createProductService } from './productService.js';

const demoInput = {
  productId: 'demo-phone',
  title: 'Samsung Galaxy S24',
  brand: 'Samsung',
  category: 'Smartphones',
  price: 749,
  currency: 'USD',
  specifications: { storage: '128GB' },
  image: null,
  source: 'Untrusted sample source',
  listingUrl: 'https://example.com/fake-listing',
  availability: 'In stock',
  dataType: 'DEMO',
};

test('unified product validation requires core fields and secure live listing URLs', () => {
  assert.equal(normalizeProduct({ ...demoInput, dataType: 'UNKNOWN' }), null);
  assert.equal(normalizeProduct({ ...demoInput, price: 0 }), null);
  assert.equal(normalizeProduct({ ...demoInput, currency: 'US' }), null);
  assert.equal(normalizeProduct({
    ...demoInput,
    dataType: 'LIVE',
    listingUrl: 'http://www.ebay.com/itm/123',
  }), null);
  assert.equal(normalizeProduct({
    ...demoInput,
    dataType: 'LIVE',
    listingUrl: 'https://ebay.com.attacker/itm/123',
  }), null);
  assert.equal(normalizeProduct({
    ...demoInput,
    dataType: 'LIVE',
    listingUrl: 'https://store.ebay.com/itm/123',
  }), null);
  const demo = normalizeProduct(demoInput);
  assert.equal(demo.source, 'PayPilot Curated Demo Catalogue');
  assert.equal(demo.listingUrl, null);
  assert.equal(demo.retailerUrl, null);
  assert.equal(demo.availability, 'Sample data');
  const live = normalizeProduct({
    ...demoInput,
    productId: 'ebay:123',
    dataType: 'LIVE',
    source: 'eBay Browse API',
    listingUrl: 'https://www.ebay.com/itm/123',
  });
  assert.equal(live.dataType, 'LIVE');
  assert.equal(live.listingUrl, 'https://www.ebay.com/itm/123');
});

test('product source identification distinguishes live and demo records', () => {
  const demo = normalizeProduct(demoInput);
  const live = normalizeProduct({
    ...demoInput,
    productId: 'ebay:123',
    dataType: 'LIVE',
    listingUrl: 'https://www.ebay.com/itm/123',
  });
  assert.equal(productSourceMatches(demo, 'DEMO'), true);
  assert.equal(productSourceMatches(demo, 'LIVE'), false);
  assert.equal(productSourceMatches(live, 'LIVE'), true);
  assert.equal(productSourceMatches(live, 'DEMO'), false);
});

test('unified product deduplication removes repeated item IDs and titles', () => {
  const first = normalizeProduct({
    productId: 'ebay:123', title: 'Samsung Galaxy S24', category: 'Smartphones',
    price: 749, currency: 'USD', dataType: 'LIVE', listingUrl: 'https://www.ebay.com/itm/123',
  });
  const sameItem = normalizeProduct({
    ...first, productId: 'ebay:123', title: 'Different title for same item',
  });
  const sameTitle = normalizeProduct({
    ...first, productId: 'ebay:456', title: ' Samsung Galaxy S24!! ',
    listingUrl: 'https://www.ebay.com/itm/456',
  });
  const differentModel = normalizeProduct({
    ...first, productId: 'ebay:789', title: 'Samsung Galaxy S24 Ultra',
    listingUrl: 'https://www.ebay.com/itm/789',
  });
  assert.deepEqual(deduplicateProducts([first, sameItem, sameTitle, differentModel]).map(({ productId }) => productId), [
    'ebay:123',
    'ebay:789',
  ]);
});

test('empty live provider results leave curated demo discovery available', async () => {
  const search = createProductService({
    liveSearch: async () => ({ provider: 'ebay-browse', products: [] }),
  });
  const result = await search('Samsung phone');
  assert.equal(result.provider, 'hybrid-product-service');
  assert.equal(result.liveCount, 0);
  assert.ok(result.demoCount > 0);
  assert.ok(result.products.every((product) => product.dataType === 'DEMO'));
  assert.ok(result.products.every((product) => product.source === 'PayPilot Curated Demo Catalogue'));
  assert.ok(result.products.every((product) => product.listingUrl === null && product.retailerUrl === null));
  assert.ok(result.message.includes('No live offers'));
  assert.ok(result.products.some((product) => product.brand === 'Samsung' && product.category === 'Smartphones'));
});

test('live provider failures keep demo discovery available and report the failure', async () => {
  const warnings = [];
  const search = createProductService({
    liveSearch: async () => { throw new Error('provider unavailable'); },
    logger: { warn: (message) => warnings.push(message) },
  });
  const result = await search('Samsung phone');
  assert.equal(result.liveSearchFailed, true);
  assert.equal(result.liveCount, 0);
  assert.ok(result.demoCount > 0);
  assert.ok(result.products.every((product) => product.dataType === 'DEMO'));
  assert.match(result.message, /Live eBay search failed/);
  assert.match(result.message, /clearly labeled sample data/);
  assert.equal(warnings.length, 1);
});

test('curated catalogue covers the requested device categories', () => {
  assert.deepEqual(
    [...new Set(demoProducts.map(({ category }) => category))].sort(),
    ['Headphones', 'Laptops', 'Smartphones', 'Smartwatches', 'Tablets'],
  );
});
