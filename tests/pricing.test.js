const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const demos = [
  { id: 3, body: "Spent the morning buying a domain instead of shipping the actual product", handle: "chriscompiles", amount_pence: 300, stripe_session: "cs_demo_one", is_demo: true },
  { id: 4, body: "Too many Linux distros", handle: "coderama", amount_pence: 300, stripe_session: "cs_demo_two", is_demo: true },
];

async function harness(initialRows = [], failMigration = false, failPinnedInsert = false) {
  const rows = structuredClone(initialRows);
  let clock = Date.parse("2026-10-12T12:00:00Z");
  let lockTail = Promise.resolve();
  let failNextPin = failPinnedInsert;
  class ReviewDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  const routes = new Map();
  const checkoutCalls = [];
  const migrationCalls = [];
  const readCalls = [];
  let failRead = false;
  let released = false;
  let started = false;
  let exitCode = null;
  const app = {
    set() {},
    post(route, ...handlers) { routes.set("POST " + route, handlers.at(-1)); },
    get(route, ...handlers) { routes.set("GET " + route, handlers.at(-1)); },
    use() {},
    listen() { started = true; },
  };
  function express() { return app; }
  for (const name of ["raw", "json", "urlencoded", "static"]) express[name] = () => () => {};
  class Pool {
    async connect() {
      let unlock;
      return {
        async query(sql, parameters) {
          migrationCalls.push({ sql, parameters });
          if (failMigration && sql.includes("ALTER TABLE")) throw new Error("migration failed");
          if (sql.includes("pg_advisory_xact_lock")) {
            const previous = lockTail;
            lockTail = new Promise((resolve) => { unlock = resolve; });
            await previous;
          }
          if (sql.includes("ADD COLUMN IF NOT EXISTS currency")) {
            for (const row of rows) {
              row.currency ??= "gbp";
              row.is_demo ??= false;
              row.is_complimentary ??= false;
              row.pinned_from ??= null;
              row.is_hidden ??= false;
            }
          }
          if (sql.includes("SET pinned_from = pinned_until")) {
            for (const row of rows) {
              if (row.pinned_until && !row.pinned_from) row.pinned_from = new Date(Date.parse(row.pinned_until) - 3600000).toISOString();
            }
          }
          if (sql.startsWith("UPDATE copes SET is_demo = FALSE, is_complimentary = TRUE")) {
            for (const row of rows) {
              if (row.id === parameters[0] && row.body === parameters[1] && row.handle === parameters[2] && (row.is_demo || row.is_complimentary)) {
                row.is_demo = false;
                row.is_complimentary = true;
              }
            }
          } else if (sql.startsWith("UPDATE copes SET is_demo")) {
            for (const row of rows) {
              for (const offset of [0, 3]) {
                if (row.id === parameters[offset] && row.body === parameters[offset + 1] && row.handle === parameters[offset + 2]) row.is_demo = true;
              }
            }
          }
          if (sql.startsWith("UPDATE copes SET is_hidden")) {
            for (const row of rows) {
              if (row.id === parameters[0] && row.body === parameters[1] && row.handle === parameters[2]) row.is_hidden = true;
            }
          }
          if (sql.includes("WITH slot AS")) {
            assert(unlock, "Pinned writes must hold the allocation lock");
            assert.match(sql, /starts_at \+ INTERVAL '1 hour'/);
            if (failNextPin) { failNextPin = false; throw new Error("pinned insert failed"); }
            if (!rows.some((row) => row.stripe_session === parameters[4])) {
              const startsAt = Math.max(clock, ...rows.filter((row) => row.pinned_until && Date.parse(row.pinned_until) > clock).map((row) => Date.parse(row.pinned_until)));
              await new Promise(setImmediate);
              rows.push({ id: Math.max(0, ...rows.map((row) => row.id || 0)) + 1, body: parameters[0], handle: parameters[1], link: parameters[2], amount_pence: parameters[3], stripe_session: parameters[4], currency: parameters[5], pinned_from: new Date(startsAt).toISOString(), pinned_until: new Date(startsAt + 3600000).toISOString(), is_demo: false });
            }
          }
          if ((sql === "COMMIT" || sql === "ROLLBACK") && unlock) { unlock(); unlock = null; }
          return { rows: [] };
        },
        release() { if (unlock) unlock(); released = true; },
      };
    }
    async query(sql, parameters) {
      if (sql.startsWith("INSERT INTO copes")) {
        assert.match(sql, /ON CONFLICT \(stripe_session\) DO NOTHING/);
        if (!rows.some((row) => row.stripe_session === parameters[5])) {
          rows.push({ id: Math.max(0, ...rows.map((row) => row.id || 0)) + 1, body: parameters[0], handle: parameters[1], link: parameters[2], amount_pence: parameters[3], pinned_until: parameters[4], stripe_session: parameters[5], currency: parameters[6], is_demo: false });
        }
        return { rows: [] };
      }
      if (sql.includes("AS complimentary_total")) {
        assert.match(sql, /SUM\(CASE WHEN is_complimentary THEN 0 ELSE amount_pence END\)/);
        assert.match(sql, /WHERE is_demo = FALSE/);
        const totals = new Map();
        for (const row of rows.filter((row) => !row.is_demo)) {
          const currency = row.is_complimentary ? parameters[0] : row.currency;
          const total = totals.get(currency) || { currency, total: 0, complimentary_total: 0 };
          total.total += row.is_complimentary ? 0 : row.amount_pence;
          total.complimentary_total += row.is_complimentary ? parameters[1] : 0;
          totals.set(currency, total);
        }
        return { rows: [...totals.values()] };
      }
      if (sql.includes("MAX(pinned_until)")) {
        const ends = rows.filter((row) => row.pinned_until && Date.parse(row.pinned_until) > clock).map((row) => Date.parse(row.pinned_until));
        return { rows: [{ next_pin_at: ends.length ? new Date(Math.max(...ends)).toISOString() : null }] };
      }
      if (sql.includes("pinned_from <= NOW()")) {
        assert.match(sql, /ORDER BY pinned_from ASC, id ASC/);
        return { rows: rows.filter((row) => !row.is_hidden && row.pinned_from && Date.parse(row.pinned_from) <= clock && Date.parse(row.pinned_until) > clock).sort((a, b) => Date.parse(a.pinned_from) - Date.parse(b.pinned_from) || a.id - b.id).slice(0, 1) };
      }
      if (sql.includes("ORDER BY created_at DESC")) {
        assert.match(sql, /WHERE is_hidden = FALSE/);
        return { rows: rows.filter((row) => !row.is_hidden).reverse() };
      }
      if (sql.includes("WHERE id = $1 AND is_hidden = FALSE")) {
        readCalls.push({ sql, parameters });
        if (failRead) throw new Error("database unavailable");
        assert(!sql.includes("stripe_session"));
        const row = rows.find((row) => row.id === parameters[0] && !row.is_hidden);
        return { rows: row ? [Object.fromEntries(["id", "body", "handle", "link", "amount_pence", "currency", "is_demo", "is_complimentary"].map((key) => [key, row[key]]))] : [] };
      }
      if (sql.includes("WHERE stripe_session = $1 AND is_hidden = FALSE")) {
        readCalls.push({ sql, parameters });
        if (failRead) throw new Error("database unavailable");
        const row = rows.find((row) => row.stripe_session === parameters[0] && !row.is_hidden);
        return { rows: row ? [{ id: row.id }] : [] };
      }
      throw new Error("Unexpected query: " + sql);
    }
  }
  class Stripe {
    constructor() {
      this.webhooks = {
        constructEvent(body, signature) {
          if (signature !== "valid-test-signature") throw new Error("invalid signature");
          return body;
        },
      };
      this.checkout = { sessions: { async create(options) { checkoutCalls.push(options); return { url: "https://example.invalid/checkout" }; } } };
    }
  }
  const context = {
    require(name) {
      if (name === "dotenv") return { config() {} };
      if (name === "express") return express;
      if (name === "pg") return { Pool };
      if (name === "stripe") return Stripe;
      if (name === "path") return path;
      if (name === "./lib/cards") return require("../lib/cards");
      if (name === "./lib/sharing") return require("../lib/sharing");
      if (name === "./lib/community-views") return require("../lib/community-views");
      if (name === "./lib/owner-confession") return require("../lib/owner-confession");
      if (name === "./lib/community") return { SCHEMA: require("../lib/community").SCHEMA, createCommunity: () => ({
        async refreshAwards() {}, async enrich(rows) { return rows; }, async latestAward() { return null; },
      }) };
      throw new Error("Unexpected dependency: " + name);
    },
    process: { env: { PORT: "3000", PUBLIC_URL: "https://example.invalid", STRIPE_SECRET_KEY: "mock", STRIPE_WEBHOOK_SECRET: "mock" }, exit(code) { exitCode = code; } },
    console: { log() {}, error() {} },
    URL,
    Date: ReviewDate,
    __dirname: path.join(__dirname, ".."),
  };
  vm.runInNewContext(source, context);
  await new Promise(setImmediate);
  function response() {
    return { code: 200, headers: {}, set(name, value) { if (typeof name === "object") Object.assign(this.headers, name); else this.headers[name] = value; return this; }, status(code) { this.code = code; return this; }, send(body) { this.body = body; return this; }, json(body) { this.body = body; return this; }, redirect(code, url) { this.code = code; this.url = url; return this; } };
  }
  return {
    rows, checkoutCalls, migrationCalls, context, readCalls,
    failReads() { failRead = true; },
    async get(route, request = {}) {
      const res = response();
      await routes.get("GET " + route)({ params: {}, query: {}, ...request }, res);
      return res;
    },
    get released() { return released; },
    get started() { return started; },
    get exitCode() { return exitCode; },
    advance(milliseconds) { clock += milliseconds; },
    async checkout(pin = "", body = "A new admission") {
      const res = response();
      await routes.get("POST /checkout")({ body: { body, pin } }, res);
      return res;
    },
    async webhook(type, session, signature = "valid-test-signature") {
      const res = response();
      await routes.get("POST /webhook")({ headers: { "stripe-signature": signature }, body: { type, data: { object: session } } }, res);
      return res;
    },
    async page() {
      const res = response();
      await routes.get("GET /")({}, res);
      assert.equal(res.code, 200);
      return res.body;
    },
  };
}

