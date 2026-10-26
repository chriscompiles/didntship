# Visitor analytics

Cloudflare Web Analytics is installed on the homepage and public confession pages using the site's public beacon token. The snippet is shared from `lib/sharing.js` and loads as a module without blocking the page.

Private checkout confirmation pages deliberately omit analytics so Stripe session identifiers in their URLs are not reported. JSON APIs and PNG cards do not include a tracker.

The domain currently uses Cloudflare DNS and routes directly to Render. View visitor data under Cloudflare **Web Analytics** for `didntship.lol`; Cloudflare's proxy traffic dashboard is separate. No DNS or proxy change is needed for this installation.

To verify, open the public homepage and a confession in a browser without an analytics blocker. Confirm that `beacon.min.js` loads and its POST to `https://cloudflareinsights.com/cdn-cgi/rum` succeeds. Cloudflare says dashboard data may take a few minutes to appear. Tracking starts with installation and cannot backfill earlier visits.
