import test from 'node:test';
import assert from 'node:assert/strict';
import { createEbayProductSearch } from './products.js';

const credentials = {
  EBAY_CLIENT_ID: 'sandbox-client-id',
  EBAY_CLIENT_SECRET: 'sandbox-client-secret',
  EBAY_ENV: 'sandbox',
  EBAY_MARKETPLACE_ID: 'EBAY_US',
};

function response(status, payload, timeline = []) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => name === 'content-type' ? 'application/json' : null },
    text: async () => { timeline.push('body-read'); return JSON.stringify(payload); },
    json: async () => payload,
  };
}

function captureLogger(timeline = []) {
  const entries = [];
  return {
    entries,
    info: (message, details) => { entries.push({ level: 'info', message, details }); timeline.push(message); },
    warn: (message, details) => { entries.push({ level: 'warn', message, details }); timeline.push(message); },
  };
}

function tokenPayload(accessToken = 'sandbox-access-token') {
  return { access_token: accessToken, expires_in: 3600, token_type: 'Application Access Token' };
}

test('OAuth failures report status and sanitized provider errors', async () => {
  const logger = captureLogger();
  const calls = [];
  const search = createEbayProductSearch({
    env: credentials,
    logger,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return response(401, { errors: [{ errorId: 1001, message: `Invalid credentials ${credentials.EBAY_CLIENT_SECRET}` }] });
    },
  });

  await assert.rejects(search('wireless headphones'), /eBay token request failed \(401\)/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.sandbox.ebay.com/identity/v1/oauth2/token');
  assert.equal(calls[0].options.headers.Authorization, `Basic ${Buffer.from(`${credentials.EBAY_CLIENT_ID}:${credentials.EBAY_CLIENT_SECRET}`).toString('base64')}`);
  assert.match(calls[0].options.body, /grant_type=client_credentials/);
  assert.match(calls[0].options.body, /scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope/);
  assert.equal(logger.entries.find((entry) => entry.message === '[eBay Browse] OAuth error').details.status, 401);
  assert.equal(JSON.stringify(logger.entries).includes(credentials.EBAY_CLIENT_SECRET), false);
  assert.equal(JSON.stringify(logger.entries).includes('Authorization'), false);
});

test('Browse API errors report status without logging credentials or access token', async () => {
  const timeline = [];
  const logger = captureLogger(timeline);
  const calls = [];
  const search = createEbayProductSearch({
    env: credentials,
    logger,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return calls.length === 1
        ? response(200, tokenPayload())
        : response(403, { errors: [{ errorId: 2001, domain: 'BUY', category: 'REQUEST', message: 'Access denied' }] }, timeline);
    },
  });

  await assert.rejects(search('wireless headphones under $100'), /eBay search failed \(403\)/);
  const browseCall = calls[1];
  assert.equal(new URL(browseCall.url).origin, 'https://api.sandbox.ebay.com');
  assert.equal(new URL(browseCall.url).pathname, '/buy/browse/v1/item_summary/search');
  assert.equal(new URL(browseCall.url).searchParams.get('q'), 'wireless headphones under $100');
  assert.equal(new URL(browseCall.url).searchParams.get('limit'), '12');
  assert.equal(browseCall.options.headers.Authorization, 'Bearer sandbox-access-token');
  assert.equal(browseCall.options.headers['X-EBAY-C-MARKETPLACE-ID'], 'EBAY_US');
  const searchError = logger.entries.find((entry) => entry.message === '[eBay Browse] API error').details;
  assert.equal(searchError.status, 403);
  assert.deepEqual({ errorId: searchError.errorId, domain: searchError.domain, category: searchError.category, message: searchError.message }, {
    errorId: 2001,
    domain: 'BUY',
    category: 'REQUEST',
    message: 'Access denied',
  });
  const responseLog = logger.entries.find((entry) => entry.message === '[eBay Browse] Search response metadata');
  assert.deepEqual(responseLog.details, { status: 403, contentType: 'application/json' });
  const bodyLog = logger.entries.find((entry) => entry.message === '[eBay Browse] Search response body metadata');
  assert.deepEqual(bodyLog.details.topLevelProperties, ['errors']);
  assert.ok(timeline.indexOf('[eBay Browse] Search response metadata') < timeline.indexOf('body-read'));
  assert.ok(timeline.indexOf('body-read') < timeline.indexOf('[eBay Browse] Search response body metadata'));
  assert.equal(JSON.stringify(logger.entries).includes('sandbox-access-token'), false);
  assert.equal(JSON.stringify(logger.entries).includes(credentials.EBAY_CLIENT_SECRET), false);
});

