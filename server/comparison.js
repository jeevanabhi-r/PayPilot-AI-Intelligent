import { scoreProducts, extractShoppingRequirements } from './recommendations.js';
import { normalizeProduct } from './productModel.js';

function availableSpecifications(product) {
  const specifications = product.specifications && typeof product.specifications === 'object'
    ? product.specifications
    : {};
  return Object.entries(specifications)
    .filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '')
    .map(([key, value]) => [key, String(value)]);
}

function safePriceDifference(left, right) {
  if (left.currency !== right.currency) {
    return { leftProductId: left.productId, rightProductId: right.productId, difference: null, currency: null };
  }
  return {
    leftProductId: left.productId,
    rightProductId: right.productId,
    difference: Number((left.price - right.price).toFixed(2)),
    currency: left.currency,
  };
}

function rankScoredProducts(products, requirements) {
  return products.map((product) => {
    const scored = scoreProducts([product], requirements);
    const result = scored.recommendations[0] || scored.alternatives[0];
    return {
      ...product,
      recommendation: result?.recommendation || null,
      specificationCount: availableSpecifications(product).length,
    };
  });
}

function buildEvidenceStatements(products, priceDifferences, winners, specificationBasis) {
  const statements = [];
  for (const pair of priceDifferences) {
    if (pair.difference === null) continue;
    const left = products.find((product) => product.productId === pair.leftProductId);
    const right = products.find((product) => product.productId === pair.rightProductId);
    if (pair.difference === 0) {
      statements.push(`${left.title} and ${right.title} have the same listed price: ${left.price} ${pair.currency}.`);
    } else {
      const cheaper = pair.difference < 0 ? left : right;
      const moreExpensive = pair.difference < 0 ? right : left;
      statements.push(`${cheaper.title} is ${Math.abs(pair.difference)} ${pair.currency} less than ${moreExpensive.title}.`);
    }
  }

  const sortedBySpecifications = [...products].sort((a, b) => b.specificationCount - a.specificationCount);
  if (sortedBySpecifications.length > 1 && sortedBySpecifications[0].specificationCount !== sortedBySpecifications.at(-1).specificationCount) {
    statements.push(`${sortedBySpecifications[0].title} has ${sortedBySpecifications[0].specificationCount} listed specifications; ${sortedBySpecifications.at(-1).title} has ${sortedBySpecifications.at(-1).specificationCount}. This compares data coverage, not product quality.`);
  }
  const sourceTypes = new Set(products.map((product) => product.dataType));
  if (sourceTypes.size > 1) {
    statements.push('LIVE items are retrieved provider listings; DEMO items are sample catalogue data, not live retailer listings.');
  }
  if (winners.bestOverall) {
    statements.push(`${winners.bestOverall.title} has the highest deterministic requirement-match score among the selected products (${winners.bestOverall.recommendation.score}/100).`);
  }
  if (winners.bestSpecification) {
    statements.push(specificationBasis === 'requiredSpecifications'
      ? `${winners.bestSpecification.title} has the strongest specification match based on the stated requirements and available specification data.`
      : `${winners.bestSpecification.title} has the most listed specification fields (${winners.bestSpecification.specificationCount}); this reflects data coverage, not product quality.`);
  }
  if (winners.bestBudget) {
    statements.push(`${winners.bestBudget.title} has the lowest listed price among selected products in ${winners.bestBudget.currency}.`);
  }
  return [...new Set(statements)];
}

function validateGroqStatements(candidate, allowedStatements) {
  if (!Array.isArray(candidate)) return [];
  return [...new Set(candidate.filter((statement) => (
    typeof statement === 'string'
      && statement.length <= 500
      && allowedStatements.includes(statement)
  )))];
}

