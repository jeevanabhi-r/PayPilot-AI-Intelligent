import test from 'node:test';
import assert from 'node:assert/strict';
import { demoProducts } from './demoProducts.js';
import { createRecommendationService } from './recommendationService.js';
import {
  extractShoppingRequirements,
  scoreProducts,
  validateGeneratedExplanation,
  validateShoppingRequirements,
} from './recommendations.js';
import { filterVerifiedOffers, isOfferRelevantToQuery } from '../src/offerUtils.js';

function product(overrides = {}) {
  return {
    productId: 'live-laptop-1',
    id: 'live-laptop-1',
    title: 'Dell XPS 13',
    brand: 'Dell',
    category: 'Laptops',
    price: 999,
    currency: 'USD',
    specifications: { memory: '16GB', storage: '512GB SSD' },
    dataType: 'LIVE',
    source: 'eBay Browse API',
    listingUrl: 'https://www.ebay.com/itm/live-laptop-1',
    retailerUrl: 'https://www.ebay.com/itm/live-laptop-1',
    ...overrides,
  };
}

test('shopping requirement extraction identifies category, budget, brand, use, specs, and features', () => {
  assert.deepEqual(extractShoppingRequirements('Find a Dell laptop under $1,200 for coding with 16GB RAM and Bluetooth, ideally OLED'), {
    category: 'Laptops',
    budget: 1200,
    currency: 'USD',
    preferredBrand: 'Dell',
    intendedUse: ['coding'],
    requiredSpecifications: { memory: '16GB' },
    mustHaveFeatures: ['Bluetooth'],
    optionalFeatures: ['OLED'],
  });
});

test('Groq requirement extraction is restricted to requirements grounded in the request', () => {
  const result = validateShoppingRequirements({
    category: 'Smartphones',
    budget: 900,
    currency: 'USD',
    preferredBrand: 'Apple',
    intendedUse: ['gaming'],
    requiredSpecifications: { memory: '16GB', storage: '1TB' },
    mustHaveFeatures: ['OLED', 'Bluetooth'],
    optionalFeatures: ['wireless'],
  }, 'Samsung laptop under $1000 with 16GB RAM and Bluetooth');
  assert.equal(result.category, 'Laptops');
  assert.equal(result.budget, 1000);
  assert.equal(result.currency, 'USD');
  assert.equal(result.preferredBrand, 'Samsung');
  assert.deepEqual(result.intendedUse, []);
  assert.deepEqual(result.requiredSpecifications, { memory: '16GB' });
  assert.deepEqual(result.mustHaveFeatures, ['Bluetooth']);
  assert.deepEqual(result.optionalFeatures, []);
});

test('scoring is normalized to 0-100 and ranks products by stated requirements', () => {
  const requirements = extractShoppingRequirements('Dell laptop under $1,100 with 16GB RAM');
  const results = scoreProducts([
    product({ productId: 'over-budget', price: 1200 }),
    product({ productId: 'wrong-brand', brand: 'HP', price: 900 }),
    product({ productId: 'best-match', price: 999 }),
  ], requirements);
  assert.equal(results.recommendations.length, 1);
  assert.equal(results.recommendations[0].productId, 'best-match');
  assert.ok(results.recommendations.every(({ recommendation }) => recommendation.score >= 0 && recommendation.score <= 100));
  assert.equal(results.recommendations[0].recommendation.score, 100);
});

