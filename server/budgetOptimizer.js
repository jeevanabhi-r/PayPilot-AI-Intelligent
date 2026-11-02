import { buildProductComparison } from './comparison.js';
import { deduplicateProducts, normalizeProduct } from './productModel.js';
import { extractShoppingRequirements, scoreProducts } from './recommendations.js';

export const BUDGET_CATEGORIES = ['Smartphones', 'Laptops', 'Headphones', 'Smartwatches', 'Tablets'];

function cents(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100);
}

function categoryName(value) {
  return BUDGET_CATEGORIES.find((category) => category.toLowerCase() === String(value).trim().toLowerCase()) || null;
}

function sortProducts(left, right) {
  return right.recommendation.score - left.recommendation.score
    || cents(left.price) - cents(right.price)
    || left.productId.localeCompare(right.productId);
}

function productRecommendation(product, category, budget, currency, preferences) {
  const parsed = extractShoppingRequirements(`${preferences.intendedUse} ${preferences.priorities}`);
  const requirements = {
    ...parsed,
    category: categoryName(product.category) ? category : null,
    budget,
    currency,
    preferredBrand: null,
  };
  const scored = scoreProducts([product], requirements);
  const candidate = scored.recommendations[0] || scored.alternatives[0];
  return {
    ...product,
    requestedCategory: category,
    recommendation: candidate?.recommendation || null,
  };
}

function combinationMetrics(products, categoryCount, budgetCents, preferredBrands, hasSpecificationRequirements) {
  const categoryCoverage = categoryCount ? products.length / categoryCount * 100 : 0;
  const recommendationScore = products.length
    ? products.reduce((sum, product) => sum + (product.recommendation?.score || 0), 0) / products.length
    : 0;
  const budgetUtilization = budgetCents > 0
    ? products.reduce((sum, product) => sum + cents(product.price), 0) / budgetCents * 100
    : 0;
  const specificationScores = products.flatMap((product) => (
    product.recommendation?.criteria
      .filter((criterion) => ['specifications', 'mustHaveFeatures'].includes(criterion.key))
      .map((criterion) => criterion.score) || []
  ));
  const specificationSuitability = hasSpecificationRequirements
    ? specificationScores.length
      ? specificationScores.reduce((sum, score) => sum + score, 0) / specificationScores.length
      : 0
    : 100;
  const brandPreference = preferredBrands.length
    ? products.length
      ? products.filter((product) => preferredBrands.some((brand) => (
        product.brand?.toLowerCase() === brand.toLowerCase()
      ))).length / products.length * 100
      : 0
    : 100;
  const score = Math.round(
    categoryCoverage * 0.4
    + recommendationScore * 0.3
    + Math.min(100, budgetUtilization) * 0.1
    + specificationSuitability * 0.1
    + brandPreference * 0.1,
  );
  return {
    score,
    categoryCoverage: Math.round(categoryCoverage),
    recommendationScore: Math.round(recommendationScore),
    budgetUtilization: Math.round(Math.min(100, budgetUtilization)),
    specificationSuitability: Math.round(specificationSuitability),
    brandPreference: Math.round(brandPreference),
  };
}

function scoreCombination(products, requestedCategories, budgetCents, preferredBrands, requirements) {
  const totalCents = products.reduce((sum, product) => sum + cents(product.price), 0);
  const metrics = combinationMetrics(
    products,
    requestedCategories.length,
    budgetCents,
    preferredBrands,
    Object.keys(requirements.requiredSpecifications).length > 0 || requirements.mustHaveFeatures.length > 0,
  );
  return {
    products,
    totalCost: totalCents / 100,
    remainingBudget: (budgetCents - totalCents) / 100,
    score: metrics.score,
    metrics,
  };
}

function combinationOrder(left, right) {
  return right.metrics.categoryCoverage - left.metrics.categoryCoverage
    || right.score - left.score
    || right.metrics.recommendationScore - left.metrics.recommendationScore
    || left.totalCost - right.totalCost
    || left.products.map((product) => product.productId).join('|').localeCompare(
      right.products.map((product) => product.productId).join('|'),
    );
}

function combinationExplanation(combination, requestedCategories, missingCategories, currency) {
  const parts = combination
    ? [`The recommended combination covers ${combination.products.length} of ${requestedCategories.length} requested categories and totals ${combination.totalCost.toFixed(2)} ${currency}, leaving ${combination.remainingBudget.toFixed(2)} ${currency}.`]
    : ['No product combination could be created from the available catalogue data.'];
  if (missingCategories.length) {
    parts.push(missingCategories.map(({ category, reason }) => `${category}: ${reason}`).join(' '));
  }
  if (combination?.products.some((product) => product.dataType === 'DEMO')) {
    parts.push('DEMO prices are sample catalogue values, not verified market prices or live retailer offers.');
  }
  if (combination?.products.some((product) => product.dataType === 'LIVE')) {
    parts.push('LIVE prices came from provider listings and may change; confirm the listing before purchase.');
  }
  return parts.join(' ');
}