function paid(id, currency = "usd", amount = 100, status = "paid") {
  return { id, currency, amount_total: amount, payment_status: status, metadata: { body: "Paid admission", pin: "0" } };
}

test("ordinary checkout charges exactly USD 1", async () => {
  const h = await harness();
  const res = await h.checkout();
  assert.equal(res.code, 303);
  const price = h.checkoutCalls[0].line_items[0].price_data;
  assert.equal(price.currency, "usd");
  assert.equal(price.unit_amount, 100);
});

test("pinned checkout charges USD 25 total", async () => {
  const h = await harness();
  await h.checkout("1");
  const price = h.checkoutCalls[0].line_items[0].price_data;
  assert.equal(price.currency, "usd");
  assert.equal(price.unit_amount, 2500);
});

test("blank posts cannot create checkout sessions", async () => {
  const h = await harness();
  assert.equal((await h.checkout("", "   ")).code, 400);
  assert.equal(h.checkoutCalls.length, 0);
});

test("migration publishes the owner's demo as complimentary and preserves payment history", async () => {
  const other = { id: 5, body: "A real purchase", handle: "someone", amount_pence: 300, stripe_session: "cs_other" };
  const h = await harness([...demos, other]);
  assert.deepEqual(h.rows.map((row) => row.is_demo), [false, true, false]);
  assert.deepEqual(h.rows.map((row) => row.is_complimentary), [true, false, false]);
  assert.deepEqual(h.rows.map((row) => row.amount_pence), [300, 300, 300]);
  assert.deepEqual(h.rows.map((row) => row.currency), ["gbp", "gbp", "gbp"]);
  assert.deepEqual(h.rows.map((row) => row.stripe_session), ["cs_demo_one", "cs_demo_two", "cs_other"]);
  assert.equal(h.migrationCalls.at(-1).sql, "COMMIT");
  assert(h.released && h.started);
});

