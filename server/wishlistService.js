import { isValidLiveListingUrl } from './productModel.js';

const LIVE_SOURCE = 'eBay Browse API';
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export function createWishlistService({ searchProducts, now = () => new Date() }) {
  async function saveVerifiedLiveProduct(db, uid, input) {
    const productId = typeof input?.productId === 'string' ? input.productId.trim() : '';
    const query = typeof input?.query === 'string' ? input.query.trim() : '';
    if (!productId || productId.length > 200 || query.length < 2 || query.length > 120) {
      throw new TypeError('Provide a valid product ID and search query.');
    }

    const result = await searchProducts(query);
    const product = (Array.isArray(result?.products) ? result.products : []).find((candidate) => (
      candidate?.dataType === 'LIVE'
      && candidate.productId === productId
      && candidate.source === LIVE_SOURCE
      && isValidLiveListingUrl(candidate.listingUrl || candidate.retailerUrl)
      && Number.isFinite(candidate.price)
      && candidate.price > 0
      && candidate.price <= 1_000_000
      && CURRENCY_PATTERN.test(candidate.currency)
    ));
    if (!product) return { found: false };

    const listingUrl = product.listingUrl || product.retailerUrl;
    const item = {
      productId: product.productId,
      dataType: 'LIVE',
      title: product.title,
      name: product.title,
      brand: product.brand || null,
      category: product.category,
      price: product.price,
      currency: product.currency,
      image: product.image || null,
      source: LIVE_SOURCE,
      listingUrl,
      retailerUrl: listingUrl,
      availability: product.availability || 'Details unavailable',
      external: true,
      merchant: product.merchant || null,
      condition: product.condition || null,
      createdAt: now().toISOString(),
    };
    const saved = await db.collection('users').doc(uid).collection('wishlist').add(item);
    return { found: true, id: saved.id, item };
  }

  return { saveVerifiedLiveProduct };
}
