const CATEGORY_PATTERNS = [
  ['Smartphones', /\b(?:smartphones?|phones?|iphones?)\b/i],
  ['Laptops', /\b(?:laptops?|notebooks?)\b/i],
  ['Headphones', /\b(?:headphones?|headsets?|earbuds?)\b/i],
  ['Smartwatches', /\b(?:smartwatches?|watches?)\b/i],
  ['Tablets', /\btablets?|ipads?\b/i],
];
const BRANDS = ['Apple', 'Samsung', 'Sony', 'Dell', 'Google', 'Bose', 'Microsoft', 'Lenovo', 'HP'];
const CURRENCY_SYMBOLS = { $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY' };
const INTENDED_USES = ['coding', 'gaming', 'travel', 'fitness', 'work', 'school', 'music', 'photography', 'video'];
const FEATURE_PATTERNS = [
  ['noise cancellation', /\bnoise[- ]cancell?ation\b/i],
  ['Bluetooth', /\bbluetooth\b/i],
  ['wireless', /\bwireless\b/i],
  ['GPS', /\bgps\b/i],
  ['waterproof', /\bwaterproof\b/i],
  ['5G', /\b5g\b/i],
  ['OLED', /\boled\b/i],
  ['touchscreen', /\btouchscreen\b/i],
  ['USB-C', /\busb[- ]c\b/i],
  ['long battery life', /\blong battery life\b/i],
];

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function normalizeText(value) {
  return String(value ?? '').toLocaleLowerCase().replace(/[^a-z0-9.]+/g, ' ').trim();
}

function valuesFromObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, item]) => [`${key} ${item}`, String(item)]);
}

export function extractShoppingRequirements(query) {
  const text = String(query || '').trim();
  const lower = text.toLowerCase();
  const category = CATEGORY_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] || null;
  const preferredBrand = BRANDS.find((candidate) => new RegExp(
    candidate === 'Apple' ? '\\b(?:apple|iphone)\\b' : `\\b${candidate}\\b`,
    'i',
  ).test(text)) || null;
  const budgetMatch = text.match(/(?:under|below|budget(?: of)?|less than|within|up to|max(?:imum)?(?: of)?)\s*([$€£¥])?\s*(\d[\d,]*(?:\.\d{1,2})?)/i)
    || text.match(/([$€£¥])\s*(\d[\d,]*(?:\.\d{1,2})?)/);
  const budget = budgetMatch ? Number(budgetMatch[2].replace(/,/g, '')) : null;
  const currencySymbol = Object.keys(CURRENCY_SYMBOLS).find((symbol) => text.includes(symbol));
  const currency = currencySymbol
    ? CURRENCY_SYMBOLS[currencySymbol]
    : text.match(/\b(?:USD|EUR|GBP|JPY|CAD|AUD)\b/i)?.[0].toUpperCase() || null;

  const requiredSpecifications = {};
  const memoryMatch = text.match(/\b(\d{1,3}\s*GB)\s*(?:of\s*)?(?:RAM|memory)\b/i);
  if (memoryMatch) requiredSpecifications.memory = memoryMatch[1].replace(/\s+/g, '').toUpperCase();
  const storageMatch = text.match(/\b(\d{1,4}\s*(?:GB|TB))\s*(?:of\s*)?(?:storage|SSD|HDD)\b/i);
  if (storageMatch) requiredSpecifications.storage = storageMatch[1].replace(/\s+/g, '').toUpperCase();
  const displayMatch = text.match(/\b(\d{1,2}(?:\.\d)?\s*(?:-| )?inch(?:es)?)\b/i);
  if (displayMatch) requiredSpecifications.display = displayMatch[1].replace(/\s+/g, '').toLowerCase();

  const foundFeatures = FEATURE_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([feature]) => feature);
  const optionalClause = lower.match(/\b(?:prefer(?:ably)?|ideally|optional(?:ly)?)\b[^.!?]*/)?.[0] || '';
  const optionalFeatures = foundFeatures.filter((feature) => optionalClause.includes(feature.toLowerCase()));
  const mustHaveFeatures = foundFeatures.filter((feature) => !optionalFeatures.includes(feature));
  const intendedUse = INTENDED_USES.filter((use) => new RegExp(`\\b${use}\\b`, 'i').test(text));

  return {
    category,
    budget: Number.isFinite(budget) && budget > 0 ? budget : null,
    currency,
    preferredBrand,
    intendedUse,
    requiredSpecifications,
    mustHaveFeatures,
    optionalFeatures,
  };
}