export function optimizeBudget({
  products: inputProducts = [],
  budget: inputBudget,
  currency: inputCurrency,
  categories: inputCategories = [],
  preferredBrands: inputBrands = [],
  intendedUse = '',
  priorities = '',
} = {}) {
  const budget = Number(inputBudget);
  const currency = typeof inputCurrency === 'string' ? inputCurrency.trim().toUpperCase() : '';
  const budgetCents = Number.isFinite(budget) && budget > 0 ? Math.floor(budget * 100 + Number.EPSILON) : 0;
  const requestedCategories = [...new Set((Array.isArray(inputCategories) ? inputCategories : []).map(categoryName).filter(Boolean))];
  const preferredBrands = [...new Set((Array.isArray(inputBrands) ? inputBrands : [])
    .filter((brand) => typeof brand === 'string')
    .map((brand) => brand.trim())
    .filter(Boolean))];
  const preferences = {
    intendedUse: typeof intendedUse === 'string' ? intendedUse.trim() : '',
    priorities: typeof priorities === 'string' ? priorities.trim() : '',
  };
  const requirements = extractShoppingRequirements(`${preferences.intendedUse} ${preferences.priorities}`);
  const categoryByProductId = new Map();
  const normalizedProducts = (Array.isArray(inputProducts) ? inputProducts : [])
    .map((input) => {
      const product = normalizeProduct(input);
      if (product && !categoryByProductId.has(product.productId)) {
        categoryByProductId.set(product.productId, categoryName(input.requestedCategory) || categoryName(product.category));
      }
      return product;
    })
    .filter(Boolean);
  const products = deduplicateProducts(normalizedProducts);
  const inRequestedCurrency = products.filter((product) => product.currency === currency);
  const candidatesByCategory = new Map(requestedCategories.map((category) => [category, []]));
  for (const product of inRequestedCurrency) {
    const category = categoryByProductId.get(product.productId) || categoryName(product.category);
    if (!category || !candidatesByCategory.has(category) || cents(product.price) > budgetCents) continue;
    candidatesByCategory.get(category).push(productRecommendation(
      product,
      category,
      budget,
      currency,
      preferences,
    ));
  }
  for (const category of requestedCategories) {
    candidatesByCategory.set(category, candidatesByCategory.get(category).sort(sortProducts));
  }

  const combinations = [];
  function enumerate(categoryIndex, chosen, totalCents) {
    if (categoryIndex === requestedCategories.length) {
      if (chosen.length) {
        combinations.push(scoreCombination(
          chosen,
          requestedCategories,
          budgetCents,
          preferredBrands,
          requirements,
        ));
        combinations.sort(combinationOrder);
        if (combinations.length > 4) combinations.pop();
      }
      return;
    }
    enumerate(categoryIndex + 1, chosen, totalCents);
    const category = requestedCategories[categoryIndex];
    for (const product of candidatesByCategory.get(category)) {
      const priceCents = cents(product.price);
      if (totalCents + priceCents > budgetCents) continue;
      enumerate(categoryIndex + 1, [...chosen, product], totalCents + priceCents);
    }
  }
  enumerate(0, [], 0);
  combinations.sort(combinationOrder);
  const recommendedCombination = combinations[0] || null;
  const alternatives = combinations.slice(1, 4);
  const missingCategories = requestedCategories
    .filter((category) => !recommendedCombination?.products.some((product) => categoryName(product.category) === category))
    .map((category) => {
      const categoryProducts = products.filter((product) => (
        (categoryByProductId.get(product.productId) || categoryName(product.category)) === category
      ));
      const currencyProducts = categoryProducts.filter((product) => product.currency === currency);
      if (!categoryProducts.length) return { category, reason: 'No product was found in the available catalogue.' };
      if (!currencyProducts.length) {
        const availableCurrencies = [...new Set(categoryProducts.map((product) => product.currency))].join(', ');
        return {
          category,
          reason: `No product was available in ${currency}; listings in ${availableCurrencies} were excluded because no currency conversion source was provided.`,
        };
      }
      if (!currencyProducts.some((product) => cents(product.price) <= budgetCents)) {
        return { category, reason: `No ${currency} product in this category fits within the total budget by itself.` };
      }
      return { category, reason: 'No distinct product in this category could be added alongside the selected products without exceeding the total budget.' };
    });
  const comparison = recommendedCombination
    ? buildProductComparison(recommendedCombination.products, `${preferences.intendedUse} ${preferences.priorities}`)
    : buildProductComparison([]);
  const resultCombination = (combination) => combination && ({
    ...combination,
    productPrices: combination.products.map((product) => ({
      productId: product.productId,
      title: product.title,
      price: product.price,
      currency: product.currency,
      dataType: product.dataType,
      source: product.source,
    })),
  });
  const result = resultCombination(recommendedCombination);
  return {
    budget: budgetCents / 100,
    currency,
    requestedCategories,
    recommendedCombination: result,
    totalCost: result?.totalCost || 0,
    remainingBudget: result?.remainingBudget ?? budgetCents / 100,
    alternatives: alternatives.map(resultCombination),
    missingCategories,
    candidateCount: products.length,
    comparison: {
      specifications: comparison.specifications,
      priceDifferences: comparison.priceDifferences,
    },
    explanation: combinationExplanation(result, requestedCategories, missingCategories, currency),
    explanationSource: 'rules',
    disclaimer: 'Combination totals use only products priced in the requested currency. DEMO products and prices are sample catalogue data, not verified market offers.',
  };
}
