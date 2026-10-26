require("dotenv").config();
const path = require("path");
const express = require("express");
const { Pool } = require("pg");
const Stripe = require("stripe");
const { cardPng } = require("./lib/cards");
const { socialMeta, renderConfession, renderConfirmation, WEB_ANALYTICS } = require("./lib/sharing");
const { createCommunity, SCHEMA: COMMUNITY_SCHEMA } = require("./lib/community");
const { reactionControl, awardBadge, weeklySection } = require("./lib/community-views");

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("render.com")
    ? { rejectUnauthorized: false }
    : false,
});

const POST_PRICE = 100;
const PIN_PRICE = 2500;
const PAYMENT_CURRENCY = "usd";
const MAX_BODY = 140;

const app = express();
app.set("trust proxy", 1);
const community = createCommunity(pool, PUBLIC_URL);

async function refreshCommunity() {
  try { await community.refreshAwards(); }
  catch (error) { console.error("Weekly award check failed:", error.message); }
}

function cleanText(value, max) {
  return String(value || "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function cleanHandle(value) {
  const raw = cleanText(value, 32).replace(/^@+/, "");
  if (!raw) return null;
  if (!/^[A-Za-z0-9_\.]+$/.test(raw)) return null;
  return raw;
}

function cleanLink(value) {
  const raw = cleanText(value, 200);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function money(amountMinor, currency = PAYMENT_CURRENCY) {
  return (amountMinor / 100).toLocaleString("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

function postAmount(row) {
  return row.is_demo ? money(POST_PRICE) : money(row.amount_pence, row.currency);
}

function pinTime(timestamp) {
  return new Date(timestamp).toLocaleString("en-GB", {
    timeZone: "UTC", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  }) + " UTC";
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const session = event.data.object;
    if (session.payment_status !== "paid") {
      return res.json({ received: true });
    }
    const body = cleanText(session.metadata && session.metadata.body, MAX_BODY);
    if (!body) {
      return res.json({ received: true });
    }
    const handle = cleanHandle(session.metadata && session.metadata.handle);
    const link = cleanLink(session.metadata && session.metadata.link);
    const pin = (session.metadata && session.metadata.pin) === "1";
    const amount = session.amount_total;
    const currency = session.currency;
    if (!Number.isInteger(amount) || amount <= 0 || !/^[a-z]{3}$/.test(currency || "")) {
      console.error("Paid checkout has invalid amount or currency:", session.id);
      return res.status(400).send("invalid payment details");
    }
    try {
      if (pin) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          // Serialize slot allocation, including simultaneous webhook deliveries.
          await client.query("SELECT pg_advisory_xact_lock(100138, 1)");
          await client.query(
            `WITH slot AS (
               SELECT GREATEST(clock_timestamp(), COALESCE(MAX(pinned_until), clock_timestamp())) AS starts_at
               FROM copes
             )
             INSERT INTO copes (body, handle, link, amount_pence, pinned_until, stripe_session, currency, pinned_from)
             SELECT $1, $2, $3, $4, starts_at + INTERVAL '1 hour', $5, $6, starts_at
             FROM slot ON CONFLICT (stripe_session) DO NOTHING`,
            [body, handle, link, amount, session.id, currency]
          );
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally {
          client.release();
        }
      } else {
        await pool.query(
          `INSERT INTO copes (body, handle, link, amount_pence, pinned_until, stripe_session, currency)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (stripe_session) DO NOTHING`,
          [body, handle, link, amount, null, session.id, currency]
        );
      }
    } catch (err) {
      console.error("Insert failed:", err);
      return res.status(500).send("db error");
    }
  }

  res.json({ received: true });
});

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PUBLIC_CONFESSION = "SELECT id, body, handle, link, amount_pence, currency, is_demo FROM copes WHERE id = $1 AND is_hidden = FALSE";
const CONFIRMED_CONFESSION = "SELECT id FROM copes WHERE stripe_session = $1 AND is_hidden = FALSE";

function confessionId(value) {
  if (!/^[1-9][0-9]{0,9}$/.test(value || "")) return null;
  const id = Number(value);
  return id <= 2147483647 ? id : null;
}

function checkoutSession(value) {
  return typeof value === "string" && /^cs_[A-Za-z0-9_]{8,200}$/.test(value) ? value : null;
}

function privateConfirmation(res) {
  res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" });
}

app.get("/api/reactions", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const raw = req.query.ids;
  if (typeof raw !== "string" || raw.length > 1100) return res.status(400).json({ error: "Invalid confession IDs." });
  const ids = [...new Set(raw.split(",").map(confessionId))];
  if (!ids.length || ids.length > 100 || ids.some((id) => !id)) return res.status(400).json({ error: "Invalid confession IDs." });
  try { return res.json(await community.reactionStates(ids, req)); }
  catch (error) { console.error("Could not load reactions:", error.message); return res.status(503).json({ error: "Reactions are temporarily unavailable." }); }
});