export function validateShoppingRequirements(candidate, query) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const deterministic = extractShoppingRequirements(query);
  const queryText = normalizeText(query);
  const isGrounded = (value) => typeof value === 'string'
    && normalizeText(value).split(' ').every((token) => !token || queryText.includes(token));

  const category = deterministic.category
    || CATEGORY_PATTERNS.find(([name]) => name === candidate.category && isGrounded(name))?.[0]
    || null;
  const candidateBudget = Number(candidate.budget);
  const queryAmounts = [...String(query).matchAll(/\d[\d,]*(?:\.\d{1,2})?/g)]
    .map(([value]) => Number(value.replace(/,/g, '')));
  const budget = deterministic.budget ?? (
    Number.isFinite(candidateBudget) && candidateBudget > 0 && queryAmounts.includes(candidateBudget)
      ? candidateBudget
      : null
  );
  const currency = deterministic.currency || (
    typeof candidate.currency === 'string' && /\b(?:USD|EUR|GBP|JPY|CAD|AUD)\b/i.test(query)
      ? candidate.currency.toUpperCase()
      : null
  );
  const preferredBrand = deterministic.preferredBrand || BRANDS.find((brand) => (
    brand.toLowerCase() === String(candidate.preferredBrand || '').toLowerCase() && isGrounded(brand)
  )) || null;
  const requiredSpecifications = { ...deterministic.requiredSpecifications };
  if (candidate.requiredSpecifications && typeof candidate.requiredSpecifications === 'object' && !Array.isArray(candidate.requiredSpecifications)) {
    for (const [key, value] of Object.entries(candidate.requiredSpecifications)) {
      if (typeof value === 'string' && isGrounded(key) && isGrounded(value)) requiredSpecifications[key.slice(0, 40)] = value.slice(0, 80);
    }
  }
  const normalizeList = (values, allowed) => unique(Array.isArray(values)
    ? values.filter((value) => typeof value === 'string'
      && allowed.some((item) => item.toLowerCase() === value.toLowerCase())
      && isGrounded(value))
    : []);
  const intendedUse = unique([...deterministic.intendedUse, ...normalizeList(candidate.intendedUse, INTENDED_USES)]);
  const mustHaveFeatures = unique([
    ...deterministic.mustHaveFeatures,
    ...normalizeList(candidate.mustHaveFeatures, FEATURE_PATTERNS.map(([feature]) => feature)),
  ]);
  const optionalFeatures = unique([
    ...deterministic.optionalFeatures,
    ...normalizeList(candidate.optionalFeatures, FEATURE_PATTERNS.map(([feature]) => feature)),
  ]).filter((feature) => !mustHaveFeatures.includes(feature));
  return { category, budget, currency, preferredBrand, intendedUse, requiredSpecifications, mustHaveFeatures, optionalFeatures };
}

function productEvidenceText(product) {
  return [product.title, product.brand, product.category, ...valuesFromObject(product.specifications)]
    .filter(Boolean)
    .join(' ');
}

function containsEvidence(product, requestedValue) {
  const evidence = normalizeText(productEvidenceText(product));
  const requested = normalizeText(requestedValue);
  return Boolean(requested) && evidence.includes(requested);
}

function specificationMatch(product, [key, value]) {
  const specifications = product.specifications && typeof product.specifications === 'object'
    ? product.specifications
    : {};
  const matchingSpec = Object.entries(specifications).some(([specKey, specValue]) => (
    normalizeText(specKey).includes(normalizeText(key))
      && normalizeText(specValue) === normalizeText(value)
  ));
  return matchingSpec || containsEvidence(product, value);
}

