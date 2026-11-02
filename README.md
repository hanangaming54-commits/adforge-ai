# AdForge AI — Real Business Website Starter

This is a deployable full-stack starter, not a static mockup.

## Included
- Public landing page
- User signup/login
- Password hashing + JWT sessions
- First free ad credit
- AI ad-concept generation through a server-side OpenAI API key
- User dashboard and saved ads
- Owner/Admin account with unlimited generation
- Owner stats and user list
- Stripe Checkout integration point for paid subscriptions
- SQLite database for a simple initial deployment
- Rate limiting and server-side secrets

## Run
1. Install Node.js 18+.
2. Copy `.env.example` to `.env`.
3. Set a strong `JWT_SECRET`.
4. Set `ADMIN_EMAIL` and `ADMIN_PASSWORD`.
5. Optional: set `OPENAI_API_KEY` for live AI generation.
6. Optional: set `STRIPE_SECRET_KEY` and `STRIPE_PRICE_ID` for payments.
7. Run:
   npm install
   npm start
8. Open http://localhost:3000

## Important
This project does not pretend to have real payment/AI credentials. Add your own provider keys on the server before launching publicly. Never put secret API keys into browser JavaScript.

For a production launch, use HTTPS, a managed database/backups, a real domain, Stripe webhooks for subscription status, email verification/password reset, and production logging/monitoring.