test("migration rolls back and prevents startup on failure", async () => {
  const h = await harness([], true);
  assert.equal(h.migrationCalls.at(-1).sql, "ROLLBACK");
  assert(h.released);
  assert.equal(h.started, false);
  assert.equal(h.exitCode, 1);
});

test("the owner's live post contributes USD 1 to the public total without demo language", async () => {
  const h = await harness(demos);
  const html = await h.page();
  assert.match(html, /class="total">\$1<\/span>/);
  assert.equal((html.match(/class="badge">demo<\/span>/g) || []).length, 0);
  assert.equal((html.match(/class="amount">\$1<\/span>/g) || []).length, 1);
  assert(!html.includes("Demo posts are examples"));
  assert(!html.includes("Example confession"));
  assert.match(html, /data-react-id="3"/);
  assert.match(html, /href="\/confessions\/3"/);
  assert(!html.includes("£3"));
});

test("the Linux demo is removed from the public wall without deleting its payment record", async () => {
  const h = await harness(demos);
  const html = await h.page();
  assert(!html.includes("Too many Linux distros"));
  assert(html.includes("Spent the morning buying a domain"));
  assert.equal(h.rows.length, 2);
  assert.equal(h.rows[1].is_hidden, true);
  assert.equal(h.rows[1].amount_pence, 300);
  assert.equal(h.rows[1].stripe_session, "cs_demo_two");
});