function createCriteria(product, requirements) {
  const criteria = [];
  const categoryMatches = !requirements.category
    || normalizeText(product.category) === normalizeText(requirements.category);
  if (requirements.category) criteria.push({ key: 'category', label: 'Category', weight: 10, score: categoryMatches ? 100 : 0 });

  let budgetMismatch = false;
  if (requirements.budget !== null) {
    budgetMismatch = Boolean((requirements.currency && product.currency !== requirements.currency)
      || product.price > requirements.budget);
    criteria.push({ key: 'budget', label: 'Budget', weight: 25, score: budgetMismatch ? 0 : 100 });
  }
  let brandMismatch = false;
  let brandUnknown = false;
  if (requirements.preferredBrand) {
    brandMismatch = Boolean(product.brand && normalizeText(product.brand) !== normalizeText(requirements.preferredBrand));
    brandUnknown = !product.brand;
    criteria.push({ key: 'brand', label: 'Brand', weight: 15, score: !brandMismatch && !brandUnknown ? 100 : 0 });
  }
  const specEntries = Object.entries(requirements.requiredSpecifications);
  const missingSpecifications = specEntries.filter((entry) => !specificationMatch(product, entry))
    .map(([key, value]) => `${key}: ${value}`);
  if (specEntries.length) {
    criteria.push({
      key: 'specifications',
      label: 'Required specifications',
      weight: 25,
      score: 100 * (specEntries.length - missingSpecifications.length) / specEntries.length,
    });
  }
  const matchingUse = requirements.intendedUse.filter((use) => containsEvidence(product, use));
  if (requirements.intendedUse.length) {
    criteria.push({ key: 'intendedUse', label: 'Intended use', weight: 15, score: 100 * matchingUse.length / requirements.intendedUse.length });
  }
  const missingFeatures = requirements.mustHaveFeatures.filter((feature) => !containsEvidence(product, feature));
  if (requirements.mustHaveFeatures.length) {
    criteria.push({
      key: 'mustHaveFeatures',
      label: 'Must-have features',
      weight: 15,
      score: 100 * (requirements.mustHaveFeatures.length - missingFeatures.length) / requirements.mustHaveFeatures.length,
    });
  }
  const matchingOptional = requirements.optionalFeatures.filter((feature) => containsEvidence(product, feature));
  if (requirements.optionalFeatures.length) {
    criteria.push({ key: 'optionalFeatures', label: 'Optional features', weight: 5, score: 100 * matchingOptional.length / requirements.optionalFeatures.length });
  }

  const totalWeight = criteria.reduce((sum, criterion) => sum + criterion.weight, 0);
  const score = totalWeight
    ? Math.round(criteria.reduce((sum, criterion) => sum + criterion.score * criterion.weight, 0) / totalWeight)
    : 0;
  const concerns = [];
  if (requirements.category && !categoryMatches) concerns.push(`Category is ${product.category}, not ${requirements.category}.`);
  if (budgetMismatch) {
    concerns.push(requirements.currency && product.currency !== requirements.currency
      ? `Price is listed in ${product.currency}; the requested budget currency is ${requirements.currency}.`
      : `Price ${product.price} ${product.currency} exceeds the budget of ${requirements.budget} ${requirements.currency || product.currency}.`);
  }
  if (brandMismatch) concerns.push(`Brand is ${product.brand}, not the preferred ${requirements.preferredBrand}.`);
  if (brandUnknown) concerns.push(`Brand is not provided, so the ${requirements.preferredBrand} preference cannot be confirmed.`);
  if (missingSpecifications.length) concerns.push(`Required specifications not confirmed: ${missingSpecifications.join(', ')}.`);
  if (missingFeatures.length) concerns.push(`Must-have features not confirmed: ${missingFeatures.join(', ')}.`);
  if (requirements.intendedUse.length && !matchingUse.length) concerns.push(`Product data does not confirm suitability for ${requirements.intendedUse.join(', ')}.`);
  if (requirements.optionalFeatures.length && !matchingOptional.length) concerns.push('No optional features were confirmed in the product data.');

  const satisfied = categoryMatches
    && !budgetMismatch
    && !brandMismatch
    && !brandUnknown
    && !missingSpecifications.length
    && !missingFeatures.length
    && (!requirements.intendedUse.length || matchingUse.length === requirements.intendedUse.length);
  const reasons = [];
  if (requirements.category && categoryMatches) reasons.push(`Category matches: ${product.category}.`);
  if (requirements.budget !== null && !budgetMismatch) reasons.push(`Price ${product.price} ${product.currency} is within the ${requirements.budget} ${requirements.currency || product.currency} budget.`);
  if (requirements.preferredBrand && !brandMismatch && !brandUnknown) reasons.push(`Brand matches: ${product.brand}.`);
  for (const [key, value] of specEntries.filter((entry) => specificationMatch(product, entry))) {
    reasons.push(`Product data lists ${key}: ${value}.`);
  }
  if (matchingUse.length) reasons.push(`Product data matches intended use: ${matchingUse.join(', ')}.`);
  if (requirements.mustHaveFeatures.length && !missingFeatures.length) reasons.push(`Product data confirms must-have features: ${requirements.mustHaveFeatures.join(', ')}.`);
  if (matchingOptional.length) reasons.push(`Product data confirms optional features: ${matchingOptional.join(', ')}.`);
  return {
    score: Math.max(0, Math.min(100, score)),
    criteria,
    satisfied,
    reasons,
    concerns,
    missingSpecifications,
    missingFeatures,
  };
}