test('scoring includes both 0 and 100 boundary scores and returns at most three matches', () => {
  const requirements = extractShoppingRequirements('Samsung headphones under 500 EUR for gaming with 32GB RAM and noise cancellation ideally Bluetooth');
  const result = scoreProducts([
    product({
      productId: 'complete-match-1', title: 'Samsung Bluetooth Noise Cancellation Gaming Headphones',
      brand: 'Samsung', category: 'Headphones', price: 400, currency: 'EUR',
      specifications: { memory: '32GB' },
    }),
    product({
      productId: 'complete-match-2', title: 'Samsung Bluetooth Noise Cancellation Gaming Headphones 2',
      brand: 'Samsung', category: 'Headphones', price: 410, currency: 'EUR',
      specifications: { memory: '32GB' },
    }),
    product({
      productId: 'complete-match-3', title: 'Samsung Bluetooth Noise Cancellation Gaming Headphones 3',
      brand: 'Samsung', category: 'Headphones', price: 420, currency: 'EUR',
      specifications: { memory: '32GB' },
    }),
    product({
      productId: 'complete-match-4', title: 'Samsung Bluetooth Noise Cancellation Gaming Headphones 4',
      brand: 'Samsung', category: 'Headphones', price: 430, currency: 'EUR',
      specifications: { memory: '32GB' },
    }),
    product({ productId: 'zero-match', price: 700, currency: 'USD', brand: 'Dell', category: 'Laptops', specifications: {} }),
  ], requirements);
  assert.equal(result.recommendations.length, 3);
  assert.equal(result.alternatives.length, 0);
  const zeroScore = scoreProducts([
    product({ price: 700, currency: 'USD', brand: 'Dell', category: 'Laptops', specifications: {} }),
  ], requirements).alternatives[0].recommendation.score;
  assert.equal(zeroScore, 0);
  assert.ok(result.recommendations.every(({ recommendation }) => recommendation.score >= 0 && recommendation.score <= 100));
});

test('products beyond the budget cannot be fully suitable', () => {
  const requirements = extractShoppingRequirements('laptop under $900');
  const result = scoreProducts([product({ price: 999 })], requirements);
  assert.equal(result.allRequirementsSatisfied, false);
  assert.equal(result.recommendations.length, 0);
  assert.ok(result.alternatives[0].recommendation.score < 100);
  assert.match(result.alternatives[0].recommendation.concerns[0], /exceeds the budget/);
});

test('budget scoring enforces the limit and requires matching currency without conversion', () => {
  const requirements = extractShoppingRequirements('laptop budget 1000 USD');
  const result = scoreProducts([
    product({ productId: 'at-budget', price: 1000, currency: 'USD' }),
  ], requirements);
  assert.deepEqual(result.recommendations.map(({ productId }) => productId), ['at-budget']);
  for (const invalidProduct of [
    product({ productId: 'over-budget', price: 1000.01, currency: 'USD' }),
    product({ productId: 'wrong-currency', price: 900, currency: 'EUR' }),
  ]) {
    const invalid = scoreProducts([invalidProduct], requirements);
    assert.equal(invalid.recommendations.length, 0);
    assert.equal(invalid.alternatives[0].productId, invalidProduct.productId);
  }
  const wrongCurrency = scoreProducts([
    product({ productId: 'wrong-currency', price: 900, currency: 'EUR' }),
  ], requirements).alternatives[0];
  assert.match(wrongCurrency.recommendation.concerns.join(' '), /requested budget currency is USD/);
});

test('brand scoring distinguishes exact matches, mismatches, and unknown brands', () => {
  const requirements = extractShoppingRequirements('Dell laptop');
  const result = scoreProducts([
    product({ productId: 'same-brand' }),
    product({ productId: 'other-brand', brand: 'HP' }),
    product({ productId: 'unknown-brand', brand: null }),
  ], requirements);
  assert.equal(result.recommendations[0].productId, 'same-brand');
  assert.equal(result.alternatives.length, 0);
  const unknown = scoreProducts([product({ brand: null })], requirements).alternatives[0];
  assert.match(unknown.recommendation.concerns[0], /Brand is not provided/);
});

test('missing specification data is not inferred and is explained as an unsatisfied requirement', () => {
  const requirements = extractShoppingRequirements('laptop with 32GB RAM');
  const result = scoreProducts([product({ specifications: {} })], requirements);
  assert.equal(result.allRequirementsSatisfied, false);
  assert.deepEqual(result.alternatives[0].recommendation.missingSpecifications, ['memory: 32GB']);
  assert.match(result.alternatives[0].recommendation.concerns.join(' '), /not confirmed/);
});

test('empty products yield empty recommendation and alternative lists', () => {
  const result = scoreProducts([], extractShoppingRequirements('laptop under $1000'));
  assert.deepEqual(result.recommendations, []);
  assert.deepEqual(result.alternatives, []);
  assert.equal(result.candidateCount, 0);
  assert.equal(result.allRequirementsSatisfied, false);
});

