# Reactions and the weekly award

Everything runs in the existing web service and PostgreSQL database. No new production dependencies or services are needed. Two additive tables are created transactionally at startup: `confession_reactions` and `weekly_awards`.

## Rules

- Reactions are free and available on public paid and explicitly complimentary confessions, including older ones. Demos cannot receive reactions.
- One reaction per confession per anonymous browser cookie. Cookie clearing and different browsers can bypass this; this is deliberately not an identity-verified vote.
- Weeks run from Monday 00:00 to the next Monday 00:00 in Europe/London, including daylight-saving changes.
- Paid confessions compete only in the week they were submitted. Complimentary owner posts are excluded from awards. Reactions must also arrive within that week to count towards its award. Page counts include all-time reactions.
- An award requires at least two eligible confessions and three distinct reacting browser identifiers. Most reactions wins; ties use earliest confession creation time, then lowest ID.
- Signed payment webhooks remain the only way to publish a paid confession. Reactions never create or alter payments, pins or pin queue allocation.
- The first page visit after a week ends finalizes outstanding weeks. A small in-process cache reduces repeat checks; it resets across UK midnight. Missed weeks are processed on the next visit.
- Results, including weeks with no qualifying winner, are persisted permanently. Late reactions cannot change them. Hiding a winning confession removes its public feature and card without promoting a replacement.
- A winner's share image includes a badge and an award-specific URL parameter to request a fresh social preview. Query parameters never award a badge; the database result controls it.

## Anonymous browser cookie and abuse controls

`ds_reactor` is a random 32-byte token, set only after a requested reaction succeeds. It lasts one year, is HttpOnly, SameSite=Lax, Secure on HTTPS, and host-only. The database stores its SHA-256 hash, not the cookie value. There are no accounts, names, email addresses, or IP addresses in the reaction tables.

POST requests require the configured site's exact Origin. The app trusts one proxy hop (Render's final forwarding proxy) for short-lived network rate limits. Rate limits are 20 reaction requests per browser and 120 per network address per minute. Network addresses are salted and hashed in memory; buckets expire and are bounded. These controls discourage casual vote farming and are not a substitute for identity verification.

Reaction reads use no-store responses and never set a cookie. Public HTML and PNGs contain counts and badges, never browser identifiers or payment identifiers. Reaction and award writes share a transaction lock so a reaction timestamp cannot slip into an already finalized week.

## Validation

`npm test` runs payment/card regression checks and embedded PostgreSQL integration tests. PGlite is a development-only test dependency; it is never loaded by the production server. Browser checks cover the rendered controls, cookie persistence across pages, duplicate prevention, mobile layouts and the existing checkout return flow.

Production smoke checks should avoid creating fake confessions, winners or votes. Check GET state responses, invalid IDs, cross-site POST rejection, rules, existing card downloads and error logs. Do not seed a fake weekly winner in production.

## Complimentary owner confession

The domain-buying confession (#3, @chriscompiles) is published as a normal live confession, with its standard permalink, card and reactions. Startup sets `is_demo = FALSE` and `is_complimentary = TRUE` only for that exact existing demo; repeat startups preserve the conversion. This does not create a Checkout session, alter the original payment history, reset its date or change moderation visibility.

The public wall displays the standard $1 confession value and includes $1 for this post in the collective total, as requested by the owner. The totals query returns actual paid amounts and complimentary face values separately: complimentary entries add zero to paid revenue, irrespective of their historical test amount or currency. Any revenue query must exclude both `is_demo` and `is_complimentary` rows. The existing Stripe session is retained only as historical data and for webhook deduplication.
