function isEbayListingUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && /^\/itm\/[^/]+(?:\/|$)/i.test(url.pathname)
      && /(?:^|\.)ebay\.[a-z]{2,}(?:\.[a-z]{2,})?$/i.test(url.hostname);
  } catch {
    return false;
  }
}

function queryTerms(query) {
  const ignoredTerms = new Set([
    'a', 'an', 'and', 'buy', 'cheap', 'cheaper', 'cheapest', 'find', 'for', 'in',
    'alternative', 'alternatives', 'better', 'budget', 'cost', 'looking', 'me', 'need',
    'of', 'offer', 'offers', 'or', 'please', 'price', 'product', 'recommend', 'search',
    'shop', 'show', 'some', 'the', 'to', 'under', 'want', 'with',
    'aud', 'cad', 'eur', 'gbp', 'jpy', 'usd',
  ]);
  return String(query).toLowerCase().match(/[a-z0-9]+/g)
    ?.filter((term) => !ignoredTerms.has(term) && !/^\d+$/.test(term)) || [];
}

function isNonProductTestListing(title) {
  return /\b(?:contract\s+test|test\s+(?:item|listing|product)|sandbox\s+(?:test|listing)|api\s+test)\b/i.test(title);
}

export function isOfferRelevantToQuery(offer, query) {
  if (!offer || typeof offer.name !== 'string') return false;
  if (isNonProductTestListing(offer.name)) return false;
  const terms = queryTerms(query);
  if (!terms.length) return true;
  const titleTerms = offer.name.toLowerCase().match(/[a-z0-9]+/g) || [];
  const categoryTerms = typeof offer.category === 'string'
    ? offer.category.toLowerCase().match(/[a-z0-9]+/g) || []
    : [];
  const brands = {
    apple: ['apple', 'iphone'],
    samsung: ['samsung'],
    sony: ['sony'],
    dell: ['dell'],
    google: ['google', 'pixel'],
    microsoft: ['microsoft', 'surface'],
    lenovo: ['lenovo'],
    hp: ['hp'],
  };
  const explicitlyRequestedBrands = terms.filter((term) => Object.hasOwn(brands, term));
  if (terms.includes('iphone') && !titleTerms.includes('iphone')) return false;
  if (explicitlyRequestedBrands.some((brand) => !brands[brand].some((alias) => titleTerms.includes(alias)))) return false;

  const aliases = { phone: ['iphone', 'smartphone', 'smartphones'] };
  return terms.every((term) => {
    if (explicitlyRequestedBrands.includes(term) || term === 'iphone') return true;
    return [...titleTerms, ...categoryTerms].some((candidate) => candidate === term
      || candidate === term.replace(/s$/, '')
      || candidate.replace(/s$/, '') === term
      || aliases[term]?.includes(candidate));
  });
}

export function filterVerifiedOffers(offers) {
  if (!Array.isArray(offers)) return [];
  const seenItemIds = new Set();
  const seenTitles = new Set();
  return offers.filter((offer) => {
    if (!offer || typeof offer !== 'object') return false;
    const dataType = offer.dataType || (typeof offer.id === 'string' && offer.id.startsWith('ebay:') ? 'LIVE' : '');
    const itemId = typeof offer.id === 'string' && offer.id.startsWith('ebay:')
      ? offer.id.slice('ebay:'.length)
      : '';
    const valid = typeof offer.name === 'string' && offer.name.trim()
      && typeof offer.price === 'number' && Number.isFinite(offer.price) && offer.price > 0
      && typeof offer.currency === 'string' && /^[A-Z]{3}$/.test(offer.currency)
      && (dataType === 'LIVE'
        ? Boolean(itemId && isEbayListingUrl(offer.listingUrl || offer.retailerUrl))
        : dataType === 'DEMO'
          && typeof offer.productId === 'string'
          && offer.source === 'PayPilot Curated Demo Catalogue'
          && !offer.listingUrl
          && !offer.retailerUrl);
    const normalizedTitle = typeof offer.name === 'string'
      ? offer.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
      : '';
    if (!valid || (itemId && seenItemIds.has(itemId)) || seenTitles.has(normalizedTitle)) return false;
    if (itemId) seenItemIds.add(itemId);
    seenTitles.add(normalizedTitle);
    return true;
  });
}

export function offerDetail(value) {
  return typeof value === 'string' && value.trim() && !/^unknown$/i.test(value.trim())
    ? value
    : 'Details unavailable';
}

export function sellerDisplayName(value) {
  return typeof value === 'string' && value.trim() && !/^seller details unavailable$/i.test(value.trim())
    ? value
    : 'Seller details unavailable';
}
