import test from 'node:test';
import assert from 'node:assert/strict';
import { filterVerifiedOffers, isOfferRelevantToQuery, offerDetail, sellerDisplayName } from '../src/offerUtils.js';

const validOffer = (overrides = {}) => ({
  id: 'ebay:v1|123|0',
  name: 'Sony wireless headphones',
  price: 89.99,
  currency: 'USD',
  merchant: 'verified-seller',
  retailerUrl: 'https://www.ebay.com/itm/123',
  ...overrides,
});

test('verified offers are deduplicated by eBay item ID', () => {
  const first = validOffer();
  const duplicate = validOffer({ name: 'Duplicate title' });
  assert.deepEqual(filterVerifiedOffers([first, duplicate]), [first]);
});

test('identical normalized titles deduplicate across different eBay item IDs', () => {
  const first = validOffer();
  const duplicate = validOffer({ id: 'ebay:v1|124|0', name: '  SONY wireless headphones!!! ' });
  const differentConfiguration = validOffer({ id: 'ebay:v1|125|0', name: 'Sony wireless headphones 256GB' });
  assert.deepEqual(filterVerifiedOffers([first, duplicate, differentConfiguration]), [first, differentConfiguration]);
});

test('offer relevance enforces explicit brands but allows unbranded category matches', () => {
  const samsung = validOffer({
    name: 'Samsung Galaxy S24 smartphone',
    category: 'Cell Phones & Smartphones',
  });
  const iphone = validOffer({
    id: 'ebay:v1|iphone|0',
    name: 'Apple iPhone 15 smartphone',
    category: 'Cell Phones & Smartphones',
  });
  const sonyHeadphones = validOffer({
    id: 'ebay:v1|sony|0',
    name: 'Sony WH-1000XM5 headphones',
    category: 'Headphones',
  });
  const dellLaptop = validOffer({
    id: 'ebay:v1|dell|0',
    name: 'Dell XPS 15 laptop',
    category: 'Laptops & Netbooks',
  });
  assert.equal(isOfferRelevantToQuery(samsung, 'Samsung phone under $300'), true);
  assert.equal(isOfferRelevantToQuery(iphone, 'Samsung phone under $300'), false);
  assert.equal(isOfferRelevantToQuery(iphone, 'iPhone'), true);
  assert.equal(isOfferRelevantToQuery(samsung, 'iPhone'), false);
  assert.equal(isOfferRelevantToQuery(sonyHeadphones, 'Sony headphones'), true);
  assert.equal(isOfferRelevantToQuery(dellLaptop, 'Dell laptop'), true);
  assert.equal(isOfferRelevantToQuery(samsung, 'phone'), true);
  assert.equal(isOfferRelevantToQuery(iphone, 'phone'), true);
  assert.equal(isOfferRelevantToQuery({ ...samsung, name: 'Synergia contract test item' }, 'phone'), false);
});

test('incomplete or invalid offers are not passed to the results UI', () => {
  const invalidOffers = [
    validOffer({ name: '  ' }),
    validOffer({ price: 0 }),
    validOffer({ price: Number.NaN }),
    validOffer({ currency: '' }),
    validOffer({ merchant: '' }),
    validOffer({ retailerUrl: 'http://www.ebay.com/itm/123' }),
    validOffer({ retailerUrl: 'https://example.com/itm/123' }),
    validOffer({ retailerUrl: 'https://www.ebay.com/' }),
  ];
  assert.deepEqual(filterVerifiedOffers([validOffer(), ...invalidOffers]), [validOffer()]);
});

test('valid offers without seller details remain eligible for display and handoff', () => {
  const offer = validOffer({ merchant: undefined });
  assert.deepEqual(filterVerifiedOffers([offer]), [offer]);
  assert.equal(sellerDisplayName(offer.merchant), 'Seller details unavailable');
  assert.equal(sellerDisplayName('seller-from-provider'), 'seller-from-provider');
});

test('unknown and absent product details use a neutral fallback', () => {
  assert.equal(offerDetail('Unknown'), 'Details unavailable');
  assert.equal(offerDetail(null), 'Details unavailable');
  assert.equal(offerDetail('IN_STOCK'), 'IN_STOCK');
  assert.equal(sellerDisplayName(null), 'Seller details unavailable');
});
