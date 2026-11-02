import { demoProducts } from './demoProducts.js';
import { isOfferRelevantToQuery } from '../src/offerUtils.js';
import { deduplicateProducts, normalizeProduct, productSourceMatches } from './productModel.js';
import { searchExternalProducts } from './products.js';

const knownBrands = ['Apple', 'Samsung', 'Sony', 'Dell', 'Google', 'Bose', 'Microsoft', 'Lenovo', 'HP'];

function liveProduct(product) {
  const title = product.title || product.name;
  const brand = knownBrands.find((candidate) => new RegExp(
    candidate === 'Apple' ? '\\b(?:Apple|iPhone)\\b' : `\\b${candidate}\\b`,
    'i',
  ).test(title || '')) || null;
  const specifications = Array.isArray(product.localizedAspects)
    ? Object.fromEntries(product.localizedAspects
      .filter((aspect) => typeof aspect?.name === 'string' && typeof aspect?.value === 'string')
      .map((aspect) => [aspect.name, aspect.value]))
    : {};
  return normalizeProduct({
    ...product,
    productId: product.productId || product.id,
    title,
    brand,
    category: product.category || 'External offers',
    image: product.image,
    source: product.source || 'eBay Browse API',
    listingUrl: product.listingUrl || product.retailerUrl,
    availability: product.availability || product.availabilityStatus,
    dataType: 'LIVE',
    specifications,
  });
}

export function createProductService({
  liveSearch = searchExternalProducts,
  curatedProducts = demoProducts,
  logger = console,
} = {}) {
  return async function searchProducts(query) {
    let liveResult;
    let liveSearchFailed = false;
    try {
      liveResult = await liveSearch(query);
    } catch {
      liveSearchFailed = true;
      logger.warn?.('[product-service] Live search failed; returning matching demo products.');
    }
    const liveProducts = (Array.isArray(liveResult?.products) ? liveResult.products : [])
      .map(liveProduct)
      .filter((product) => product && productSourceMatches(product, 'LIVE'))
      .filter((product) => isOfferRelevantToQuery(product, query));
    const demoMatches = curatedProducts
      .map(normalizeProduct)
      .filter((product) => product && productSourceMatches(product, 'DEMO'))
      .filter((product) => isOfferRelevantToQuery(product, query));
    const products = deduplicateProducts([...liveProducts, ...demoMatches]);
    const demoOnly = liveProducts.length === 0;
    return {
      provider: 'hybrid-product-service',
      products,
      liveCount: liveProducts.length,
      demoCount: products.filter((product) => product.dataType === 'DEMO').length,
      liveSearchFailed,
      ...(demoOnly ? {
        message: liveSearchFailed
          ? 'Live eBay search failed. Any displayed products are clearly labeled sample data.'
          : liveResult?.provider === 'not-configured'
            ? 'Live retailer search is not configured. Showing clearly labeled sample products.'
            : 'No live offers matched this search. Showing clearly labeled sample products.',
      } : {}),
    };
  };
}

export const searchProducts = createProductService();