test('2xx Browse API error diagnostics redact credentials and authorization-shaped values', async () => {
  const logger = captureLogger();
  let callCount = 0;
  const search = createEbayProductSearch({
    env: credentials,
    logger,
    fetchImpl: async () => {
      callCount += 1;
      return callCount === 1
        ? response(200, tokenPayload())
        : response(200, { errors: [{
          errorId: 99,
          domain: 'BUY',
          category: 'REQUEST',
          message: `Bearer sandbox-access-token ${credentials.EBAY_CLIENT_ID} ${credentials.EBAY_CLIENT_SECRET}`,
        }] });
    },
  });

  await assert.rejects(search('wireless headphones'), /eBay search returned provider errors \(200\)/);
  const logs = JSON.stringify(logger.entries);
  assert.equal(logs.includes('sandbox-access-token'), false);
  assert.equal(logs.includes(credentials.EBAY_CLIENT_ID), false);
  assert.equal(logs.includes(credentials.EBAY_CLIENT_SECRET), false);
});

test('empty Browse API result returns no offers and logs response shape', async () => {
  const timeline = [];
  const logger = captureLogger(timeline);
  let callCount = 0;
  const search = createEbayProductSearch({
    env: credentials,
    logger,
    fetchImpl: async () => {
      callCount += 1;
      return callCount === 1 ? response(200, tokenPayload()) : response(200, {
        href: 'https://api.sandbox.ebay.com/buy/browse/v1/item_summary/search?q=wireless+headphones',
        total: 0,
        limit: 12,
        offset: 0,
        itemSummaries: [],
      }, timeline);
    },
  });

  const result = await search('wireless headphones');
  assert.equal(result.provider, 'ebay-browse');
  assert.deepEqual(result.products, []);
  const responseLog = logger.entries.find((entry) => entry.message === '[eBay Browse] Search response metadata');
  assert.deepEqual(responseLog.details, { status: 200, contentType: 'application/json' });
  const requestLog = logger.entries.find((entry) => entry.message === '[eBay Browse] Search request');
  assert.deepEqual(requestLog.details, { query: 'wireless headphones', marketplaceId: 'EBAY_US' });
  const bodyLog = logger.entries.find((entry) => entry.message === '[eBay Browse] Search response body metadata');
  assert.deepEqual(bodyLog.details.topLevelProperties, ['href', 'total', 'limit', 'offset', 'itemSummaries']);
  assert.equal(bodyLog.details.itemSummariesExists, true);
  assert.equal(bodyLog.details.itemSummariesCount, 0);
  assert.deepEqual(
    { total: bodyLog.details.total, limit: bodyLog.details.limit, offset: bodyLog.details.offset },
    { total: 0, limit: 12, offset: 0 },
  );
  assert.ok(timeline.indexOf('[eBay Browse] Search response metadata') < timeline.indexOf('body-read'));
  assert.ok(timeline.indexOf('body-read') < timeline.indexOf('[eBay Browse] Search response body metadata'));
  assert.deepEqual(logger.entries.find((entry) => entry.message === '[eBay Browse] Search results parsed').details, {
    summaryCount: 0,
    validOfferCount: 0,
    rejectedSummaryCount: 0,
    missingItemIdCount: 0,
    missingTitleCount: 0,
    invalidPriceCount: 0,
    missingCurrencyCount: 0,
    invalidCurrencyCount: 0,
    missingSellerCount: 0,
    invalidListingUrlCount: 0,
    titleRelevanceFailureCount: 0,
    duplicateOfferCount: 0,
    duplicateTitleCount: 0,
    summariesFieldPresent: true,
    missingListingUrlCount: 0,
  });
});