test("the price button responds to selecting and deselecting a pin", async () => {
  const h = await harness();
  const html = await h.page();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  let listener;
  const pin = { checked: false, addEventListener(type, callback) { assert.equal(type, "change"); listener = callback; } };
  const price = {};
  vm.runInNewContext(script, { document: { querySelector() { return pin; }, getElementById() { return price; } } });
  assert.equal(price.textContent, "$1");
  pin.checked = true; listener(); assert.equal(price.textContent, "$25");
  pin.checked = false; listener(); assert.equal(price.textContent, "$1");
});

test("new USD payments and older GBP payments retain their own currency and separate totals", async () => {
  const h = await harness(demos);
  await h.webhook("checkout.session.completed", paid("cs_usd"));
  await h.webhook("checkout.session.completed", paid("cs_gbp", "gbp", 300));
  assert.equal(h.rows[2].currency, "usd");
  assert.equal(h.rows[3].currency, "gbp");
  const html = await h.page();
  assert.match(html, /class="total">\$2<\/span>/);
  assert.match(html, /Earlier purchases in other currencies: £3/);
});

test("replayed webhook deliveries do not duplicate posts or inflate the total", async () => {
  const h = await harness(demos);
  await h.webhook("checkout.session.completed", paid("cs_repeat"));
  await h.webhook("checkout.session.completed", paid("cs_repeat"));
  assert.equal(h.rows.length, 3);
  assert.match(await h.page(), /class="total">\$2<\/span>/);
});