app.post("/api/confessions/:id/reaction", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const id = confessionId(req.params.id);
  if (!id) return res.status(404).json({ error: "Confession not found." });
  try { return await community.react(id, req, res); }
  catch (error) { console.error("Could not save reaction:", error.message); return res.status(503).json({ error: "Couldn’t save your reaction. Please try again." }); }
});

app.get("/checkout/success", async (req, res) => {
  privateConfirmation(res);
  const session = checkoutSession(req.query.session_id);
  if (!session) return res.status(400).send(renderConfirmation(false));
  try {
    // Only the signed payment webhook publishes confessions; a return URL is not proof of payment.
    const result = await pool.query(CONFIRMED_CONFESSION, [session]);
    if (result.rows[0]) return res.redirect(303, `/confessions/${result.rows[0].id}`);
    return res.status(202).send(renderConfirmation(true));
  } catch (error) {
    console.error("Could not confirm confession:", error.message);
    return res.status(503).send(renderConfirmation(true));
  }
});

app.get("/checkout/status", async (req, res) => {
  privateConfirmation(res);
  const session = checkoutSession(req.query.session_id);
  if (!session) return res.status(400).json({ error: "Invalid confirmation link" });
  try {
    const result = await pool.query(CONFIRMED_CONFESSION, [session]);
    if (result.rows[0]) return res.json({ url: `/confessions/${result.rows[0].id}` });
    return res.status(202).json({ state: "pending" });
  } catch (error) {
    console.error("Could not check confession:", error.message);
    return res.status(503).json({ state: "retry" });
  }
});

app.get("/confessions/:id/card.png", async (req, res) => {
  const id = confessionId(req.params.id);
  if (!id) return res.status(404).send("Confession not found.");
  try {
    const result = await pool.query(PUBLIC_CONFESSION, [id]);
    if (!result.rows[0]) return res.status(404).send("Confession not found.");
    await refreshCommunity();
    const [row] = await community.enrich(result.rows);
    const png = await cardPng(row);
    res.set({ "Content-Type": "image/png", "Cache-Control": "public, max-age=0, must-revalidate", "X-Content-Type-Options": "nosniff" });
    if (req.query.download === "1") res.set("Content-Disposition", `attachment; filename="didntship-confession-${id}.png"`);
    return res.send(png);
  } catch (error) {
    console.error("Could not render confession card:", error.message);
    res.set("Retry-After", "3");
    return res.status(503).send("Your card is temporarily unavailable. Please try again.");
  }
});

app.get("/confessions/:id", async (req, res) => {
  const id = confessionId(req.params.id);
  if (!id) return res.status(404).send("Confession not found.");
  try {
    const result = await pool.query(PUBLIC_CONFESSION, [id]);
    if (!result.rows[0]) return res.status(404).send("Confession not found.");
    await refreshCommunity();
    const [row] = await community.enrich(result.rows);
    res.set("Cache-Control", "public, max-age=0, must-revalidate");
    return res.send(renderConfession(row, PUBLIC_URL));
  } catch (error) {
    console.error("Could not load confession:", error.message);
    return res.status(503).send("This confession is temporarily unavailable. Please try again.");
  }
});

