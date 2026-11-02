# PayPilot AI

> Current source status is maintained in `docs/IMPLEMENTATION-STATUS.md`. Follow `README-SETUP.md` for credential setup; no secret is stored in this repository.

AI-assisted shopping and payment workflow prototype for the PayPal + AI hackathon.

## Requirements
- Node.js 20 or newer
- PayPal Developer Sandbox account (optional for demo mode)
- Groq API key (optional for AI features)

## Setup
1. Extract this project and open the folder in VS Code.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy `.env.example` to `.env` and fill in credentials you want to use. Never expose secret keys in frontend code or commit `.env`.
4. Start the app:
   ```bash
   npm run dev
   ```
5. Open the local URL printed by Vite (usually `http://localhost:5173`).

## Notes
- Use PayPal Sandbox credentials only while testing.
- Treat AI output as suggestions, not authorization. Review the amount and recipient before any payment action.
- Verify payment status server-side with PayPal; never trust the browser alone.
- This is an MVP and must be tested locally, configured with your credentials, and deployed before hackathon submission.

## Technology
React, Vite, Express, PayPal Sandbox API, and optional Groq AI integration.

## Product data sources
- Discover and shopping research use a unified product model with explicit `LIVE` and `DEMO` data types.
- `LIVE` products are validated eBay Browse API results and retain their verified eBay listing URL.
- `DEMO` products come from the curated sample catalogue. They are labeled as sample data and never have a retailer listing URL or seller.
- If live eBay search returns no matches, matching demo products remain available for demonstrations; they are not represented as live offers.
- If live eBay search fails, discovery still returns matching demo products and clearly reports that live search was unavailable.

## Explainable recommendations
- The AI Agent and Discover rank the unified `LIVE` and `DEMO` product records with the same deterministic, 0–100 scoring engine.
- Scoring considers stated category, budget and currency, preferred brand, required specifications, intended use, must-have features, and optional features. Budget currency must match; no currency conversion is inferred.
- Recommendations include the matched criteria and any unconfirmed requirements. If none satisfy every stated requirement, the results are presented as alternatives with their concerns.
- Groq can extract and format requirements and explanations, but unsupported requirements are discarded and generated explanations are accepted only when they exactly match scorer-verified text. Deterministic recommendations remain available when Groq is unavailable.

## Intelligent budget optimization
- Discover and the AI Agent share a deterministic basket optimizer that searches requested categories through the hybrid product service and reuses the recommendation scorer.
- It selects at most one product per requested category, first maximizes the number of requested categories that fit, then ranks equally covered baskets by a weighted score: category coverage (40%), recommendation match (30%), budget utilization (10%), specification suitability (10%), and preferred-brand match (10%). It returns up to three alternatives when available.
- Totals include products only in the requested currency; no conversion is performed. LIVE and DEMO labels are preserved, and any DEMO price is explicitly identified as sample data rather than a verified market offer.
- Product specifications and fallback explanations are based only on returned product fields. The optimizer does not require Groq to produce a result.

## Price intelligence
- Wishlist price history is written only when a matching, validated LIVE listing is returned by a provider refresh. Saved sample products never produce live snapshots or alerts.
- History is scoped to the signed-in Firebase UID in Firestore. Price targets are managed through authenticated server endpoints and must use the saved product currency; currencies are not converted.
- Price-drop and target-match notifications are created from observed LIVE price changes with deterministic event IDs to avoid duplicates.
- Historical minimum/maximum and percentage changes are shown only when at least two same-source, same-currency provider observations are available. No history is fabricated from saved prices.
- The project does not configure background price monitoring. Wishlist refresh and discovery update history only when a matching provider refresh occurs; the UI states this limitation explicitly.
