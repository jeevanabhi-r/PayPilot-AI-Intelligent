# PayPilot AI — Hackathon submission brief

## Project description

PayPilot AI is an AI-assisted commerce application built around human-approved PayPal checkout. It helps users research verified retailer offers, compare options against a stated budget, retain wishlists, and complete eligible PayPilot marketplace purchases through a server-verified PayPal Sandbox order flow.

## Demo script

1. Sign in with Firebase email/password or Google.
2. Use **AI Agent** to research a product with an optional budget. Explain that the AI only receives provider-returned offer fields.
3. Use **Discover** to search the configured external provider, inspect source, availability, price, image, and retailer link.
4. Select two offers and open **Compare** to show verified budget deltas.
5. Save an offer to **Wishlist** and show it persists under the signed-in user.
6. Open **Checkout**, select a PayPilot marketplace product, grant explicit approval, and approve with a PayPal Sandbox buyer.
7. Show the verified transaction in **Orders** and the aggregate in **Analytics**.
8. Sign in as a Firebase custom-claim administrator, use **Admin** to add a stocked product, then return to **Checkout** to show the same product is available to customers.

## Sponsor evidence status

- PayPal: server-side order, capture, amount/currency/owner checks, transaction persistence, and stock update are implemented; Sandbox proof requires credentials.
- APIMatic: `openapi.yaml` documents the API but validation, generated portal, and SDK need APIMatic account access.
- Render: `render.yaml` defines a web service and health check; live deployment requires Render authorization.
