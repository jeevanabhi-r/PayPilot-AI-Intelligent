import test from 'node:test';
import assert from 'node:assert/strict';
import { demoProducts } from './demoProducts.js';
import { optimizeBudget } from './budgetOptimizer.js';

function liveProduct(productId, title, category, price, currency = 'USD', overrides = {}) {
  return {
    productId,
    title,
    brand: 'Dell',
    category,
    price,
    currency,
    specifications: { memory: '16GB', connectivity: 'Bluetooth' },
    dataType: 'LIVE',
    source: 'eBay Browse API',
    listingUrl: `https://www.ebay.com/itm/${productId}`,
    ...overrides,
  };
}

function optimize(products, overrides = {}) {
  return optimizeBudget({
    products,
    budget: 1000,
    currency: 'USD',
    categories: ['Smartphones', 'Headphones'],
    ...overrides,
  });
}

test('budget boundaries allow an exact fit but never exceed the total budget', () => {
  const products = [
    liveProduct('phone', 'Dell Smartphone', 'Smartphones', 600),
    liveProduct('headphones', 'Dell Bluetooth Headphones', 'Headphones', 400),
  ];
  const exactFit = optimize(products);
  assert.equal(exactFit.recommendedCombination.totalCost, 1000);
  assert.equal(exactFit.remainingBudget, 0);
  const strictLimit = optimize(products, { budget: 999.99 });
  assert.ok(strictLimit.totalCost <= 999.99);
  assert.ok(strictLimit.recommendedCombination.products.length < 2);
});

test('currency mismatches are excluded and never converted or combined', () => {
  const result = optimize([
    liveProduct('phone-eur', 'Dell Smartphone', 'Smartphones', 500, 'EUR'),
    liveProduct('headphones-usd', 'Dell Headphones', 'Headphones', 300, 'USD'),
  ]);
  assert.deepEqual(result.recommendedCombination.products.map(({ productId }) => productId), ['headphones-usd']);
  assert.equal(result.totalCost, 300);
  assert.equal(result.recommendedCombination.products.every(({ currency }) => currency === 'USD'), true);
  assert.match(result.missingCategories[0].reason, /EUR.*excluded.*no currency conversion source/);
});

test('missing catalogue categories are reported in the result and explanation', () => {
  const result = optimize([
    liveProduct('phone', 'Dell Smartphone', 'Smartphones', 400),
  ], { categories: ['Smartphones', 'Smartwatches'] });
  assert.deepEqual(result.missingCategories, [{
    category: 'Smartwatches',
    reason: 'No product was found in the available catalogue.',
  }]);
  assert.match(result.explanation, /Smartwatches: No product was found/);
});

test('duplicate products do not appear twice in a combination', () => {
  const laptop = liveProduct('laptop', 'Dell Laptop 16GB', 'Laptops', 500);
  const result = optimize([laptop, { ...laptop }], { categories: ['Laptops'] });
  assert.equal(result.candidateCount, 1);
  assert.equal(result.recommendedCombination.products.length, 1);
  assert.equal(result.totalCost, 500);
});

test('alternative combinations are distinct and remain within budget', () => {
  const result = optimize([
    liveProduct('phone-a', 'Dell Smartphone A', 'Smartphones', 300),
    liveProduct('phone-b', 'Dell Smartphone B', 'Smartphones', 350),
    liveProduct('headphones-a', 'Dell Bluetooth Headphones A', 'Headphones', 200),
    liveProduct('headphones-b', 'Dell Bluetooth Headphones B', 'Headphones', 250),
  ]);
  assert.equal(result.alternatives.length, 3);
  const signatures = [result.recommendedCombination, ...result.alternatives]
    .map((combination) => combination.products.map(({ productId }) => productId).sort().join('|'));
  assert.equal(new Set(signatures).size, signatures.length);
  assert.ok([result.recommendedCombination, ...result.alternatives].every((combination) => combination.totalCost <= 1000));
});

test('category coverage is maximized before score breaks ties', () => {
  const result = optimize([
    liveProduct('cheap-mismatch-phone', 'Other Smartphone', 'Smartphones', 100, 'USD', { brand: 'Other' }),
    liveProduct('preferred-headphones', 'Dell Bluetooth Headphones', 'Headphones', 900),
  ], {
    budget: 1000,
    preferredBrands: ['Dell'],
  });
  assert.equal(result.recommendedCombination.products.length, 2);
  assert.equal(result.recommendedCombination.metrics.categoryCoverage, 100);
});

test('empty catalogues return an empty recommendation and explain unavailable categories', () => {
  const result = optimize([], { categories: ['Smartphones', 'Laptops'] });
  assert.equal(result.recommendedCombination, null);
  assert.deepEqual(result.alternatives, []);
  assert.equal(result.totalCost, 0);
  assert.equal(result.remainingBudget, 1000);
  assert.equal(result.missingCategories.length, 2);
  assert.match(result.explanation, /No product combination/);
  assert.match(result.explanation, /Smartphones: No product was found/);
});

test('brand preferences and priority specifications influence deterministic ranking', () => {
  const result = optimize([
    liveProduct('dell-headphones', 'Dell Bluetooth Headphones', 'Headphones', 300, 'USD', {
      brand: 'Dell',
      specifications: { connectivity: 'Bluetooth' },
    }),
    liveProduct('sony-headphones', 'Sony Bluetooth Headphones', 'Headphones', 300, 'USD', {
      brand: 'Sony',
      specifications: {},
    }),
  ], {
    categories: ['Headphones'],
    preferredBrands: ['Sony'],
    priorities: 'Bluetooth',
  });
  assert.equal(result.recommendedCombination.products[0].productId, 'sony-headphones');
  assert.equal(result.recommendedCombination.metrics.brandPreference, 100);
});

test('LIVE and DEMO labels are preserved and demo prices remain clearly sample data', () => {
  const demo = demoProducts.find(({ productId }) => productId === 'demo-iphone-15');
  const live = liveProduct('live-headphones', 'Dell Bluetooth Headphones', 'Headphones', 200);
  const result = optimize([demo, live], {
    budget: 1000,
    categories: ['Smartphones', 'Headphones'],
  });
  assert.deepEqual(
    result.recommendedCombination.products.map(({ dataType }) => dataType).sort(),
    ['DEMO', 'LIVE'],
  );
  assert.match(result.explanation, /DEMO prices are sample catalogue values/);
  assert.equal(result.recommendedCombination.productPrices.find(({ dataType }) => dataType === 'DEMO').price, 699);
});
