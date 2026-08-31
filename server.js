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
        ? `<a class="link" href="${escapeHtml(row.link)}" rel="nofollow noopener" target="_blank">link</a>`
        : "";
      const livePin =
        row.pinned_until && new Date(row.pinned_until) > new Date()
          ? `<span class="badge">pinned</span>`
          : "";
      return `<li>
        <p>${escapeHtml(row.body)}</p>
        <div class="meta">${handle} ${link} ${livePin} <span>${pounds(row.amount_pence)}</span></div>
      </li>`;
    })
    .join("");

  const pinnedBlock = pinned
    ? `<section class="pinned">
        <div class="eyebrow">Currently pinned</div>
        <p>${escapeHtml(pinned.body)}</p>
        <div class="meta">${pinned.handle ? "@" + escapeHtml(pinned.handle) : ""} ${pounds(pinned.amount_pence)}</div>
      </section>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>didntship.lol</title>
  <meta name="description" content="People pay to admit they didn’t ship.">
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <main>
    <p class="brand">didntship.lol</p>
    <h1>${pounds(totalPence)} <span>spent on not shipping</span></h1>
    <p class="lede">People pay to admit they didn’t ship. One line. No edits. No refunds.</p>
    ${pinnedBlock}
    <form method="post" action="/checkout">
      <label>The reason it didn’t ship
        <textarea name="body" maxlength="140" required placeholder="Waiting on the perfect domain."></textarea>
      </label>
      <div class="row">
        <label>X handle (optional)
          <input name="handle" maxlength="32" placeholder="yourname">
        </label>
        <label>Link (optional)
          <input name="link" maxlength="200" placeholder="https://">
        </label>
      </div>
      <label class="check">
        <input type="checkbox" name="pin" value="1">
        Pin this to the top for 1 hour (£25)
      </label>
      <button type="submit">Admit it — £3</button>
    </form>
    <ol class="feed">${items || "<li class='empty'>Nobody has admitted it yet.</li>"}</ol>
    <footer>No accounts. No deletes. This is the receipt.</footer>
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