app.get("/share-card.png", async (_req, res) => {
  try {
    const png = await cardPng(null);
    res.set({ "Content-Type": "image/png", "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" });
    return res.send(png);
  } catch (error) {
    res.set("Retry-After", "3");
    return res.status(503).send("Card temporarily unavailable.");
  }
});

app.get("/", async (_req, res) => {
  try {
    const totals = await pool.query(
      `SELECT currency, SUM(amount_pence)::bigint AS total FROM copes
       WHERE is_demo = FALSE GROUP BY currency ORDER BY currency`
    );
    const pinned = await pool.query(
      `SELECT * FROM copes
       WHERE is_hidden = FALSE AND pinned_from <= NOW() AND pinned_until > NOW()
       ORDER BY pinned_from ASC, id ASC
       LIMIT 1`
    );
    const queue = await pool.query(
      "SELECT MAX(pinned_until) AS next_pin_at FROM copes WHERE pinned_until > NOW()"
    );
    const feed = await pool.query(
      `SELECT * FROM copes
       WHERE is_hidden = FALSE
       ORDER BY created_at DESC
       LIMIT 100`
    );
    await refreshCommunity();
    const rows = await community.enrich(feed.rows);
    const winner = await community.latestAward();
    res.set("Cache-Control", "public, max-age=0, must-revalidate");
    res.send(renderPage(totals.rows, pinned.rows[0], rows, queue.rows[0].next_pin_at, winner));
  } catch (err) {
    console.error(err);
    res.status(500).send("Database is not ready yet. Check DATABASE_URL.");
  }
});

app.post("/checkout", async (req, res) => {
  const body = cleanText(req.body.body, MAX_BODY);
  const handle = cleanHandle(req.body.handle);
  const link = cleanLink(req.body.link);
  const pin = req.body.pin === "1" || req.body.pin === "on";

  if (!body) {
    return res.status(400).send("Write the thing you didn’t ship.");
  }

  const amount = pin ? PIN_PRICE : POST_PRICE;
  const label = pin ? "Pinned admission (1 full hour; queued if busy)" : "Public admission";

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      success_url: `${PUBLIC_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${PUBLIC_URL}/?cancel=1`,
      managed_payments: { enabled: false },
      metadata: {
        body,
        handle: handle || "",
        link: link || "",
        pin: pin ? "1" : "0",
        currency: PAYMENT_CURRENCY,
      },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: PAYMENT_CURRENCY,
            unit_amount: amount,
            product_data: {
              name: label,
              description: body,
            },
          },
        },
      ],
    });
    res.redirect(303, session.url);
  } catch (err) {
    console.error(err);
    res.status(500).send("Stripe could not start checkout. Check STRIPE_SECRET_KEY.");
  }
});