function explainRecommendation(product, result) {
  const explanation = result.reasons.length
    ? result.reasons.join(' ')
    : `The product data lists ${product.title} in ${product.category} at ${product.price} ${product.currency}; no requested feature match was confirmed.`;
  return {
    ...product,
    recommendation: {
      score: result.score,
      criteria: result.criteria,
      satisfied: result.satisfied,
      reasons: result.reasons,
      explanation,
      explanationSource: 'rules',
      concerns: result.concerns,
      missingSpecifications: result.missingSpecifications,
      missingFeatures: result.missingFeatures,
      sourceType: product.dataType,
    },
  };
}

export function scoreProducts(products, requirements, { limit = 3 } = {}) {
  const ranked = (Array.isArray(products) ? products : [])
    .filter((product) => product && ['LIVE', 'DEMO'].includes(product.dataType))
    .map((product) => ({ product, result: createCriteria(product, requirements) }))
    .sort((left, right) => right.result.score - left.result.score
      || left.product.price - right.product.price
      || left.product.productId.localeCompare(right.product.productId));
  const satisfyingProducts = ranked.filter(({ result }) => result.satisfied);
  const alternatives = ranked.filter(({ result }) => !result.satisfied);
  const allRequirementsSatisfied = satisfyingProducts.length > 0;
  return {
    recommendations: allRequirementsSatisfied
      ? satisfyingProducts.slice(0, limit).map(({ product, result }) => explainRecommendation(product, result))
      : [],
    alternatives: allRequirementsSatisfied
      ? []
      : alternatives.slice(0, limit).map(({ product, result }) => explainRecommendation(product, result)),
    allRequirementsSatisfied,
    candidateCount: ranked.length,
  };
}

export function validateGeneratedExplanation(value, product, recommendation) {
  if (typeof value !== 'string' || value.length > 500) return null;
  const allowedStatements = [
    ...(recommendation.reasons || []),
    ...(recommendation.concerns || []),
    ...(typeof recommendation.explanation === 'string' ? [recommendation.explanation] : []),
  ].filter((statement) => typeof statement === 'string' && statement.trim());
  const normalized = (text) => text.toLowerCase().replace(/\s+/g, ' ').trim();
  const candidate = normalized(value);
  if (!candidate) return null;
  const exactEvidence = allowedStatements.some((statement) => normalized(statement) === candidate);
  return exactEvidence ? value.trim() : null;
}