test('recommendations preserve LIVE and DEMO source labels and listing behavior', () => {
  const requirements = extractShoppingRequirements('headphones');
  const results = scoreProducts([
    product({
      productId: 'live-headphones',
      id: 'live-headphones',
      title: 'Sony WH-1000XM5 Wireless Headphones',
      brand: 'Sony',
      category: 'Headphones',
      price: 299,
      specifications: { type: 'Over-ear', connectivity: 'Bluetooth' },
    }),
    ...demoProducts.filter((item) => item.category === 'Headphones'),
  ], requirements);
  assert.deepEqual(
    results.recommendations.map(({ dataType, recommendation }) => [dataType, recommendation.sourceType]).sort(),
    [['DEMO', 'DEMO'], ['DEMO', 'DEMO'], ['LIVE', 'LIVE']].sort(),
  );
  const live = results.recommendations.find((item) => item.dataType === 'LIVE');
  const demos = results.recommendations.filter((item) => item.dataType === 'DEMO');
  assert.equal(live.listingUrl, 'https://www.ebay.com/itm/live-laptop-1');
  assert.ok(demos.every((item) => item.listingUrl === null && item.retailerUrl === null));
});

test('AI Agent and Discover rank and hand off the same recommendation records', async () => {
  const live = product({
    productId: 'ebay:agent-discover-1',
    id: 'ebay:agent-discover-1',
    title: 'Dell Latitude 7440',
    name: 'Dell Latitude 7440',
    listingUrl: 'https://www.ebay.com/itm/agent-discover-1',
    retailerUrl: 'https://www.ebay.com/itm/agent-discover-1',
  });
  const products = [live, ...demoProducts.filter((item) => item.category === 'Laptops')];
  const recommend = createRecommendationService({ env: {}, logger: { warn() {} } });
  const agentResults = await recommend('Find a Dell laptop under 1000 USD', products);
  const discoverResults = await recommend('Dell laptop under 1000 USD', products);
  const agentOffers = agentResults.allRequirementsSatisfied
    ? agentResults.recommendations
    : agentResults.alternatives;
  const discoverOffers = discoverResults.allRequirementsSatisfied
    ? discoverResults.recommendations
    : discoverResults.alternatives;
  assert.deepEqual(
    agentOffers.map(({ productId, recommendation }) => [productId, recommendation.score, recommendation.explanation]),
    discoverOffers.map(({ productId, recommendation }) => [productId, recommendation.score, recommendation.explanation]),
  );
  const handedOff = filterVerifiedOffers(agentOffers)
    .filter((offer) => isOfferRelevantToQuery(offer, 'Dell laptop under 1000 USD'));
  assert.deepEqual(
    handedOff.map(({ productId, recommendation }) => [productId, recommendation.score, recommendation.explanation]),
    agentOffers.map(({ productId, recommendation }) => [productId, recommendation.score, recommendation.explanation]),
  );
});

test('Groq failure keeps deterministic scoring and explanations available', async () => {
  const warnings = [];
  const recommend = createRecommendationService({
    env: { GROQ_API_KEY: 'test-key' },
    fetchImpl: async () => { throw new Error('simulated Groq outage'); },
    logger: { warn: (message) => warnings.push(message) },
  });
  const result = await recommend('Dell laptop under $1,100 with 16GB RAM', [product()]);
  assert.equal(result.requirementsSource, 'rules');
  assert.equal(result.explanationSource, 'rules');
  assert.equal(result.recommendations[0].recommendation.score, 100);
  assert.ok(result.recommendations[0].recommendation.explanation.length > 0);
  assert.equal(warnings.length, 2);
});

test('generated explanations with unsupported product claims are rejected', () => {
  const candidate = product();
  const recommendation = scoreProducts([candidate], extractShoppingRequirements('Dell laptop under $1100 with 16GB RAM')).recommendations[0].recommendation;
  assert.equal(
    validateGeneratedExplanation(recommendation.explanation, candidate, recommendation),
    recommendation.explanation,
  );
  assert.equal(
    validateGeneratedExplanation('Dell XPS 13 has an industry-leading battery and guaranteed performance.', candidate, recommendation),
    null,
  );
  assert.equal(
    validateGeneratedExplanation('Dell XPS 13 is for 16GB.', candidate, recommendation),
    null,
  );
});
