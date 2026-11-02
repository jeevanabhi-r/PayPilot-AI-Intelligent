import { isOfferRelevantToQuery } from '../src/offerUtils.js';
import { isValidLiveListingUrl } from './productModel.js';

/**
 * External catalog adapter. It never fabricates offers: without configured provider
 * credentials it returns an explicit unavailable result rather than sample products.
 */
function safeErrorDetails(payload, secrets) {
  const providerError = Array.isArray(payload?.errors) ? payload.errors[0] : null;
  const sanitize = (value) => {
    let sanitized = String(value).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    sanitized = sanitized.replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 [redacted]');
    for (const secret of secrets) {
      if (secret) sanitized = sanitized.split(secret).join('[redacted]');
    }
    return sanitized.slice(0, 180);
  };
  const code = providerError?.errorId;
  return {
    ...(Number.isInteger(code) || (typeof code === 'string' && /^[A-Za-z0-9._-]{1,40}$/.test(code)) ? { errorId: code } : {}),
    ...(typeof providerError?.domain === 'string' ? { domain: sanitize(providerError.domain) } : {}),
    ...(typeof providerError?.category === 'string' ? { category: sanitize(providerError.category) } : {}),
    ...(typeof providerError?.message === 'string' && sanitize(providerError.message) ? { message: sanitize(providerError.message) } : {}),
  };
}

function logBrowseResponse(response, logger) {
  logger.info?.('[eBay Browse] Search response metadata', {
    status: response.status,
    contentType: (response.headers?.get?.('content-type') || '').slice(0, 100),
  });
}

function logBrowseResponseBody(response, payload, logger, secrets) {
  const properties = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? Object.keys(payload).filter((key) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key))
    : [];
  const details = { status: response.status, topLevelProperties: properties };
  if (response.ok) {
    details.itemSummariesExists = Array.isArray(payload?.itemSummaries);
    details.itemSummariesCount = details.itemSummariesExists ? payload.itemSummaries.length : 0;
    for (const key of ['total', 'limit', 'offset']) {
      if (typeof payload?.[key] === 'number' && Number.isFinite(payload[key])) details[key] = payload[key];
    }
  }
  logger.info?.('[eBay Browse] Search response body metadata', details);
  if (Array.isArray(payload?.errors) && payload.errors.length) {
    logger.warn?.('[eBay Browse] API error', { status: response.status, ...safeErrorDetails(payload, secrets) });
  }
}

function safeSearchQuery(query, secrets) {
  let sanitized = String(query)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 [redacted]');
  for (const secret of secrets) {
    if (secret) sanitized = sanitized.split(secret).join('[redacted]');
  }
  return sanitized.slice(0, 250);
}

function hasValidListingUrl(value) {
  return isValidLiveListingUrl(value);
}

