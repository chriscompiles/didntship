const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const demos = [
  { id: 3, body: "Spent the morning buying a domain instead of shipping the actual product", handle: "chriscompiles", amount_pence: 300, stripe_session: "cs_demo_one" },
  { id: 4, body: "Too many Linux distros", handle: "coderama", amount_pence: 300, stripe_session: "cs_demo_two" },
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
  let released = false;
  let started = false;
  let exitCode = null;
  const app = {
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
              row.pinned_from ??= null;
              row.is_hidden ??= false;
            }
          }
          if (sql.includes("SET pinned_from = pinned_until")) {
            for (const row of rows) {
              if (row.pinned_until && !row.pinned_from) row.pinned_from = new Date(Date.parse(row.pinned_until) - 3600000).toISOString();
            }
          }
          if (sql.startsWith("UPDATE copes SET is_demo")) {
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
          rows.push({ body: parameters[0], handle: parameters[1], link: parameters[2], amount_pence: parameters[3], pinned_until: parameters[4], stripe_session: parameters[5], currency: parameters[6], is_demo: false });
        }
        return { rows: [] };
      }
      if (sql.includes("SUM(amount_pence)")) {
        assert.match(sql, /WHERE is_demo = FALSE GROUP BY currency/);
        const totals = new Map();
        for (const row of rows.filter((row) => !row.is_demo)) totals.set(row.currency, (totals.get(row.currency) || 0) + row.amount_pence);
        return { rows: [...totals].map(([currency, total]) => ({ currency, total: String(total) })) };
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
    return { code: 200, status(code) { this.code = code; return this; }, send(body) { this.body = body; return this; }, json(body) { this.body = body; return this; }, redirect(code, url) { this.code = code; this.url = url; return this; } };
  }
  return {
    rows, checkoutCalls, migrationCalls, context,
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

test("migration marks only the two approved demos and preserves original payment amounts", async () => {
  const other = { id: 5, body: "A real purchase", handle: "someone", amount_pence: 300, stripe_session: "cs_other" };
  const h = await harness([...demos, other]);
  assert.deepEqual(h.rows.map((row) => row.is_demo), [true, true, false]);
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

test("the retained demo displays USD 1 and the paid headline starts at USD 0", async () => {
  const h = await harness(demos);
  const html = await h.page();
  assert.match(html, /class="total">\$0<\/span>/);
  assert.equal((html.match(/class="badge">demo<\/span>/g) || []).length, 1);
  assert.equal((html.match(/class="amount">\$1<\/span>/g) || []).length, 1);
  assert.match(html, /not included in the paid total/);
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
  assert.match(html, /class="total">\$1<\/span>/);
  assert.match(html, /Earlier purchases in other currencies: £3/);
});

test("replayed webhook deliveries do not duplicate posts or inflate the total", async () => {
  const h = await harness(demos);
  await h.webhook("checkout.session.completed", paid("cs_repeat"));
  await h.webhook("checkout.session.completed", paid("cs_repeat"));
  assert.equal(h.rows.length, 3);
  assert.match(await h.page(), /class="total">\$1<\/span>/);
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