test('valid Browse API summaries normalize only provider-returned offers', async () => {
  const logger = captureLogger();
  let callCount = 0;
  const search = createEbayProductSearch({
    env: credentials,
    logger,
    fetchImpl: async () => {
      callCount += 1;
      return callCount === 1
        ? response(200, tokenPayload())
        : response(200, { total: 2, limit: 12, offset: 0, itemSummaries: [
          {
            itemId: 'v1|123|0',
            title: 'Wireless headphones listing',
            price: { value: '89.99', currency: 'USD' },
            image: { imageUrl: 'https://i.ebayimg.com/image.jpg' },
            condition: 'New',
            seller: { username: 'verified-seller' },
            itemWebUrl: 'https://www.ebay.com/itm/123',
            availabilityStatus: 'IN_STOCK',
          },
          { itemId: 'missing-fields', title: 'Incomplete listing' },
        ] });
    },
  });

  const result = await search('wireless headphones', 50);
  assert.deepEqual(result.products, [{
    id: 'ebay:v1|123|0',
    external: true,
    name: 'Wireless headphones listing',
    price: 89.99,
    currency: 'USD',
    image: 'https://i.ebayimg.com/image.jpg',
    condition: 'New',
    merchant: 'verified-seller',
    retailerUrl: 'https://www.ebay.com/itm/123',
    category: 'External offer',
    source: 'eBay Browse API',
    availability: 'IN_STOCK',
  }]);
  const bodyLog = logger.entries.find((entry) => entry.message === '[eBay Browse] Search response body metadata');
  assert.deepEqual(
    { total: bodyLog.details.total, limit: bodyLog.details.limit, offset: bodyLog.details.offset },
    { total: 2, limit: 12, offset: 0 },
  );
  const requestLog = logger.entries.find((entry) => entry.message === '[eBay Browse] Search request');
  assert.deepEqual(requestLog.details, { query: 'wireless headphones', marketplaceId: 'EBAY_US' });
  const logs = JSON.stringify(logger.entries);
  assert.equal(logs.includes(credentials.EBAY_CLIENT_ID), false);
  assert.equal(logs.includes(credentials.EBAY_CLIENT_SECRET), false);
  assert.equal(logs.includes('sandbox-access-token'), false);
  assert.deepEqual(logger.entries.find((entry) => entry.message === '[eBay Browse] Search results parsed').details, {
    summaryCount: 2,
    validOfferCount: 1,
    rejectedSummaryCount: 1,
    missingItemIdCount: 0,
    missingTitleCount: 0,
    invalidPriceCount: 1,
    missingCurrencyCount: 1,
    invalidCurrencyCount: 0,
    missingSellerCount: 1,
    invalidListingUrlCount: 1,
    titleRelevanceFailureCount: 1,
    duplicateOfferCount: 0,
    duplicateTitleCount: 0,
    summariesFieldPresent: true,
    missingListingUrlCount: 1,
  });
});