function renderPage(totals, pinned, rows, nextPinAt, winner) {
  const usdTotal = Number(totals.find((total) => total.currency === PAYMENT_CURRENCY)?.total || 0);
  const otherTotals = totals
    .filter((total) => total.currency !== PAYMENT_CURRENCY)
    .map((total) => money(Number(total.total), total.currency));
  const earlierPayments = otherTotals.length
    ? `<p class="site-note">Earlier purchases in other currencies: ${otherTotals.join(" · ")}. Counted separately.</p>`
    : "";
  const demoNotice = rows.some((row) => row.is_demo)
    ? `<p class="empty">Demo posts are examples and are not included in the paid total.</p>`
    : "";
  const pinQueueNote = nextPinAt && new Date(nextPinAt) > new Date()
    ? `The queue currently ends ${pinTime(nextPinAt)}. Your full hour follows earlier pins.`
    : "Your full hour starts after successful payment. Pins queue when the spotlight is busy.";
  const items = rows
    .map((row) => {
      const handle = row.handle
        ? `<span class="handle">@${escapeHtml(row.handle)}</span>`
        : "";
      const link = row.link
        ? `<a class="link" href="${escapeHtml(row.link)}" rel="nofollow noopener" target="_blank">link <span aria-hidden="true">↗</span></a>`
        : "";
      const livePin =
        row.pinned_until && new Date(row.pinned_until) > new Date()
          ? `<span class="badge">${row.pinned_from && new Date(row.pinned_from) > new Date() ? "queued · " + pinTime(row.pinned_from) : "pinned"}</span>`
          : "";
      return `<li class="feed-item">
        <article class="admission">
          ${awardBadge(row)}
          <p class="admission-body">${escapeHtml(row.body)}</p>
          <div class="meta">
            <div class="meta-person">${handle} ${link}</div>
            <div class="meta-receipt">${row.is_demo ? '<span class="badge">demo</span>' : ""} ${livePin} <span class="amount">${postAmount(row)}</span></div>
          </div>
          ${reactionControl(row)}
          <a class="confession-share" href="/confessions/${row.id}">Share this confession <span aria-hidden="true">↗</span></a>
        </article>
      </li>`;
    })
    .join("");

  const pinnedBlock = pinned
    ? `<section class="pinned" aria-labelledby="pinned-title">
        <header class="pinned-header">
          <p class="eyebrow">Currently pinned</p>
          <span class="badge badge-inverse">top of the wall</span>
        </header>
        <h2 id="pinned-title">${escapeHtml(pinned.body)}</h2>
        <div class="meta pinned-meta">
          <div class="meta-person">
            ${pinned.handle ? `<span class="handle">@${escapeHtml(pinned.handle)}</span>` : ""}
            ${pinned.link ? `<a class="link" href="${escapeHtml(pinned.link)}" rel="nofollow noopener" target="_blank">link <span aria-hidden="true">↗</span></a>` : ""}
          </div>
          <span class="amount">${postAmount(pinned)}</span>
          <span>Until ${pinTime(pinned.pinned_until)}</span>
        </div>
      </section>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>didntship.lol</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' fill='%23c93622'/><path d='M24 22h26c19 0 30 10 30 28S69 78 50 78H24zm25 42c9 0 14-5 14-14s-5-14-14-14h-8v28z' fill='%23fff'/></svg>">
  <meta name="description" content="Your side project made $0. At least make it famous. Confess your unfinished project for $1 and get a shareable card.">
  ${socialMeta({ title: "Your side project made $0. At least make it famous.", description: "One line. Your excuse. A $1 confession and a shareable card for your unfinished side project.", url: PUBLIC_URL + "/", image: PUBLIC_URL + "/share-card.png?v=1", alt: "Your side project made $0. At least make it famous. didntship.lol" })}
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <a class="skip-link" href="#main-content">Skip to content</a>
  <header class="site-header">
    <a class="brand" href="/" aria-label="didntship.lol home">didntship<span>.lol</span></a>
    <p class="site-note">At least make it famous.</p>
  </header>
  <main id="main-content">
    <section class="hero hero-hook" aria-labelledby="page-title">
      <p class="eyebrow hero-eyebrow">For the projects that never made it</p>
      <h1 id="page-title" class="hook-title">Your side project made $0.<span class="hook-payoff">At least make it famous.</span></h1>
      <div class="hero-copy">
        <p class="lede">One line. Your excuse. $1.<br>A place on the wall and a card worth sharing.</p>
        <p class="hero-aside">The perfect domain. The fifth rewrite. The idea you’ll definitely get back to. We’ve all got one.</p>
      </div>
      <a class="action-link action-primary hero-cta" href="#submit-title">Make your confession · $1 <span aria-hidden="true">↗</span></a>
      <p class="collective-total"><span class="total">${money(usdTotal)}</span> collectively spent on admitting it.</p>
      ${earlierPayments}
    </section>
    ${pinnedBlock}
    ${weeklySection(winner)}
    <section class="submit-section" aria-labelledby="submit-title">
      <div class="section-intro">
        <p class="eyebrow">Your turn</p>
        <h2 id="submit-title">Put it in writing.</h2>
        <p>${money(POST_PRICE)} buys a permanent confession and your own shareable card. Honesty is included.</p>
        <p>Prices in US dollars.</p>
      </div>
      <form method="post" action="/checkout">
        <label class="field field-body">
          <span class="label-text">The reason it didn’t ship</span>
          <span class="label-hint">140 characters, maximum damage</span>
          <textarea name="body" maxlength="140" required placeholder="Waiting on the perfect domain."></textarea>
        </label>
        <div class="row">
          <label class="field">
            <span class="label-text">X handle <span class="optional">optional</span></span>
            <input name="handle" maxlength="32" placeholder="yourname">
          </label>
          <label class="field">
            <span class="label-text">Link <span class="optional">optional</span></span>
            <input name="link" maxlength="200" placeholder="https://">
          </label>
        </div>
        <div class="form-action">
          <label class="check">
            <input type="checkbox" name="pin" value="1">
            <span><strong>Buy the spotlight</strong>Pin this to the top for 1 full hour (${money(PIN_PRICE)} total)<br><small>${pinQueueNote}</small></span>
          </label>
          <button type="submit"><span>Admit it</span><span id="checkout-price">${money(POST_PRICE)}</span></button>
        </div>
      </form>
    </section>
    <section class="wall" aria-labelledby="wall-title">
      <header class="wall-header">
        <div>
          <p class="eyebrow">Freshly unshipped</p>
          <h2 id="wall-title">The wall</h2>
        </div>
        <p>Most recent first. Regret lasts forever.</p>
      </header>
      <ol class="feed">${items || "<li class='empty'>Nobody has admitted it yet.</li>"}</ol>
      ${demoNotice}
      <noscript><p class="reaction-note">Enable JavaScript to react to confessions. Reading and sharing still work without it.</p></noscript>
    </section>
    <footer><span>No accounts. No deletes.</span> <strong>This is the receipt.</strong></footer>
  </main>
  <script>
    const pinOption = document.querySelector('input[name="pin"]');
    const checkoutPrice = document.getElementById('checkout-price');
    function updateCheckoutPrice() {
      checkoutPrice.textContent = pinOption.checked ? ${JSON.stringify(money(PIN_PRICE))} : ${JSON.stringify(money(POST_PRICE))};
    }
    pinOption.addEventListener('change', updateCheckoutPrice);
    updateCheckoutPrice();
  </script>
  <script src="/reactions.js" defer></script>
  ${WEB_ANALYTICS}
</body>
</html>`;
}

