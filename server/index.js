import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { catalog, compareProducts, parseRequest, validatePlan } from './logic.js';
import { searchProducts } from './productService.js';
import { recommendProducts } from './recommendationService.js';
import { compareProductSelection } from './comparison.js';
import { BUDGET_CATEGORIES, optimizeBudget } from './budgetOptimizer.js';
import { matchesSavedListing, priceIntelligence } from './priceIntelligence.js';
import { createWishlistService } from './wishlistService.js';
import { beginChatTurn, extractProductSearchQuery, isProductResearchRequest, saveChatTurn } from './chat.js';
import { getMarketplaceProduct, listMarketplaceProducts } from './marketplace.js';
import { getAdminDb, requireAdmin, requireUser } from './auth.js';
import { rateLimit } from './rateLimit.js';

const app = express();
const port = Number(process.env.PORT || 3001);
const paypalReady = Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
const allowedOrigins = (process.env.APP_ORIGIN || 'http://localhost:5173').split(',').map((value) => value.trim());

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(cors({ origin(origin, callback) { return !origin || allowedOrigins.includes(origin) ? callback(null, true) : callback(new Error('Origin not allowed')); }, methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'] }));
app.use(express.json({ limit: '20kb' }));
app.use((error, _req, res, next) => error?.message === 'Origin not allowed' ? res.status(403).json({ error: 'Origin is not allowed.' }) : next(error));

function fail(res, status, message) { return res.status(status).json({ error: message }); }

async function observeUserPrices(userId, products) {
  const db = getAdminDb();
  if (!db) return { available: false, recordedCount: 0 };
  try {
    const result = await priceIntelligence.observeSearchResults(db, userId, products);
    if (result.errors.length) {
      console.warn(`[price-intelligence] ${result.errors.length} provider observation(s) could not be stored for the current user.`);
    }
    return {
      available: true,
      recordedCount: result.recordedCount,
      warning: result.errors.length ? 'Some price history observations could not be stored.' : null,
    };
  } catch (error) {
    console.error('Price history update failed:', error.message);
    return { available: false, recordedCount: 0, warning: 'Price history could not be updated during this provider refresh.' };
  }
}

function validWishlistId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,150}$/.test(value);
}

const wishlistService = createWishlistService({ searchProducts });

async function paypalToken() {
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const response = await fetch('https://api-m.sandbox.paypal.com/v1/oauth2/token', { method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
  if (!response.ok) throw new Error(`PayPal authentication failed (${response.status})`);
  return (await response.json()).access_token;
}

async function paypalCall(endpoint, method, body, requestId = crypto.randomUUID()) {
  const token = await paypalToken();
  const response = await fetch(`https://api-m.sandbox.paypal.com${endpoint}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': requestId }, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `PayPal request failed (${response.status})`);
  return data;
}

app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'paypilot-api', paypal: paypalReady ? 'sandbox-configured' : 'not-configured', firebaseAdmin: Boolean(getAdminDb()) }));
app.get('/api/config', (_req, res) => res.json({ mode: paypalReady ? 'sandbox' : 'unavailable', clientId: paypalReady ? process.env.PAYPAL_CLIENT_ID : null, aiEnabled: Boolean(process.env.GROQ_API_KEY), currency: 'USD' }));
app.get('/api/catalog', async (_req, res) => { try { res.json({ products: await listMarketplaceProducts(getAdminDb()), source: 'paypilot-marketplace' }); } catch (error) { console.error('Catalog failed:', error.message); fail(res, 503, 'Marketplace catalog is temporarily unavailable.'); } });
app.get('/api/admin/products', requireUser, requireAdmin, async (_req, res) => { const snapshot = await getAdminDb().collection('marketplaceProducts').orderBy('updatedAt', 'desc').limit(100).get(); res.json({ products: snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })) }); });
app.put('/api/admin/products/:id', requireUser, requireAdmin, async (req, res) => { const id = String(req.params.id); const input = req.body || {}; const price = Number(input.price); if (!/^[a-z0-9-]{2,80}$/i.test(id) || !String(input.name || '').trim() || !Number.isFinite(price) || price <= 0 || price > 1_000_000 || !Number.isInteger(Number(input.stock)) || Number(input.stock) < 0) return fail(res, 400, 'Provide a valid product ID, name, positive price, and non-negative integer stock.'); const product = { name: String(input.name).trim().slice(0, 160), description: String(input.description || '').trim().slice(0, 1500), category: String(input.category || 'General').trim().slice(0, 80), price, currency: 'USD', stock: Number(input.stock), available: input.available !== false, imageUrl: String(input.imageUrl || '').trim().slice(0, 2000), updatedAt: new Date().toISOString(), updatedBy: req.user.uid }; await getAdminDb().collection('marketplaceProducts').doc(id).set(product, { merge: true }); res.status(201).json({ id, ...product }); });
app.delete('/api/admin/products/:id', requireUser, requireAdmin, async (req, res) => { await getAdminDb().collection('marketplaceProducts').doc(req.params.id).delete(); res.status(204).end(); });
app.get('/api/products/search', rateLimit({ max: 30 }), requireUser, async (req, res) => {
  const search = String(req.query.q || '').trim(); const budget = Number(req.query.budget);
  if (search.length < 2 || search.length > 120) return fail(res, 400, 'Provide a search between 2 and 120 characters.');
  try {
    const result = await searchProducts(search);
    const validBudget = Number.isFinite(budget) && budget > 0 ? budget : null;
    const products = compareProducts(result.products, validBudget);
    const priceTracking = await observeUserPrices(req.user.uid, products);
    const recommendationQuery = validBudget === null ? search : `${search} under ${validBudget} USD`;
    const recommendations = await recommendProducts(recommendationQuery, products);
    res.json({
      ...result,
      products,
      recommendations,
      priceTracking,
      purchaseNotice: 'Live eBay offers link to their retailer. Demo products are sample data and have no retailer listing.',
    });
  } catch (error) { console.error('External product search failed:', error.message); fail(res, 502, 'Product discovery is temporarily unavailable.'); }
});
app.post('/api/wishlist/live', rateLimit({ max: 20 }), requireUser, async (req, res) => {
  const db = getAdminDb();
  if (!db) return fail(res, 503, 'Secure wishlist storage is not configured.');
  try {
    const result = await wishlistService.saveVerifiedLiveProduct(db, req.user.uid, req.body);
    if (!result.found) return fail(res, 404, 'The LIVE listing could not be revalidated. Refresh product discovery and try again.');
    res.status(201).json({ id: result.id, item: result.item });
  } catch (error) {
    if (error instanceof TypeError) return fail(res, 400, error.message);
    console.error('LIVE wishlist save failed:', error.message);
    fail(res, 502, 'The LIVE listing could not be verified right now.');
  }
});
app.post('/api/research', rateLimit({ max: 15 }), requireUser, async (req, res) => {
  const queryText = String(req.body?.query || '').trim(); const budget = Number(req.body?.budget);
  if (queryText.length < 2 || queryText.length > 120) return fail(res, 400, 'Provide a research query between 2 and 120 characters.');
  try {
    const source = await searchProducts(queryText); const products = compareProducts(source.products, Number.isFinite(budget) && budget > 0 ? budget : null);
    const priceTracking = await observeUserPrices(req.user.uid, products);
    const recommendationQuery = Number.isFinite(budget) && budget > 0 && !/\b(?:under|below|budget|less than|within|up to)\b/i.test(queryText)
      ? `${queryText} under ${budget} USD`
      : queryText;
    const recommendations = await recommendProducts(recommendationQuery, products);
    if (!products.length) return res.json({ ...source, products, recommendations, priceTracking, research: null, disclaimer: 'No live or curated demo products matched this search.' });
    let recommendation = products.find((product) => product.withinBudget) || products[0];
    let explanation = recommendation.dataType === 'DEMO'
      ? `Sample catalogue option: ${recommendation.name} at a sample price of ${recommendation.price} ${recommendation.currency}. This is demonstration data, not a live retailer listing.`
      : `Live ${recommendation.currency} offer returned by ${source.provider}: ${recommendation.name} at ${recommendation.price}. Review the retailer listing before buying.`;
    let engine = 'rules';
    if (process.env.GROQ_API_KEY) try { const response = await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile', temperature: 0.1, max_tokens: 180, messages: [{ role: 'system', content: 'Explain the verified offers using ONLY the provided data. Do not infer specifications, availability, reviews, shipping, payment, or merchant facts. State that price and availability may change. Keep under 100 words.' }, { role: 'user', content: JSON.stringify({ query: queryText, budget: Number.isFinite(budget) ? budget : null, offers: products.slice(0, 5).map(({ name, price, currency, merchant, condition, availability, retailerUrl }) => ({ name, price, currency, merchant, condition, availability, retailerUrl })) }) }] }) }); if (response.ok) { explanation = (await response.json()).choices?.[0]?.message?.content?.slice(0, 700) || explanation; engine = 'groq'; } } catch (error) { console.warn('Research fallback used:', error.message); }
    if (products.some((product) => product.dataType === 'DEMO')) {
      const liveCount = products.filter((product) => product.dataType === 'LIVE').length;
      explanation = liveCount
        ? `The results include ${liveCount} live eBay offer${liveCount === 1 ? '' : 's'} and ${products.length - liveCount} DEMO sample product${products.length - liveCount === 1 ? '' : 's'}. DEMO prices are examples, not retailer offers.`
        : `${source.message ? `${source.message} ` : ''}Sample catalogue option: ${recommendation.name} at a sample price of ${recommendation.price} ${recommendation.currency}. This is demonstration data, not a live retailer listing.`;
      engine = 'rules';
    }
    const scoredRecommendation = recommendations.recommendations[0] || recommendations.alternatives[0] || null;
    if (scoredRecommendation) {
      recommendation = scoredRecommendation;
      explanation = `${recommendations.allRequirementsSatisfied ? 'Top match' : 'Closest alternative'}: ${scoredRecommendation.recommendation.explanation}`;
      engine = scoredRecommendation.recommendation.explanationSource;
    } else {
      recommendation = null;
      explanation = 'No products were available to recommend.';
      engine = 'rules';
    }
    res.json({ provider: source.provider, message: source.message, liveSearchFailed: source.liveSearchFailed, products, recommendations, priceTracking, research: { recommendation, explanation, engine }, disclaimer: products.some((product) => product.dataType === 'DEMO') ? 'DEMO products are sample data, not live listings. Live retailer data is verified only at retrieval time; PayPilot does not complete external retailer purchases.' : 'Live retailer data is verified only at retrieval time; PayPilot does not complete external retailer purchases.' });
  } catch (error) { console.error('Research failed:', error.message); fail(res, 502, 'Verified product research is temporarily unavailable.'); }
});
app.get('/api/price-intelligence', rateLimit({ max: 30 }), requireUser, async (req, res) => {
  const db = getAdminDb();
  if (!db) return fail(res, 503, 'Secure price tracking storage is not configured.');
  try {
    const result = await priceIntelligence.listUserPrices(db, req.user.uid);
    res.json({
      ...result,
      monitoring: 'Prices update when a matching provider refresh occurs; no background monitoring is configured.',
    });
  } catch (error) {
    console.error('Price intelligence load failed:', error.message);
    fail(res, 503, 'Price history and alerts are temporarily unavailable.');
  }
});
app.put('/api/price-intelligence/:wishlistId/target', rateLimit({ max: 20 }), requireUser, async (req, res) => {
  const { wishlistId } = req.params;
  const targetPrice = req.body?.targetPrice;
  const targetCurrency = typeof req.body?.targetCurrency === 'string'
    ? req.body.targetCurrency.trim().toUpperCase()
    : '';
  if (!validWishlistId(wishlistId)) return fail(res, 400, 'Saved product ID is invalid.');
  if (typeof targetPrice !== 'number' || !Number.isFinite(targetPrice) || targetPrice <= 0 || targetPrice > 1_000_000) {
    return fail(res, 400, 'Target price must be greater than zero and at most 1,000,000.');
  }
  if (!/^[A-Z]{3}$/.test(targetCurrency)) return fail(res, 400, 'Provide a valid three-letter target currency.');
  const db = getAdminDb();
  if (!db) return fail(res, 503, 'Secure price tracking storage is not configured.');
  try {
    const result = await priceIntelligence.setTarget(db, req.user.uid, wishlistId, targetPrice, targetCurrency);
    if (!result.found) return fail(res, 404, 'Saved product was not found.');
    res.json(result);
  } catch (error) {
    if (error instanceof TypeError) return fail(res, 400, error.message);
    console.error('Price target update failed:', error.message);
    fail(res, 503, 'Price target could not be updated.');
  }
});
app.delete('/api/price-intelligence/:wishlistId/target', rateLimit({ max: 20 }), requireUser, async (req, res) => {
  const { wishlistId } = req.params;
  if (!validWishlistId(wishlistId)) return fail(res, 400, 'Saved product ID is invalid.');
  const db = getAdminDb();
  if (!db) return fail(res, 503, 'Secure price tracking storage is not configured.');
  try {
    const result = await priceIntelligence.deleteTarget(db, req.user.uid, wishlistId);
    if (!result.found) return fail(res, 404, 'Saved product was not found.');
    res.json({ deleted: true });
  } catch (error) {
    console.error('Price target delete failed:', error.message);
    fail(res, 503, 'Price target could not be deleted.');
  }
});
app.post('/api/price-intelligence/:wishlistId/refresh', rateLimit({ max: 12 }), requireUser, async (req, res) => {
  const { wishlistId } = req.params;
  if (!validWishlistId(wishlistId)) return fail(res, 400, 'Saved product ID is invalid.');
  const db = getAdminDb();
  if (!db) return fail(res, 503, 'Secure price tracking storage is not configured.');
  try {
    const saved = await priceIntelligence.getSavedLiveItem(db, req.user.uid, wishlistId);
    if (!saved) return res.json({
      refreshed: false,
      status: 'unavailable',
      message: 'This saved product has no verifiable LIVE listing; sample products are not price-tracked.',
    });
    const searchTerm = String(saved.item.title || saved.item.name || '').trim();
    if (searchTerm.length < 2) return fail(res, 400, 'Saved product has no searchable title.');
    const source = await searchProducts(searchTerm);
    const matchingProduct = source.products.find((product) => (
      product.dataType === 'LIVE' && matchesSavedListing(saved.identity, product)
    ));
    if (!matchingProduct) return res.json({
      refreshed: false,
      status: 'unavailable',
      message: source.liveSearchFailed
        ? 'The live provider search failed. Price history is unchanged; try again after a provider refresh is available.'
        : 'No matching LIVE listing was returned. Price history is unchanged; another listing was not substituted.',
    });
    const observation = await priceIntelligence.recordObservation(db, req.user.uid, wishlistId, matchingProduct);
    if (!observation.recorded) return fail(res, 409, observation.reason);
    res.json({
      refreshed: true,
      status: 'updated',
      snapshot: observation.snapshot,
      alertsCreated: observation.alertsCreated,
      message: 'Price updated from a matching LIVE provider refresh.',
    });
  } catch (error) {
    console.error('Provider price refresh failed:', error.message);
    fail(res, 502, 'Price refresh failed. Existing history was not changed.');
  }
});
app.post('/api/chat', rateLimit({ max: 20 }), requireUser, async (req, res) => {
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  const conversationId = typeof req.body?.conversationId === 'string' ? req.body.conversationId : null;
  const requestId = typeof req.body?.requestId === 'string' ? req.body.requestId : '';
  if (!message || message.length > 1500) return fail(res, 400, 'Enter a message between 1 and 1500 characters.');
  if (conversationId && !/^[A-Za-z0-9_-]{1,128}$/.test(conversationId)) return fail(res, 400, 'Conversation ID is invalid.');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) return fail(res, 400, 'A valid request ID is required.');

  try {
    const turn = await beginChatTurn({ db: getAdminDb(), userId: req.user.uid, conversationId, requestId, message });
    if (turn.alreadyCompleted) return res.json({ conversationId: turn.conversationId, userMessage: turn.userMessage, assistantMessage: turn.assistantMessage });
    const productResearch = isProductResearchRequest(message, turn.context);
    let offers = [];
    let offerQuery = '';
    let providerMessage = '';
    let recommendationResult = null;
    if (productResearch) {
      const searchQuery = extractProductSearchQuery(message);
      if (!searchQuery) {
        providerMessage = 'Tell me which product you are looking for.';
      } else {
        offerQuery = searchQuery;
        try {
          const source = await searchProducts(searchQuery);
          const products = compareProducts(source.products);
          await observeUserPrices(req.user.uid, products);
          recommendationResult = await recommendProducts(message, products);
          offers = (recommendationResult.recommendations.length
            ? recommendationResult.recommendations
            : recommendationResult.alternatives).slice(0, 3);
          providerMessage = source.message || '';
          if (!offers.length && !providerMessage) providerMessage = 'No verified offers were returned by the configured provider.';
        } catch (error) {
          console.error('Chat product search failed:', error.message);
          providerMessage = 'I could not retrieve verified retailer offers right now. Please try again later.';
        }
      }
    }

    let content = productResearch
      ? offers.length
        ? `${providerMessage ? `${providerMessage} ` : ''}${recommendationResult?.allRequirementsSatisfied ? 'Top matches for your stated requirements' : 'No product met every stated requirement; here are the closest alternatives'}: ${offers.map((offer) => `${offer.title} (${offer.recommendation.score}/100)`).join('; ')}. Product explanations use listed product data; demo items are sample data, not live retailer listings.`
        : providerMessage || 'I could not find verified retailer offers for that request.'
      : 'I can help with shopping research and follow-up questions. Ask me to find or compare a product using current retailer offers.';

    if (process.env.GROQ_API_KEY && !productResearch) {
      try {
        const messages = [
          { role: 'system', content: 'You are PayPilot AI, a conversational shopping assistant. Use conversation history to understand follow-up questions. Never invent or state product prices, availability, retailer details, listing links, reviews, or product specifications. Never initiate payments or claim a purchase was made. For current verified product research, ask the user to make a product request; the app retrieves retailer offers separately. Keep responses concise.' },
          ...turn.context,
          { role: 'user', content: message },
        ];
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile', temperature: 0.1, max_tokens: 300, messages }),
        });
        if (response.ok) {
          content = (await response.json()).choices?.[0]?.message?.content?.trim().slice(0, 4000) || content;
        } else {
          console.warn(`Chat Groq request failed (${response.status}); using verified fallback.`);
        }
      } catch (error) {
        console.warn('Chat Groq fallback used:', error.message);
      }
    }

    const assistantMessage = await saveChatTurn({ ...turn, content, offers, offerQuery });
    res.json({ conversationId: turn.conversationId, userMessage: turn.userMessage, assistantMessage });
  } catch (error) {
    if (error.status === 404) return fail(res, 404, error.message);
    console.error('Chat request failed:', error.message);
    fail(res, 503, 'Chat could not be saved or completed. Please try again.');
  }
});
app.post('/api/compare', rateLimit({ max: 30 }), requireUser, async (req, res) => {
  const products = Array.isArray(req.body?.products) ? req.body.products : [];
  if (products.length < 2 || products.length > 3) return fail(res, 400, 'Select two or three products to compare.');
  const query = typeof req.body?.query === 'string' ? req.body.query.trim().slice(0, 1200) : '';
  try {
    const comparison = await compareProductSelection(products, query);
    if (comparison.products.length < 2) return fail(res, 400, 'At least two valid products are required for comparison.');
    res.json({
      ...comparison,
      disclaimer: 'Comparison uses only supplied product fields. DEMO products are sample data, not live retailer listings. Currency differences are not converted.',
    });
  } catch (error) {
    console.error('Product comparison failed:', error.message);
    fail(res, 503, 'Product comparison is temporarily unavailable.');
  }
});
app.post('/api/budget/optimize', rateLimit({ max: 8 }), requireUser, async (req, res) => {
  const budget = Number(req.body?.budget);
  const currency = typeof req.body?.currency === 'string' ? req.body.currency.trim().toUpperCase() : '';
  const categories = Array.isArray(req.body?.categories) ? req.body.categories : [];
  const categoryMap = new Map(BUDGET_CATEGORIES.map((category) => [category.toLowerCase(), category]));
  const normalizedCategories = [...new Set(categories.map((category) => (
    typeof category === 'string' ? categoryMap.get(category.trim().toLowerCase()) : null
  )).filter(Boolean))];
  if (!Number.isFinite(budget) || budget <= 0 || budget > 1_000_000) {
    return fail(res, 400, 'Enter a total budget greater than zero and no more than 1,000,000.');
  }
  if (!/^[A-Z]{3}$/.test(currency)) return fail(res, 400, 'Provide a valid three-letter currency code.');
  if (!normalizedCategories.length || normalizedCategories.length !== new Set(categories).size) {
    return fail(res, 400, 'Select one or more valid, unique product categories.');
  }
  const preferredBrands = Array.isArray(req.body?.preferredBrands) ? req.body.preferredBrands : [];
  const intendedUse = typeof req.body?.intendedUse === 'string' ? req.body.intendedUse.trim() : '';
  const priorities = typeof req.body?.priorities === 'string' ? req.body.priorities.trim() : '';
  if (preferredBrands.length > 10
    || preferredBrands.some((brand) => typeof brand !== 'string' || !brand.trim() || brand.length > 60)
    || intendedUse.length > 240
    || priorities.length > 1200) {
    return fail(res, 400, 'Preferences exceed the supported input limits.');
  }
  try {
    const results = await Promise.all(normalizedCategories.map(async (category) => {
      try {
        return { category, result: await searchProducts(category), failed: false };
      } catch (error) {
        console.warn(`[budget-optimizer] Search failed for ${category}: ${error.message}`);
        return { category, result: { products: [] }, failed: true };
      }
    }));
    const searchFailures = results.filter(({ failed }) => failed).map(({ category }) => category);
    const products = results.flatMap(({ category, result }) => (
      result.products.map((product) => ({
        ...product,
        requestedCategory: BUDGET_CATEGORIES.includes(product.category) ? product.category : category,
      }))
    ));
    const priceTracking = await observeUserPrices(req.user.uid, products);
    const optimization = optimizeBudget({
      products,
      budget,
      currency,
      categories: normalizedCategories,
      preferredBrands,
      intendedUse,
      priorities,
    });
    res.json({
      ...optimization,
      searchFailures,
      priceTracking,
      searchStatuses: results.map(({ category, result }) => ({
        category,
        liveCount: result.liveCount || 0,
        demoCount: result.demoCount || 0,
        liveSearchFailed: result.liveSearchFailed === true,
        message: result.message || null,
      })),
    });
  } catch (error) {
    console.error('Budget optimization failed:', error.message);
    fail(res, 503, 'Budget optimization is temporarily unavailable.');
  }
});

app.post('/api/plan', rateLimit({ max: 20 }), requireUser, async (req, res) => {
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!message || message.length > 2500) return fail(res, 400, 'Enter a request between 1 and 2500 characters.');
  let plan = parseRequest(message); let engine = 'rules';
  if (process.env.GROQ_API_KEY) try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile', temperature: 0.1, max_tokens: 260, messages: [{ role: 'system', content: `You are a product recommendation planner. Respond ONLY with JSON: productId, budget (number|null), reason (one sentence), alternatives (product IDs). Select only from ${JSON.stringify(catalog.map(({ id, name, price, description }) => ({ id, name, price, description })))}. Never invent facts, products, prices, stock, reviews, retailers, or completed payments.` }, { role: 'user', content: message }] }) });
    if (response.ok) { const data = await response.json(); const candidate = JSON.parse((data.choices?.[0]?.message?.content || '').replace(/^```(?:json)?\s*|\s*```$/g, '')); if (validatePlan(candidate)) { plan = { ...plan, productId: candidate.productId, reason: String(candidate.reason || plan.reason).slice(0, 350), alternatives: Array.isArray(candidate.alternatives) ? candidate.alternatives.filter((id) => catalog.some((product) => product.id === id)).slice(0, 3) : plan.alternatives }; engine = 'groq'; } }
  } catch (error) { console.warn('AI fallback used:', error.message); }
  const product = catalog.find((item) => item.id === plan.productId);
  res.json({ plan: { ...plan, product, alternatives: plan.alternatives.map((id) => catalog.find((item) => item.id === id)).filter(Boolean), withinBudget: plan.budget === null || product.price <= plan.budget }, engine, verifiedData: { catalog: true, source: 'paypilot-marketplace' } });
});

app.post('/api/orders', rateLimit({ max: 10 }), requireUser, async (req, res) => {
  if (!paypalReady) return fail(res, 503, 'PayPal Sandbox is not configured. No payment or simulated transaction was created.');
  const db = getAdminDb(); const product = await getMarketplaceProduct(db, req.body?.productId);
  if (!product || !product.available || (product.stock !== null && product.stock < 1)) return fail(res, 400, 'Select an available marketplace product.');
  if (req.body?.approved !== true) return fail(res, 400, 'Explicit user approval is required.');
  const idempotencyKey = req.headers['idempotency-key'];
  if (idempotencyKey) {
    const existing = await db.collection('users').doc(req.user.uid).collection('orders').where('idempotencyKey', '==', idempotencyKey).limit(1).get();
    if (!existing.empty) {
      const saved = existing.docs[0].data();
      return res.status(200).json({ id: saved.paypalOrderId, status: saved.status, mode: 'sandbox', idempotent: true });
    }
  }
  try {
    const order = await paypalCall('/v2/checkout/orders', 'POST', { intent: 'CAPTURE', purchase_units: [{ reference_id: product.id, description: product.name, amount: { currency_code: 'USD', value: product.price.toFixed(2) } }] }, idempotencyKey || undefined);
    const orderRef = db.collection('users').doc(req.user.uid).collection('orders').doc(order.id); const createdAt = new Date().toISOString(); const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    await db.runTransaction(async (store) => { if (product.stock !== null) { const productRef = db.collection('marketplaceProducts').doc(product.id); const latest = await store.get(productRef); if (!latest.exists || latest.data().available !== true || latest.data().stock < 1) throw new Error('Product is no longer available.'); store.update(productRef, { stock: latest.data().stock - 1, updatedAt: createdAt }); } store.set(orderRef, { productId: product.id, productName: product.name, productSource: product.source, amount: product.price, currency: product.currency, status: 'RESERVED', paypalOrderId: order.id, idempotencyKey: idempotencyKey || null, createdAt, expiresAt, reservationReleased: false }); });
    res.status(201).json({ id: order.id, status: order.status, mode: 'sandbox' });
  } catch (error) { console.error('PayPal order creation failed:', error.message); fail(res, 502, 'Could not create the PayPal order.'); }
});

app.post('/api/orders/:id/capture', rateLimit({ max: 10 }), requireUser, async (req, res) => {
  const orderId = req.params.id;
  if (!paypalReady) return fail(res, 503, 'PayPal Sandbox is not configured.');
  const db = getAdminDb(); const orderRef = db.collection('users').doc(req.user.uid).collection('orders').doc(orderId); const orderSnapshot = await orderRef.get();
  if (!orderSnapshot.exists) return fail(res, 404, 'Order not found for this account.');
  const savedOrder = orderSnapshot.data();
  if (savedOrder.status !== 'RESERVED') return fail(res, 409, savedOrder.status === 'CAPTURE_PROCESSING' || savedOrder.status === 'RECONCILIATION_REQUIRED' ? 'Payment is already being processed. Do not retry capture.' : 'Order was already processed or its reservation expired.');
  if (Date.parse(savedOrder.expiresAt) < Date.now()) { await db.runTransaction(async (store) => { const current = await store.get(orderRef); if (!current.exists || current.data().status !== 'RESERVED') return; if (current.data().productSource === 'paypilot-marketplace') { const productRef = db.collection('marketplaceProducts').doc(current.data().productId); const productSnapshot = await store.get(productRef); if (productSnapshot.exists) store.update(productRef, { stock: productSnapshot.data().stock + 1, updatedAt: new Date().toISOString() }); } store.update(orderRef, { status: 'EXPIRED', reservationReleased: true, expiredAt: new Date().toISOString() }); }); return fail(res, 409, 'Order reservation expired. Create a new checkout.'); }
  const product = await getMarketplaceProduct(db, savedOrder.productId);
  if (!product || savedOrder.amount !== product.price || savedOrder.currency !== product.currency || savedOrder.currency !== 'USD' || savedOrder.paypalOrderId !== orderId) return fail(res, 409, 'Stored order verification failed.');
  const captureClaimId = crypto.randomUUID();
  const claimed = await db.runTransaction(async (store) => { const current = await store.get(orderRef); if (!current.exists || current.data().status !== 'RESERVED' || current.data().reservationReleased) return false; store.update(orderRef, { status: 'CAPTURE_PROCESSING', captureClaimId, captureClaimedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); return true; });
  if (!claimed) return fail(res, 409, 'Payment is already being processed or the reservation was released.');
  try {
    const capture = await paypalCall(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, 'POST');
    const captured = capture.purchase_units?.[0]?.payments?.captures?.[0];
    if (capture.status !== 'COMPLETED' || captured?.status !== 'COMPLETED' || captured.amount?.value !== product.price.toFixed(2) || captured.amount?.currency_code !== 'USD') throw new Error('CAPTURE_UNVERIFIED');
    const transaction = { id: captured.id || crypto.randomUUID(), orderId, productId: product.id, productName: product.name, amount: product.price, currency: 'USD', status: 'COMPLETED', paypalCaptureId: captured.id || null, createdAt: new Date().toISOString() };
    await db.runTransaction(async (store) => { const transactionRef = db.collection('users').doc(req.user.uid).collection('transactions').doc(orderId); const currentOrder = await store.get(orderRef); if ((await store.get(transactionRef)).exists || !currentOrder.exists || currentOrder.data().status !== 'CAPTURE_PROCESSING' || currentOrder.data().captureClaimId !== captureClaimId || currentOrder.data().reservationReleased) throw new Error('Duplicate capture blocked.'); store.set(transactionRef, transaction); store.update(orderRef, { status: 'COMPLETED', capturedAt: transaction.createdAt, paypalCaptureId: transaction.paypalCaptureId, captureClaimId: null }); });
    res.json({ transaction, captureStatus: capture.status, mode: 'sandbox' });
  } catch (error) { console.error('PayPal capture failed:', error.message); if (error.message !== 'Duplicate capture blocked.') await orderRef.set({ status: 'RECONCILIATION_REQUIRED', reconciliationReason: error.message === 'CAPTURE_UNVERIFIED' ? 'PayPal response was incomplete or unverifiable; verify before releasing reservation' : 'Capture call failed or database finalization failed; verify PayPal before releasing reservation', nextAttemptAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, { merge: true }).catch(() => {}); fail(res, error.message === 'Duplicate capture blocked.' ? 409 : 502, error.message === 'Duplicate capture blocked.' ? error.message : 'Payment requires reconciliation; do not retry capture.'); }
});

app.post('/api/orders/:id/cancel', requireUser, async (req, res) => { const db = getAdminDb(); const orderRef = db.collection('users').doc(req.user.uid).collection('orders').doc(req.params.id); const order = await orderRef.get(); if (!order.exists) return fail(res, 404, 'Order not found for this account.'); if (order.data().status === 'RESERVED') await db.runTransaction(async (store) => { const current = await store.get(orderRef); if (!current.exists || current.data().status !== 'RESERVED') return; const data = current.data(); if (data.productSource === 'paypilot-marketplace') { const productRef = db.collection('marketplaceProducts').doc(data.productId); const product = await store.get(productRef); if (product.exists) store.update(productRef, { stock: product.data().stock + 1, updatedAt: new Date().toISOString() }); } store.update(orderRef, { status: 'CANCELLED', reservationReleased: true, cancelledAt: new Date().toISOString() }); }); res.json({ cancelled: true }); });

const dirname = path.dirname(fileURLToPath(import.meta.url)); const dist = path.resolve(dirname, '../dist');
app.use(express.static(dist));
app.get('*', (req, res, next) => req.path.startsWith('/api/') ? next() : res.sendFile(path.join(dist, 'index.html'), (error) => { if (error) res.status(404).send('Build the frontend with npm run build first.'); }));
app.listen(port, () => console.log(`PayPilot API listening on port ${port}`));