test('Browse results require complete offer fields, match the query, and deduplicate by item ID', async () => {
  const logger = captureLogger();
  let callCount = 0;
  const listing = {
    itemId: 'v1|phone-1|0',
    title: 'Samsung Galaxy S24 5G',
    price: { value: '129.99', currency: 'USD' },
    seller: { username: 'verified-seller' },
    itemWebUrl: 'https://www.ebay.com/itm/phone-1',
    categories: [{ categoryId: '9355', categoryName: 'Cell Phones & Smartphones' }],
  };
  const search = createEbayProductSearch({
    env: credentials,
    logger,
    fetchImpl: async () => {
      callCount += 1;
      return callCount === 1
        ? response(200, tokenPayload())
        : response(200, { itemSummaries: [
          listing,
          { ...listing, title: 'Duplicate Apple iPhone 7 listing' },
          { ...listing, itemId: 'missing-price', price: undefined },
          { ...listing, itemId: 'missing-currency', price: { value: '129.99' } },
          { ...listing, itemId: 'invalid-url', itemWebUrl: 'http://www.ebay.com/itm/phone-1' },
          { ...listing, itemId: 'irrelevant', title: 'Wireless headphones', categories: [{ categoryName: 'Headphones' }] },
        ] });
    },
  });

  const result = await search('phone');
  assert.equal(result.products.length, 1);
  assert.equal(result.products[0].id, 'ebay:v1|phone-1|0');
  assert.equal(result.products[0].retailerUrl, listing.itemWebUrl);
  assert.equal(result.products[0].merchant, 'verified-seller');
  assert.equal(result.products[0].availability, 'Details unavailable');
  assert.deepEqual(
    (({ validOfferCount, rejectedSummaryCount, duplicateOfferCount, titleRelevanceFailureCount, missingSellerCount, invalidListingUrlCount }) => ({
      validOfferCount, rejectedSummaryCount, duplicateOfferCount, titleRelevanceFailureCount, missingSellerCount, invalidListingUrlCount,
    }))(logger.entries.find((entry) => entry.message === '[eBay Browse] Search results parsed').details),
    { validOfferCount: 1, rejectedSummaryCount: 5, duplicateOfferCount: 1, titleRelevanceFailureCount: 1, missingSellerCount: 0, invalidListingUrlCount: 1 },
  );
});

test('Browse results deduplicate identical titles while preserving distinct models', async () => {
  const logger = captureLogger();
  let callCount = 0;
  const base = {
    title: 'Samsung Galaxy S24 128GB Smartphone',
    price: { value: '599.99', currency: 'USD' },
    itemWebUrl: 'https://www.ebay.com/itm/model-1',
    categories: [{ categoryName: 'Cell Phones & Smartphones' }],
  };
  const search = createEbayProductSearch({
    env: credentials,
    logger,
    fetchImpl: async () => {
      callCount += 1;
      return callCount === 1
        ? response(200, tokenPayload())
        : response(200, { itemSummaries: [
          { ...base, itemId: 'v1|same-title-1|0' },
          { ...base, itemId: 'v1|same-title-2|0', title: '  Samsung Galaxy S24 128GB Smartphone!! ' },
          { ...base, itemId: 'v1|different-model|0', title: 'Samsung Galaxy S24 Ultra 256GB Smartphone' },
        ] });
    },
  });

  const result = await search('Samsung phone');
  assert.deepEqual(result.products.map(({ id }) => id), [
    'ebay:v1|same-title-1|0',
    'ebay:v1|different-model|0',
  ]);
  const details = logger.entries.find((entry) => entry.message === '[eBay Browse] Search results parsed').details;
  assert.equal(details.duplicateTitleCount, 1);
  assert.equal(details.duplicateOfferCount, 0);
});

test('explicit brand relevance cannot be satisfied by a generic category', async () => {
  const logger = captureLogger();
  let callCount = 0;
  const base = {
    price: { value: '199.99', currency: 'USD' },
    itemWebUrl: 'https://www.ebay.com/itm/item',
    categories: [{ categoryName: 'Cell Phones & Smartphones' }],
  };
  const items = [
    { ...base, itemId: 'v1|samsung|0', title: 'Samsung Galaxy A15 smartphone' },
    { ...base, itemId: 'v1|iphone|0', title: 'Apple iPhone 15 smartphone' },
    { ...base, itemId: 'v1|pixel|0', title: 'Google Pixel 8 smartphone' },
    { ...base, itemId: 'v1|synergia|0', title: 'Synergia contract test item' },
  ];
  const createSearch = () => createEbayProductSearch({
    env: credentials,
    logger,
    fetchImpl: async () => {
      callCount += 1;
      return callCount % 2 === 1
        ? response(200, tokenPayload())
        : response(200, { itemSummaries: items });
    },
  });

  assert.deepEqual((await createSearch()('Samsung phone')).products.map(({ name }) => name), ['Samsung Galaxy A15 smartphone']);
  assert.deepEqual((await createSearch()('iPhone')).products.map(({ name }) => name), ['Apple iPhone 15 smartphone']);
  assert.deepEqual((await createSearch()('phone')).products.map(({ name }) => name), items.slice(0, 3).map(({ title }) => title));
});