async function ensureSchema() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
    CREATE TABLE IF NOT EXISTS copes (
      id SERIAL PRIMARY KEY,
      body TEXT NOT NULL,
      handle TEXT,
      link TEXT,
      amount_pence INTEGER NOT NULL,
      pinned_until TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      stripe_session TEXT UNIQUE
    );
    `);
    await client.query(`
      ALTER TABLE copes ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'gbp';
      ALTER TABLE copes ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE copes ADD COLUMN IF NOT EXISTS pinned_from TIMESTAMPTZ;
      ALTER TABLE copes ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN NOT NULL DEFAULT FALSE;
    `);
    await client.query(`
      UPDATE copes SET pinned_from = pinned_until - INTERVAL '1 hour'
      WHERE pinned_until IS NOT NULL AND pinned_from IS NULL;
    `);
    await client.query(
      `UPDATE copes SET is_demo = TRUE
       WHERE (id = $1 AND body = $2 AND handle = $3)
          OR (id = $4 AND body = $5 AND handle = $6)`,
      [3, "Spent the morning buying a domain instead of shipping the actual product", "chriscompiles",
       4, "Too many Linux distros", "coderama"]
    );
    await client.query(
      "UPDATE copes SET is_hidden = TRUE WHERE id = $1 AND body = $2 AND handle = $3",
      [4, "Too many Linux distros", "coderama"]
    );
    await client.query(COMMUNITY_SCHEMA);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

ensureSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`didntship.lol running on ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Could not start database:", err);
    process.exit(1);
  });

