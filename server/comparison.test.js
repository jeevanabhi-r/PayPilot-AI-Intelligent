import test from 'node:test';
import assert from 'node:assert/strict';
import { demoProducts } from './demoProducts.js';
import { buildProductComparison, createComparisonService } from './comparison.js';

function laptop(overrides = {}) {
  return {
    productId: 'live-laptop',
    id: 'ebay:live-laptop',
    title: 'Dell Latitude 7440',
    brand: 'Dell',
    category: 'Laptops',
    price: 999,
    currency: 'USD',
    specifications: { memory: '16GB', storage: '512GB SSD', display: '14-inch' },
    dataType: 'LIVE',
    source: 'eBay Browse API',
    listingUrl: 'https://www.ebay.com/itm/live-laptop',
    retailerUrl: 'https://www.ebay.com/itm/live-laptop',
    ...overrides,
  };
}

test('empty comparisons return empty products, spec rows, price differences, and winners', () => {
  const result = buildProductComparison([]);
  assert.deepEqual(result.products, []);
  assert.deepEqual(result.specifications, []);
  assert.deepEqual(result.priceDifferences, []);
  assert.deepEqual(result.winners, {
    bestOverall: null,
    bestBudget: null,
    bestSpecification: null,
    specificationBasis: 'availableSpecificationFields',
    noProductsWithinBudget: false,
    budgetNote: null,
  });
  assert.equal(result.explanation, '');
});

test('missing specification values are shown as Not available and never inferred', () => {
  const result = buildProductComparison([
    laptop({ productId: 'one', specifications: { memory: '16GB' } }),
    laptop({ productId: 'two', specifications: { storage: '512GB SSD' } }),
  ]);
  const memory = result.specifications.find(({ name }) => name === 'memory');
  const storage = result.specifications.find(({ name }) => name === 'storage');
  assert.deepEqual(memory.values.map(({ value, available }) => [value, available]), [
    ['16GB', true],
    ['Not available', false],
  ]);
  assert.deepEqual(storage.values.map(({ value, available }) => [value, available]), [
    ['Not available', false],
    ['512GB SSD', true],
  ]);
});

test('requested specification keys are shown when every selected product lacks them', () => {
  const result = buildProductComparison([
    laptop({ productId: 'one', specifications: { memory: '16GB' } }),
    laptop({ productId: 'two', specifications: { memory: '8GB' } }),
  ], 'laptop with 1TB storage');
  const storage = result.specifications.find(({ name }) => name === 'storage');
  assert.ok(storage);
  assert.deepEqual(storage.values.map(({ value, available }) => [value, available]), [
    ['Not available', false],
    ['Not available', false],
  ]);
});

test('price differences are computed only for matching currencies', () => {
  const result = buildProductComparison([
    laptop({ productId: 'usd-a', price: 800, currency: 'USD' }),
    laptop({ productId: 'usd-b', price: 950, currency: 'USD' }),
    laptop({ productId: 'eur', price: 700, currency: 'EUR' }),
  ]);
  assert.deepEqual(result.priceDifferences, [
    { leftProductId: 'usd-a', rightProductId: 'usd-b', difference: -150, currency: 'USD' },
    { leftProductId: 'usd-a', rightProductId: 'eur', difference: null, currency: null },
    { leftProductId: 'usd-b', rightProductId: 'eur', difference: null, currency: null },
  ]);
  assert.equal(result.winners.bestBudget, null);
  assert.match(result.winners.budgetNote, /different currencies/);
});

test('same-currency prices identify the lowest-price option', () => {
  const result = buildProductComparison([
    laptop({ productId: 'higher', price: 999 }),
    laptop({ productId: 'lower', price: 799 }),
  ]);
  assert.equal(result.winners.bestBudget, 'lower');
  assert.equal(result.priceDifferences[0].difference, 200);
  assert.equal(result.priceDifferences[0].currency, 'USD');
});

test('best overall, budget, and specification matches use deterministic product evidence', () => {
  const products = [
    laptop({ productId: 'best-overall', title: 'Dell Latitude 7440', price: 900, specifications: { memory: '16GB', storage: '512GB SSD' } }),
    laptop({ productId: 'best-budget', title: 'HP Laptop 15', brand: 'HP', price: 700, specifications: { memory: '8GB' } }),
    laptop({ productId: 'best-spec', title: 'Dell Precision Laptop', price: 1100, specifications: { memory: '32GB', storage: '1TB SSD' } }),
  ];
  const result = buildProductComparison(products, 'Dell laptop under $1000 with 16GB RAM');
  assert.equal(result.winners.bestOverall, 'best-overall');
  assert.equal(result.winners.bestBudget, 'best-budget');
  assert.equal(result.winners.bestSpecification, 'best-overall');
  assert.ok(result.products.every(({ recommendation }) => recommendation.score >= 0 && recommendation.score <= 100));
});

test('LIVE and DEMO source labels are preserved and demo listings stay absent', () => {
  const result = buildProductComparison([
    laptop({ productId: 'live-item' }),
    demoProducts.find(({ productId }) => productId === 'demo-dell-xps'),
  ]);
  const live = result.products.find(({ productId }) => productId === 'live-item');
  const demo = result.products.find(({ productId }) => productId === 'demo-dell-xps');
  assert.equal(live.dataType, 'LIVE');
  assert.equal(live.recommendation.sourceType, 'LIVE');
  assert.equal(live.listingUrl, 'https://www.ebay.com/itm/live-laptop');
  assert.equal(demo.dataType, 'DEMO');
  assert.equal(demo.recommendation.sourceType, 'DEMO');
  assert.equal(demo.listingUrl, null);
  assert.equal(demo.retailerUrl, null);
  assert.match(result.evidenceStatements.join(' '), /DEMO items are sample catalogue data/);
});

test('Groq failures return deterministic evidence-based summaries', async () => {
  const warnings = [];
  const compare = createComparisonService({
    env: { GROQ_API_KEY: 'test-key' },
    fetchImpl: async () => { throw new Error('simulated outage'); },
    logger: { warn: (message) => warnings.push(message) },
  });
  const result = await compare([
    laptop({ productId: 'one', price: 800 }),
    laptop({ productId: 'two', price: 900 }),
  ]);
  assert.equal(result.explanationSource, 'rules');
  assert.ok(result.explanation.includes('100 USD less'));
  assert.equal(warnings.length, 1);
});

test('Groq may select only complete evidence statements; invented comparisons are discarded', async () => {
  let allowedStatements;
  const compare = createComparisonService({
    env: { GROQ_API_KEY: 'test-key' },
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      allowedStatements = JSON.parse(request.messages[1].content).evidenceStatements;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({
            statements: [allowedStatements[0], 'The first product is more reliable and faster.'],
          }) } }],
        }),
      };
    },
    logger: { warn() {} },
  });
  const result = await compare([
    laptop({ productId: 'one', price: 800 }),
    laptop({ productId: 'two', price: 900 }),
  ]);
  assert.equal(result.explanationSource, 'groq');
  assert.equal(result.explanation, allowedStatements[0]);
  assert.ok(!result.explanation.includes('reliable'));
});