export function buildProductComparison(inputProducts, query = '') {
  const products = (Array.isArray(inputProducts) ? inputProducts : [])
    .slice(0, 3)
    .map(normalizeProduct)
    .filter(Boolean);
  const requirements = extractShoppingRequirements(query);
  const rankedProducts = rankScoredProducts(products, requirements);
  const scoredCandidates = rankedProducts.filter((product) => product.recommendation);
  const bestOverall = [...scoredCandidates].sort((a, b) => (
    b.recommendation.score - a.recommendation.score
    || a.price - b.price
    || a.productId.localeCompare(b.productId)
  ))[0] || null;

  const currencies = [...new Set(products.map((product) => product.currency))];
  const bestBudget = currencies.length === 1
    ? [...products].sort((a, b) => a.price - b.price || a.productId.localeCompare(b.productId))[0] || null
    : null;
  const requiredSpecificationCount = Object.keys(requirements.requiredSpecifications).length;
  const bestSpecification = [...rankedProducts].sort((a, b) => {
    const scoreA = a.recommendation?.criteria.find((criterion) => criterion.key === 'specifications')?.score
      ?? (requiredSpecificationCount ? 0 : a.specificationCount);
    const scoreB = b.recommendation?.criteria.find((criterion) => criterion.key === 'specifications')?.score
      ?? (requiredSpecificationCount ? 0 : b.specificationCount);
    return scoreB - scoreA || b.specificationCount - a.specificationCount || a.productId.localeCompare(b.productId);
  })[0] || null;
  const specificationBasis = requiredSpecificationCount ? 'requiredSpecifications' : 'availableSpecificationFields';

  const priceDifferences = [];
  for (let leftIndex = 0; leftIndex < products.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < products.length; rightIndex += 1) {
      priceDifferences.push(safePriceDifference(products[leftIndex], products[rightIndex]));
    }
  }
  const specifications = [...new Set([
    ...rankedProducts.flatMap((product) => availableSpecifications(product).map(([key]) => key)),
    ...Object.keys(requirements.requiredSpecifications),
  ])]
    .sort((left, right) => left.localeCompare(right))
    .map((key) => ({
      name: key,
      values: rankedProducts.map((product) => {
        const found = availableSpecifications(product).find(([specKey]) => specKey.toLowerCase() === key.toLowerCase());
        return {
          productId: product.productId,
          value: found?.[1] || 'Not available',
          available: Boolean(found),
        };
      }),
    }));

  const winners = {
    bestOverall: bestOverall?.productId || null,
    bestBudget: bestBudget?.productId || null,
    bestSpecification: bestSpecification?.productId || null,
    specificationBasis,
    noProductsWithinBudget: requirements.budget !== null
      ? !products.some((product) => product.currency === (requirements.currency || product.currency) && product.price <= requirements.budget)
      : false,
    budgetNote: currencies.length > 1
      ? 'Prices use different currencies; no cross-currency budget winner or price difference is calculated.'
      : null,
  };
  const productResults = rankedProducts.map((product) => ({
    ...product,
    isBestOverall: winners.bestOverall === product.productId,
    isBestBudget: winners.bestBudget === product.productId,
    isBestSpecification: winners.bestSpecification === product.productId,
  }));
  const evidenceStatements = buildEvidenceStatements(rankedProducts, priceDifferences, {
    bestOverall: rankedProducts.find((product) => product.productId === winners.bestOverall),
    bestBudget,
    bestSpecification,
  }, specificationBasis);

  return {
    products: productResults,
    requirements,
    specifications,
    priceDifferences,
    winners,
    evidenceStatements,
    explanation: evidenceStatements.join(' '),
    explanationSource: 'rules',
  };
}

export function createComparisonService({ env = process.env, fetchImpl = globalThis.fetch, logger = console } = {}) {
  return async function compareProducts(inputProducts, query = '') {
    const comparison = buildProductComparison(inputProducts, query);
    if (!env.GROQ_API_KEY || !comparison.evidenceStatements.length) return comparison;

    try {
      const response = await fetchImpl('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: env.GROQ_MODEL || 'llama-3.3-70b-versatile',
          temperature: 0,
          max_tokens: 300,
          messages: [
            {
              role: 'system',
              content: 'Select and order the most useful comparison explanations from the supplied evidenceStatements. Return only JSON {"statements":[]} where each array item is copied exactly from evidenceStatements. Do not paraphrase or add facts.',
            },
            { role: 'user', content: JSON.stringify({ evidenceStatements: comparison.evidenceStatements }) },
          ],
        }),
      });
      if (!response.ok) {
        logger.warn?.(`[comparison] Groq request failed (${response.status}); using deterministic summary.`);
        return comparison;
      }
      const payload = await response.json();
      const content = payload.choices?.[0]?.message?.content;
      const generated = typeof content === 'string' ? JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/gi, '').trim()) : null;
      const statements = validateGroqStatements(generated?.statements, comparison.evidenceStatements);
      if (statements.length) {
        comparison.explanation = statements.join(' ');
        comparison.explanationSource = 'groq';
      }
      return comparison;
    } catch (error) {
      logger.warn?.(`[comparison] Groq request failed; using deterministic summary: ${error.message}`);
      return comparison;
    }
  };
}

export const compareProductSelection = createComparisonService();