export function createEbayProductSearch({ env = process.env, fetchImpl = globalThis.fetch, logger = console } = {}) {
  let ebayToken = null;
  let ebayTokenExpiresAt = 0;

  async function ebayAccessToken() {
    if (ebayToken && Date.now() < ebayTokenExpiresAt - 60_000) return ebayToken;
    const root = env.EBAY_ENV === 'sandbox' ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com';
    const credentials = Buffer.from(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`).toString('base64');
    let response;
    try {
      response = await fetchImpl(`${root}/identity/v1/oauth2/token`, {
        method: 'POST',
        headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'https://api.ebay.com/oauth/api_scope' }).toString(),
      });
    } catch (error) {
      logger.warn?.('[eBay Browse] OAuth request failed before receiving a response', { message: safeErrorDetails({ errors: [{ message: error.message }] }, [env.EBAY_CLIENT_ID, env.EBAY_CLIENT_SECRET]).message || 'Network error' });
      throw new Error('eBay token request failed before receiving a response.');
    }

    logger.info?.('[eBay Browse] OAuth response', { status: response.status });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      logger.warn?.('[eBay Browse] OAuth error', { status: response.status, ...safeErrorDetails(payload, [env.EBAY_CLIENT_ID, env.EBAY_CLIENT_SECRET]) });
      throw new Error(`eBay token request failed (${response.status})`);
    }

    const data = await response.json();
    if (typeof data.access_token !== 'string' || !data.access_token) {
      logger.warn?.('[eBay Browse] OAuth response did not contain an access token', { status: response.status });
      throw new Error('eBay token response did not contain an access token.');
    }
    ebayToken = data.access_token;
    ebayTokenExpiresAt = Date.now() + Number(data.expires_in || 7200) * 1000;
    return ebayToken;
  }

  return async function searchExternalProducts(query, limit = 12) {
    if (!env.EBAY_CLIENT_ID || !env.EBAY_CLIENT_SECRET) return { products: [], provider: 'not-configured', message: 'External discovery is not configured. Configure the eBay Browse API credentials to search verified retailer offers.' };
    const token = await ebayAccessToken();
    const root = env.EBAY_ENV === 'sandbox' ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com';
    const url = new URL(`${root}/buy/browse/v1/item_summary/search`);
    url.searchParams.set('q', query);
    url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 25)));
    const marketplaceId = env.EBAY_MARKETPLACE_ID || 'EBAY_US';
    logger.info?.('[eBay Browse] Search request', {
      query: safeSearchQuery(query, [env.EBAY_CLIENT_ID, env.EBAY_CLIENT_SECRET, token]),
      marketplaceId,
    });
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': env.EBAY_MARKETPLACE_ID || 'EBAY_US' },
      });
    } catch (error) {
      logger.warn?.('[eBay Browse] Search request failed before receiving a response', { message: safeErrorDetails({ errors: [{ message: error.message }] }, [env.EBAY_CLIENT_ID, env.EBAY_CLIENT_SECRET, token]).message || 'Network error' });
      throw new Error('eBay search failed before receiving a response.');
    }

    logBrowseResponse(response, logger);
    const body = await response.text().catch(() => '');
    const payload = parseJsonBody(body);
    logBrowseResponseBody(response, payload, logger, [env.EBAY_CLIENT_ID, env.EBAY_CLIENT_SECRET, token]);
    if (!response.ok) throw new Error(`eBay search failed (${response.status})`);
    if (!payload) throw new Error('eBay search returned an invalid JSON response.');
    if (Array.isArray(payload.errors) && payload.errors.length) {
      throw new Error(`eBay search returned provider errors (${response.status})`);
    }
    if (!Array.isArray(payload.itemSummaries)) {
      throw new Error('eBay search response did not contain item summaries.');
    }
    const data = payload;
    const summaries = data.itemSummaries;
    const objects = summaries.filter((item) => item && typeof item === 'object');
    const seenItemIds = new Set();
    const seenTitles = new Set();
    const diagnostics = {
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
    };
    const products = objects.flatMap((item) => {
      const itemId = typeof item.itemId === 'string' ? item.itemId.trim() : '';
      const title = typeof item.title === 'string' ? item.title.trim() : '';
      const priceValue = item.price?.value;
      const price = Number(priceValue);
      const currencyValue = item.price?.currency;
      const currency = typeof currencyValue === 'string' ? currencyValue.trim() : '';
      const sellerUsername = typeof item.seller?.username === 'string' ? item.seller.username.trim() : '';
      const merchant = sellerUsername || 'Seller details unavailable';
      const categories = Array.isArray(item.categories)
        ? item.categories.map((category) => category?.categoryName).filter((name) => typeof name === 'string')
        : [];
      const validPrice = Number.isFinite(price) && price > 0;
      const validCurrency = /^[A-Z]{3}$/.test(currency);
      const validListingUrl = hasValidListingUrl(item.itemWebUrl);
      const relevant = title && isOfferRelevantToQuery({ name: title, category: categories.join(' ') }, query);
      const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

      if (!itemId) diagnostics.missingItemIdCount += 1;
      if (!title) diagnostics.missingTitleCount += 1;
      if (!validPrice) diagnostics.invalidPriceCount += 1;
      if (!currency) diagnostics.missingCurrencyCount += 1;
      else if (!validCurrency) diagnostics.invalidCurrencyCount += 1;
      if (!sellerUsername) diagnostics.missingSellerCount += 1;
      if (!validListingUrl) diagnostics.invalidListingUrlCount += 1;
      if (title && !relevant) diagnostics.titleRelevanceFailureCount += 1;

      if (!itemId || !title || !validPrice || !validCurrency || !validListingUrl || !relevant) return [];
      if (seenItemIds.has(itemId)) {
        diagnostics.duplicateOfferCount += 1;
        return [];
      }
      if (seenTitles.has(normalizedTitle)) {
        diagnostics.duplicateTitleCount += 1;
        return [];
      }
      seenItemIds.add(itemId);
      seenTitles.add(normalizedTitle);
      return [{
        id: `ebay:${itemId}`,
        external: true,
        name: title,
        price,
        currency,
        image: item.image?.imageUrl || null,
        condition: item.condition || null,
        merchant,
        retailerUrl: item.itemWebUrl,
        category: item.categories?.[0]?.categoryName || 'External offer',
        source: 'eBay Browse API',
        availability: item.availabilityStatus && item.availabilityStatus !== 'Unknown' ? item.availabilityStatus : 'Details unavailable',
      }];
    });
    logger.info?.('[eBay Browse] Search results parsed', {
      summaryCount: summaries.length,
      validOfferCount: products.length,
      rejectedSummaryCount: summaries.length - products.length,
      ...diagnostics,
      summariesFieldPresent: Array.isArray(data.itemSummaries),
      missingListingUrlCount: objects.filter((item) => !item.itemWebUrl).length,
    });
    return { provider: 'ebay-browse', products };
  };
}

export const searchExternalProducts = createEbayProductSearch();

function parseJsonBody(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
