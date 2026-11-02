import {
  extractShoppingRequirements,
  scoreProducts,
  validateGeneratedExplanation,
  validateShoppingRequirements,
} from './recommendations.js';

function parseJson(content) {
  if (typeof content !== 'string') return null;
  try {
    return JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/gi, '').trim());
  } catch {
    return null;
  }
}

function createGroqRequester({ env, fetchImpl, logger }) {
  return async function requestGroq(messages, maxTokens) {
    if (!env.GROQ_API_KEY) return null;
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
          max_tokens: maxTokens,
          messages,
        }),
      });
      if (!response.ok) {
        logger.warn?.(`[recommendations] Groq request failed (${response.status}); using deterministic fallback.`);
        return null;
      }
      const payload = await response.json();
      return payload.choices?.[0]?.message?.content || null;
    } catch (error) {
      logger.warn?.(`[recommendations] Groq request failed; using deterministic fallback: ${error.message}`);
      return null;
    }
  };
}

export function createRecommendationService({
  env = process.env,
  fetchImpl = globalThis.fetch,
  logger = console,
} = {}) {
  const requestGroq = createGroqRequester({ env, fetchImpl, logger });

  return async function recommendProducts(query, products, { limit = 3 } = {}) {
    const deterministicRequirements = extractShoppingRequirements(query);
    let requirements = deterministicRequirements;
    let requirementsSource = 'rules';
    const extractedContent = await requestGroq([
      {
        role: 'system',
        content: 'Extract only shopping requirements explicitly stated by the user. Return one JSON object with category, budget, currency, preferredBrand, intendedUse (array), requiredSpecifications (object), mustHaveFeatures (array), and optionalFeatures (array). Use null for unknown scalar values and empty arrays/objects when absent. Never infer unstated requirements.',
      },
      { role: 'user', content: String(query).slice(0, 1500) },
    ], 250);
    const extracted = parseJson(extractedContent);
    const validated = validateShoppingRequirements(extracted, query);
    if (validated) {
      requirements = validated;
      requirementsSource = 'groq';
    }

    const ranked = scoreProducts(products, requirements, { limit });
    const candidates = ranked.allRequirementsSatisfied ? ranked.recommendations : ranked.alternatives;
    let explanationSource = 'rules';
    const explanationProducts = candidates.map(({ productId, title, brand, category, price, currency, specifications, recommendation }) => ({
      productId,
      title,
      brand,
      category,
      price,
      currency,
      specifications,
      sourceType: recommendation.sourceType,
      factualExplanation: recommendation.explanation,
      concerns: recommendation.concerns,
    }));
    const generatedContent = explanationProducts.length
      ? await requestGroq([
        {
          role: 'system',
          content: 'For each product, return its factualExplanation verbatim as the natural-language explanation. Do not paraphrase, add claims, or change relationships between facts. Return JSON mapping each exact productId to its exact factualExplanation string. If it cannot be copied exactly, omit that productId.',
        },
        { role: 'user', content: JSON.stringify(explanationProducts) },
      ], 350)
      : null;
    const generated = parseJson(generatedContent);
    if (generated && typeof generated === 'object' && !Array.isArray(generated)) {
      for (const product of candidates) {
        const explanation = validateGeneratedExplanation(
          generated[product.productId],
          product,
          product.recommendation,
        );
        if (explanation) {
          product.recommendation.explanation = explanation;
          product.recommendation.explanationSource = 'groq';
          explanationSource = 'groq';
        }
      }
    }

    return {
      requirements,
      requirementsSource,
      recommendations: ranked.recommendations,
      alternatives: ranked.alternatives,
      allRequirementsSatisfied: ranked.allRequirementsSatisfied,
      candidateCount: ranked.candidateCount,
      explanationSource,
    };
  };
}

export const recommendProducts = createRecommendationService();
