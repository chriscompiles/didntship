require("dotenv").config();
const path = require("path");
const express = require("express");
const { Pool } = require("pg");
const Stripe = require("stripe");

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("render.com")
    ? { rejectUnauthorized: false }
    : false,
});

const POST_PRICE = 300;
const PIN_PRICE = 2500;
const MAX_BODY = 140;

const app = express();

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

function pounds(pence) {
  return (pence / 100).toLocaleString("en-GB", {
    style: "currency",
    currency: "GBP",
  });
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

  if (event.type === "checkout.session.completed") {
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
    const amount = session.amount_total || (pin ? PIN_PRICE : POST_PRICE);
    const pinnedUntil = pin ? new Date(Date.now() + 60 * 60 * 1000).toISOString() : null;

    try {
      await pool.query(
        `INSERT INTO copes (body, handle, link, amount_pence, pinned_until, stripe_session)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (stripe_session) DO NOTHING`,
        [body, handle, link, amount, pinnedUntil, session.id]
      );
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

app.get("/", async (_req, res) => {
  try {
    const total = await pool.query("SELECT COALESCE(SUM(amount_pence), 0)::int AS total FROM copes");
    const pinned = await pool.query(
      `SELECT * FROM copes
       WHERE pinned_until IS NOT NULL AND pinned_until > NOW()
       ORDER BY pinned_until DESC
       LIMIT 1`
    );
    const feed = await pool.query(
      `SELECT * FROM copes
       ORDER BY created_at DESC
       LIMIT 100`
    );
    res.send(renderPage(total.rows[0].total, pinned.rows[0], feed.rows));
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
  const label = pin ? "Pinned admission (1 hour)" : "Public admission";

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      success_url: `${PUBLIC_URL}/?paid=1`,
      cancel_url: `${PUBLIC_URL}/?cancel=1`,
      managed_payments: { enabled: false },
      metadata: {
        body,
        handle: handle || "",
        link: link || "",
        pin: pin ? "1" : "0",
      },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "gbp",
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

function renderPage(totalPence, pinned, rows) {
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
          ? `<span class="badge">pinned</span>`
          : "";
      return `<li class="feed-item">
        <article class="admission">
          <p class="admission-body">${escapeHtml(row.body)}</p>
          <div class="meta">
            <div class="meta-person">${handle} ${link}</div>
            <div class="meta-receipt">${livePin} <span class="amount">${pounds(row.amount_pence)}</span></div>
          </div>
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
          <span class="amount">${pounds(pinned.amount_pence)}</span>
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
  <meta name="description" content="People pay to admit they didn’t ship.">
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <a class="skip-link" href="#main-content">Skip to content</a>
  <header class="site-header">
    <a class="brand" href="/" aria-label="didntship.lol home">didntship<span>.lol</span></a>
    <p class="site-note">The public ledger of almost</p>
  </header>
  <main id="main-content">
    <section class="hero" aria-labelledby="page-title">
      <p class="eyebrow hero-eyebrow">Collectively wasted so far</p>
      <h1 id="page-title"><span class="total">${pounds(totalPence)}</span> <span class="hero-line">spent on not shipping</span></h1>
      <div class="hero-copy">
        <p class="lede">People pay to admit they didn’t ship. One line. No edits. No refunds.</p>
        <p class="hero-aside">Because your abandoned side project deserves at least one paying customer.</p>
      </div>
    </section>
    ${pinnedBlock}
    <section class="submit-section" aria-labelledby="submit-title">
      <div class="section-intro">
        <p class="eyebrow">Your turn</p>
        <h2 id="submit-title">Put it in writing.</h2>
        <p>£3 buys permanence. Honesty is included.</p>
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
            <span><strong>Buy the spotlight</strong>Pin this to the top for 1 hour (£25)</span>
          </label>
          <button type="submit"><span>Admit it</span><span>£3</span></button>
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
    </section>
    <footer><span>No accounts. No deletes.</span> <strong>This is the receipt.</strong></footer>
  </main>
</body>
</html>`;
}

async function ensureSchema() {
  await pool.query(`
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