test("the converted owner confession has the normal permalink, social preview and downloadable card", async () => {
  const h = await harness(demos);
  const page = await h.get("/confessions/:id", { params: { id: "3" } });
  assert.equal(page.code, 200);
  assert.match(page.body, /Confession #0003/);
  assert.match(page.body, /card.png\?v=2/);
  assert(!page.body.includes("Example confession"));
  assert.match(page.body, /Share on X/);
  assert.match(page.body, /data-url="https:\/\/example.invalid\/confessions\/3"/);
  assert.match(page.body, /href="\/confessions\/3\/card.png\?download=1"/);
  const { cardSvg } = require("../lib/cards");
  const svg = cardSvg(h.rows[0]);
  assert.match(svg, /CONFESSION #0003/);
  assert(!svg.includes("EXAMPLE CONFESSION"));
  const png = await h.get("/confessions/:id/card.png", { params: { id: "3" }, query: { download: "1" } });
  assert.equal(png.code, 200);
  assert.equal(png.body.readUInt32BE(16), 1200);
  assert.equal(png.body.readUInt32BE(20), 630);
  assert.equal(h.checkoutCalls.length, 0);
});

test("unpaid checkouts remain unpublished until a delayed success arrives", async () => {
  const h = await harness();
  await h.webhook("checkout.session.completed", paid("cs_delayed", "usd", 100, "unpaid"));
  assert.equal(h.rows.length, 0);
  await h.webhook("checkout.session.async_payment_succeeded", paid("cs_delayed"));
  assert.equal(h.rows.length, 1);
});

test("invalid signatures and missing payment amounts cannot publish posts", async () => {
  const h = await harness();
  assert.equal((await h.webhook("checkout.session.completed", paid("cs_invalid"), "bad")).code, 400);
  const malformed = paid("cs_missing"); delete malformed.amount_total;
  assert.equal((await h.webhook("checkout.session.completed", malformed)).code, 400);
  assert.equal(h.rows.length, 0);
});

function pinned(id) {
  const session = paid(id, "usd", 2500);
  session.metadata.body = id;
  session.metadata.pin = "1";
  return session;
}

test("later pin buyers cannot displace an earlier buyer before their hour ends", async () => {
  const h = await harness();
  await h.webhook("checkout.session.completed", pinned("Pin A"));
  h.advance(10 * 60000);
  await h.webhook("checkout.session.completed", pinned("Pin B"));
  assert.equal(h.rows[1].pinned_from, h.rows[0].pinned_until);
  assert.equal(Date.parse(h.rows[1].pinned_until) - Date.parse(h.rows[1].pinned_from), 3600000);
  let html = await h.page();
  assert.match(html, /id="pinned-title">Pin A<\/h2>/);
  assert.match(html, /queued · 12 Oct, 13:00 UTC/);
  h.advance(50 * 60000);
  html = await h.page();
  assert.match(html, /id="pinned-title">Pin B<\/h2>/);
});

test("simultaneous pin purchases receive separate consecutive hours", async () => {
  const h = await harness();
  const results = await Promise.all([
    h.webhook("checkout.session.completed", pinned("Concurrent A")),
    h.webhook("checkout.session.completed", pinned("Concurrent B")),
  ]);
  assert(results.every((result) => result.code === 200));
  assert.equal(h.rows.length, 2);
  assert.equal(h.rows[0].pinned_until, h.rows[1].pinned_from);
  for (const row of h.rows) assert.equal(Date.parse(row.pinned_until) - Date.parse(row.pinned_from), 3600000);
});

test("replayed pin payments do not extend the queue", async () => {
  const h = await harness();
  await h.webhook("checkout.session.completed", pinned("Replay A"));
  await h.webhook("checkout.session.completed", pinned("Replay B"));
  await h.webhook("checkout.session.completed", pinned("Replay A"));
  await h.webhook("checkout.session.completed", pinned("Replay C"));
  assert.equal(h.rows.length, 3);
  assert.equal(h.rows[2].pinned_from, h.rows[1].pinned_until);
  assert.match(await h.page(), /queue currently ends 12 Oct, 15:00 UTC/);
});

test("failed pin allocation releases its lock and a retry receives the first slot", async () => {
  const h = await harness([], false, true);
  assert.equal((await h.webhook("checkout.session.completed", pinned("Retry pin"))).code, 500);
  assert.equal(h.rows.length, 0);
  assert.equal(h.migrationCalls.at(-1).sql, "ROLLBACK");
  assert.equal((await h.webhook("checkout.session.completed", pinned("Retry pin"))).code, 200);
  assert.equal(h.rows[0].pinned_from, "2026-10-12T12:00:00.000Z");
});

test("legacy active pins retain their remaining time and new buyers queue behind them", async () => {
  const h = await harness([{ id: 5, body: "Legacy pin", amount_pence: 2500, stripe_session: "cs_legacy_pin", pinned_until: "2026-10-12T12:30:00.000Z" }]);
  assert.equal(h.rows[0].pinned_from, "2026-10-12T11:30:00.000Z");
  await h.webhook("checkout.session.completed", pinned("New pin"));
  assert.equal(h.rows[1].pinned_from, "2026-10-12T12:30:00.000Z");
  assert.match(await h.page(), /id="pinned-title">Legacy pin<\/h2>/);
});

test("the hook leads the homepage while the paid total remains accurate supporting detail", async () => {
  const h = await harness();
  await h.webhook("checkout.session.completed", paid("cs_hook_test"));
  const html = await h.page();
  assert.match(html, /Your side project made \$0\./);
  assert.match(html, /At least make it famous\./);
  assert.match(html, /class="collective-total"><span class="total">\$1<\/span>/);
  assert.match(html, /href="\/confessions\/1"/);
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
});

test("checkout returns buyers to a private confirmation URL with Stripe's session placeholder", async () => {
  const h = await harness();
  await h.checkout();
  assert.equal(h.checkoutCalls[0].success_url, "https://example.invalid/checkout/success?session_id={CHECKOUT_SESSION_ID}");
});

test("a checkout return cannot publish a confession before its signed webhook arrives", async () => {
  const h = await harness();
  const session = "cs_test_confirmation_pending";
  let res = await h.get("/checkout/success", { query: { session_id: session } });
  assert.equal(res.code, 202);
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.equal(res.headers["Referrer-Policy"], "no-referrer");
  assert.match(res.headers["X-Robots-Tag"], /noindex/);
  assert.equal(h.rows.length, 0);
  assert(!res.body.includes(session));
  assert.match(res.body, /checkout-status.js/);
  await h.webhook("checkout.session.completed", paid(session, "usd", 100, "unpaid"));
  assert.equal((await h.get("/checkout/status", { query: { session_id: session } })).code, 202);
  await h.webhook("checkout.session.async_payment_succeeded", paid(session));
  res = await h.get("/checkout/status", { query: { session_id: session } });
  assert.equal(res.code, 200);
  assert.equal(JSON.stringify(res.body), '{"url":"/confessions/1"}');
  res = await h.get("/checkout/success", { query: { session_id: session } });
  assert.equal(res.code, 303);
  assert.equal(res.url, "/confessions/1");
});

test("confirmation rejects malformed session values without querying the database", async () => {
  const h = await harness();
  for (const session_id of [undefined, "", "<script>", ["cs_test_one", "cs_test_two"], "cs_" + "x".repeat(201)]) {
    assert.equal((await h.get("/checkout/success", { query: { session_id } })).code, 400);
    assert.equal((await h.get("/checkout/status", { query: { session_id } })).code, 400);
  }
  assert.equal(h.readCalls.length, 0);
});

test("confirmation handles database downtime without claiming payment succeeded", async () => {
  const h = await harness();
  h.failReads();
  const request = { query: { session_id: "cs_test_retry_after_outage" } };
  assert.equal((await h.get("/checkout/success", request)).code, 503);
  const response = await h.get("/checkout/status", request);
  assert.equal(response.code, 503);
  assert.equal(response.body.state, "retry");
});

test("public confession pages include per-confession metadata and share actions without payment identifiers", async () => {
  const h = await harness([{ id: 9, body: 'I rewrote "everything" & shipped nothing.', handle: "builder", amount_pence: 100, stripe_session: "cs_test_private_identifier", currency: "usd" }]);
  const res = await h.get("/confessions/:id", { params: { id: "9" } });
  assert.equal(res.code, 200);
  assert.match(res.body, /content="https:\/\/example.invalid\/confessions\/9\/card.png\?v=1"/);
  assert.match(res.body, /rel="canonical" href="https:\/\/example.invalid\/confessions\/9"/);
  assert.match(res.body, /Download card/);
  assert.match(res.body, /Copy link/);
  assert.match(res.body, /twitter.com\/intent\/tweet\?/);
  assert(!res.body.includes("cs_test_private_identifier"));
  assert(!res.body.includes("stripe_session"));
});

test("missing, hidden and malformed confession IDs never expose pages or images", async () => {
  const h = await harness([{ id: 9, body: "Hidden confession", is_hidden: true }]);
  for (const id of ["9", "999", "0", "-1", "1.5", "1 OR 1=1", "2147483648", "9999999999999999"]) {
    for (const route of ["/confessions/:id", "/confessions/:id/card.png"]) {
      const response = await h.get(route, { params: { id } });
      assert.equal(response.code, 404);
      assert(!response.body.includes("Hidden confession"));
    }
  }
});

test("confession PNGs download with the correct filename and hiding a post overrides the render cache", async () => {
  const h = await harness([{ id: 9, body: "A very public confession.", currency: "usd", amount_pence: 100 }]);
  const request = { params: { id: "9" }, query: { download: "1" } };
  const response = await h.get("/confessions/:id/card.png", request);
  assert.equal(response.code, 200);
  assert.equal(response.headers["Content-Type"], "image/png");
  assert.equal(response.headers["Content-Disposition"], 'attachment; filename="didntship-confession-9.png"');
  assert.equal(response.body.subarray(1, 4).toString(), "PNG");
  assert.equal(response.body.readUInt32BE(16), 1200);
  assert.equal(response.body.readUInt32BE(20), 630);
  assert(response.body.byteLength < 5 * 1024 * 1024);
  h.rows[0].is_hidden = true;
  assert.equal((await h.get("/confessions/:id/card.png", request)).code, 404);
});

test("legacy public confessions get cards and the homepage gets a generic share image", async () => {
  const h = await harness(demos);
  assert.equal((await h.get("/confessions/:id/card.png", { params: { id: "3" } })).code, 200);
  assert.equal((await h.get("/share-card.png")).body.readUInt32BE(16), 1200);
});

test("untrusted confession text stays escaped in HTML and image markup", async () => {
  const { cardSvg } = require("../lib/cards");
  const row = { id: 9, body: '<script>alert("x")</script> & <image href="https://attacker.invalid/x"/>', handle: 'a" onload="x' };
  const { renderConfession } = require("../lib/sharing");
  const html = renderConfession(row, "https://example.invalid");
  assert(!html.includes('<script>alert("x")</script>'));
  assert(!html.includes('<image href='));
  const svg = cardSvg(row);
  assert(!svg.includes('<script>'));
  assert(!svg.includes('<image href='));
  assert.match(svg, /&lt;/);
});

test("long words, wide characters and ordinary sentences fit inside the share card", () => {
  const { layoutText, textWidth } = require("../lib/cards");
  for (const body of ["W".repeat(140), "no_spaces_".repeat(14), "word ".repeat(28).trim(), "🚀☕😂 ".repeat(25), "I spent six months buying domains instead of shipping anything."]) {
    const { size, lines } = layoutText(body);
    assert(lines.every((line) => textWidth(line, size) <= 1000));
    assert(lines.length * size * 1.24 <= 290);
    assert.equal(lines.join("").replace(/\s/g, ""), body.replace(/\s/g, ""));
  }
});

test("emoji use the bundled emoji font and a truncated surrogate cannot break PNG rendering", async () => {
  const { cardPng, cardSvg } = require("../lib/cards");
  const row = { id: 10, body: "Coffee ☕, rocket 🚀, developer 🧑‍💻 and a flag 🇬🇧. " + "\ud83d" };
  assert.match(cardSvg(row), /font-family="Noto Emoji"/);
  const png = await cardPng(row);
  assert.equal(png.subarray(1, 4).toString(), "PNG");
});
