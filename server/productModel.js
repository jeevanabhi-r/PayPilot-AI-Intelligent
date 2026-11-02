const DATA_TYPES = new Set(['LIVE', 'DEMO']);
const CURRENCIES = /^[A-Z]{3}$/;
const TRUSTED_EBAY_HOSTS = new Set([
  'ebay.com',
  'ebay.co.uk',
  'ebay.ca',
  'ebay.de',
  'ebay.fr',
  'ebay.it',
  'ebay.es',
  'ebay.com.au',
  'ebay.at',
  'ebay.ch',
  'ebay.nl',
  'ebay.ie',
  'ebay.be',
  'ebay.pl',
  'ebay.com.hk',
  'ebay.com.sg',
  'ebay.in',
  'ebay.com.my',
  'ebay.ph',
  'ebay.com.mx',
  'www.ebay.com',
  'www.ebay.co.uk',
  'www.ebay.ca',
  'www.ebay.de',
  'www.ebay.fr',
  'www.ebay.it',
  'www.ebay.es',
  'www.ebay.com.au',
  'www.ebay.at',
  'www.ebay.ch',
  'www.ebay.nl',
  'www.ebay.ie',
  'www.ebay.be',
  'www.ebay.pl',
  'www.ebay.com.hk',
  'www.ebay.com.sg',
  'www.ebay.in',
  'www.ebay.com.my',
  'www.ebay.ph',
  'www.ebay.com.mx',
]);

export function isValidLiveListingUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && /^\/itm\/[^/]+(?:\/|$)/i.test(url.pathname)
      && TRUSTED_EBAY_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function normalizeProduct(input) {
  if (!input || typeof input !== 'object') return null;
  const rawId = input.productId ?? input.id;
  const rawTitle = input.title ?? input.name;
  const productId = typeof rawId === 'string' ? rawId.trim() : '';
  const title = typeof rawTitle === 'string' ? rawTitle.trim() : '';
  const price = Number(input.price);
  const currency = typeof input.currency === 'string' ? input.currency.trim().toUpperCase() : '';
  const category = typeof input.category === 'string' ? input.category.trim() : '';
  const dataType = input.dataType;
  if (!productId || !title || !category || !Number.isFinite(price) || price <= 0
    || !CURRENCIES.test(currency) || !DATA_TYPES.has(dataType)) return null;

  const rawListingUrl = input.listingUrl ?? input.retailerUrl;
  const listingUrl = typeof rawListingUrl === 'string' && rawListingUrl.trim() ? rawListingUrl.trim() : null;
  if (dataType === 'LIVE' && !isValidLiveListingUrl(listingUrl)) return null;
  const brand = typeof input.brand === 'string' && input.brand.trim() ? input.brand.trim() : null;
  const specifications = input.specifications && typeof input.specifications === 'object' && !Array.isArray(input.specifications)
    ? input.specifications
    : {};
  const imageValue = typeof input.image === 'string' ? input.image : input.image?.imageUrl;
  const image = typeof imageValue === 'string' && imageValue.trim() ? imageValue.trim() : null;
  const availability = dataType === 'DEMO'
    ? 'Sample data'
    : typeof input.availability === 'string' && input.availability.trim()
    ? input.availability.trim()
    : 'Details unavailable';
  const source = dataType === 'DEMO'
    ? 'PayPilot Curated Demo Catalogue'
    : typeof input.source === 'string' && input.source.trim()
    ? input.source.trim()
    : 'Live provider';

  return {
    productId,
    title,
    brand,
    category,
    price,
    currency,
    specifications,
    image,
    source,
    listingUrl: dataType === 'LIVE' ? listingUrl : null,
    availability,
    dataType,
    id: productId,
    name: title,
    retailerUrl: dataType === 'LIVE' ? listingUrl : null,
    external: dataType === 'LIVE',
    merchant: dataType === 'LIVE' && typeof input.merchant === 'string' && input.merchant.trim() ? input.merchant.trim() : null,
    condition: typeof input.condition === 'string' && input.condition.trim() ? input.condition.trim() : null,
  };
}

export function productSourceMatches(product, dataType) {
  return DATA_TYPES.has(dataType) && product?.dataType === dataType;
}

export function deduplicateProducts(products) {
  const itemIds = new Set();
  const titles = new Set();
  return products.filter((product) => {
    const itemId = product.dataType === 'LIVE' ? product.productId.replace(/^ebay:/, '') : '';
    const title = product.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if ((itemId && itemIds.has(itemId)) || (title && titles.has(title))) return false;
    if (itemId) itemIds.add(itemId);
    if (title) titles.add(title);
    return true;
  });
}