test('seller username is extracted when available but missing seller data does not reject valid listings', async () => {
  const logger = captureLogger();
  let callCount = 0;
  const listing = {
    itemId: 'v1|phone-2|0',
    title: 'Samsung Galaxy S24 smartphone',
    price: { value: '599.99', currency: 'USD' },
    itemWebUrl: 'https://www.ebay.com/itm/phone-2',
    categories: [{ categoryName: 'Cell Phones & Smartphones' }],
  };
  const search = createEbayProductSearch({
    env: credentials,
    logger,
    fetchImpl: async () => {
      callCount += 1;
      return callCount === 1
        ? response(200, tokenPayload())
        : response(200, { itemSummaries: [
          { ...listing, seller: { username: 'seller-from-provider', feedbackScore: 100 } },
          { ...listing, itemId: 'v1|phone-3|0', title: 'Samsung Galaxy S24 Plus smartphone', seller: {} },
          { ...listing, itemId: 'v1|phone-4|0', title: 'Samsung Galaxy S24 Ultra smartphone' },
        ] });
    },
  });

  const result = await search('phone');
  assert.equal(result.products.length, 3);
  assert.equal(result.products[0].merchant, 'seller-from-provider');
  assert.equal(result.products[1].merchant, 'Seller details unavailable');
  assert.equal(result.products[2].merchant, 'Seller details unavailable');
  const details = logger.entries.find((entry) => entry.message === '[eBay Browse] Search results parsed').details;
  assert.equal(details.validOfferCount, 3);
  assert.equal(details.rejectedSummaryCount, 0);
  assert.equal(details.missingSellerCount, 2);
  const logs = JSON.stringify(logger.entries);
  assert.equal(logs.includes('seller-from-provider'), false);
  assert.equal(logs.includes('100'), false);
});

test('2xx Browse API error payload is logged and treated as provider failure', async () => {
  const logger = captureLogger();
  let callCount = 0;
  const search = createEbayProductSearch({
    env: credentials,
    logger,
    fetchImpl: async () => {
      callCount += 1;
      return callCount === 1 ? response(200, tokenPayload()) : response(200, { total: 0, errors: [{ errorId: 9, domain: 'BUY', category: 'REQUEST', message: 'Provider response' }] });
    },
  });

  await assert.rejects(search('wireless headphones'), /eBay search returned provider errors \(200\)/);
  const bodyLog = logger.entries.find((entry) => entry.message === '[eBay Browse] Search response body metadata');
  assert.deepEqual(bodyLog.details.topLevelProperties, ['total', 'errors']);
  assert.equal(bodyLog.details.itemSummariesExists, false);
  assert.equal(bodyLog.details.itemSummariesCount, 0);
  const errorLog = logger.entries.find((entry) => entry.message === '[eBay Browse] API error');
  assert.equal(errorLog.details.errorId, 9);
  assert.equal(errorLog.details.message, 'Provider response');
});

test('successful Browse API response without itemSummaries is treated as malformed', async () => {
  let callCount = 0;
  const search = createEbayProductSearch({
    env: credentials,
    fetchImpl: async () => {
      callCount += 1;
      return callCount === 1 ? response(200, tokenPayload()) : response(200, { total: 0 });
    },
  });

  await assert.rejects(search('wireless headphones'), /did not contain item summaries/);
});
