const { test, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { createCommunity, SCHEMA, browserToken } = require("../lib/community");
const { createTestDatabase } = require("./helpers/community-db");
const { renderConfession } = require("../lib/sharing");
const { cardSvg, cardPng } = require("../lib/cards");
const { publishOwnerConfession } = require("../lib/owner-confession");

let fixture, community, clock;
const token = (number) => number.toString(16).padStart(64, "0");
const request = (number, extra = {}) => ({ headers: { origin: "https://example.invalid", cookie: "ds_reactor=" + token(number), ...extra.headers }, ip: extra.ip || "192.0.2.1" });
function response() {
  return { statusCode: 200, headers: {}, cookies: [], set(name, value) { this.headers[name] = value; return this; },
    cookie(...args) { this.cookies.push(args); return this; }, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
}
const react = async (id, number, extra) => { const res = response(); await community.react(id, request(number, extra), res); return res; };
const newCommunity = () => createCommunity(fixture.pool, "https://example.invalid", { now: () => new Date(clock) });

before(async () => { fixture = await createTestDatabase(); });
beforeEach(async () => {
  await fixture.db.exec("TRUNCATE copes RESTART IDENTITY CASCADE; TRUNCATE weekly_awards;");
  clock = "2026-10-24T12:00:00Z";
  community = newCommunity();
});
after(async () => { await fixture.db.close(); });

test("schema additions are idempotent and leave existing payment records intact", async () => {
  await fixture.seed(5);
  await fixture.db.exec(SCHEMA);
  const row = (await fixture.pool.query("SELECT stripe_session, amount_pence FROM copes WHERE id=5")).rows[0];
  assert.deepEqual(row, { stripe_session: "cs_test_5", amount_pence: 100 });
});

test("parallel repeat reactions count once and independent browsers count separately", async () => {
  await fixture.seed(5);
  const results = await Promise.all(Array.from({ length: 10 }, () => react(5, 1)));
  assert(results.every((res) => res.body.count === 1));
  assert.equal((await react(5, 2)).body.count, 2);
  assert.deepEqual(await community.reactionStates([5], request(1)), [{ id: 5, count: 2, reacted: true }]);
  assert.deepEqual(await community.reactionStates([5], request(3)), [{ id: 5, count: 2, reacted: false }]);
});

test("the first successful reaction sets a secure anonymous cookie and stores only its hash", async () => {
  await fixture.seed(5);
  const res = response();
  await community.react(5, { headers: { origin: "https://example.invalid" }, ip: "192.0.2.1" }, res);
  const [name, value, options] = res.cookies[0];
  assert.equal(name, "ds_reactor"); assert.match(value, /^[a-f0-9]{64}$/);
  assert.equal(options.httpOnly, true); assert.equal(options.secure, true); assert.equal(options.sameSite, "lax");
  assert.equal(options.path, "/"); assert(!options.domain);
  const row = (await fixture.pool.query("SELECT voter_hash FROM confession_reactions")).rows[0];
  assert.equal(row.voter_hash, createHash("sha256").update(value).digest("hex"));
  assert.notEqual(row.voter_hash, value);
  assert.equal(browserToken({ headers: { cookie: "other=x; ds_reactor=" + value } }), value);
  assert.equal(browserToken({ headers: { cookie: "ds_reactor=invalid" } }), null);
});

test("state reads never create a browser cookie or expose a voter identifier", async () => {
  await fixture.seed(5);
  const states = await community.reactionStates([5], { headers: {} });
  assert.deepEqual(states, [{ id: 5, count: 0, reacted: false }]);
  assert.equal((await fixture.pool.query("SELECT COUNT(*)::int AS count FROM confession_reactions")).rows[0].count, 0);
});

test("demos, hidden posts, missing posts and unpaid fixtures cannot receive reactions", async () => {
  await fixture.seed(3, undefined, { demo: true });
  await fixture.seed(4, undefined, { hidden: true });
  await fixture.seed(7, undefined, { amount: 0, session: null });
  for (const id of [3,4,7,999]) assert.equal((await react(id, 1)).statusCode, 404);
  assert.deepEqual(await community.reactionStates([3,4,7], request(1)), []);
});

test("owner conversion is idempotent, preserves history and only changes the exact approved demo", async () => {
  const body = "Spent the morning buying a domain instead of shipping the actual product";
  await fixture.seed(3, "2026-08-31T08:18:42Z", { demo: true, body, handle: "chriscompiles", amount: 300 });
  await fixture.seed(4, undefined, { demo: true, body, handle: "chriscompiles" });
  await fixture.seed(5);
  const before = (await fixture.pool.query("SELECT * FROM copes ORDER BY id")).rows;
  await publishOwnerConfession(fixture.pool);
  await publishOwnerConfession(fixture.pool);
  const after = (await fixture.pool.query("SELECT * FROM copes ORDER BY id")).rows;
  assert.deepEqual(after, [{ ...before[0], is_demo: false, is_complimentary: true }, ...before.slice(1)]);
  await fixture.pool.query("UPDATE copes SET is_complimentary=FALSE, is_demo=TRUE, body='A different confession' WHERE id=3");
  await publishOwnerConfession(fixture.pool);
  assert.equal((await fixture.pool.query("SELECT is_complimentary FROM copes WHERE id=3")).rows[0].is_complimentary, false);
  await fixture.pool.query("UPDATE copes SET body=$1, handle='someone_else' WHERE id=3", [body]);
  await publishOwnerConfession(fixture.pool);
  assert.equal((await fixture.pool.query("SELECT is_complimentary FROM copes WHERE id=3")).rows[0].is_complimentary, false);
});

test("complimentary posts accept normal reactions without creating a payment or entering paid awards", async () => {
  await fixture.seed(3, undefined, { complimentary: true, amount: 0, session: null });
  await fixture.seed(4, undefined, { complimentary: true, amount: 300 });
  for (const id of [3,4]) for (const browser of [1,2,3]) assert.equal((await react(id, browser)).statusCode, 200);
  assert.deepEqual(await community.reactionStates([3], request(1)), [{ id: 3, count: 3, reacted: true }]);
  clock = "2026-10-26T00:00:00Z";
  await community.refreshAwards();
  assert.equal(await community.latestAward(), null);
  assert.deepEqual((await fixture.pool.query("SELECT amount_pence, stripe_session FROM copes WHERE id=3")).rows[0], { amount_pence: 0, stripe_session: null });
  await fixture.pool.query("UPDATE copes SET is_hidden=TRUE WHERE id=3");
  assert.equal((await react(3, 4)).statusCode, 404);
});

test("cross-site or absent Origin cannot write a reaction", async () => {
  await fixture.seed(5);
  for (const headers of [{ origin: undefined }, { origin: "https://evil.invalid" }, { "sec-fetch-site": "cross-site" }]) {
    assert.equal((await react(5, 1, { headers })).statusCode, 403);
  }
  assert.equal((await fixture.pool.query("SELECT COUNT(*)::int AS count FROM confession_reactions")).rows[0].count, 0);
});

test("browser and network limits discourage repeat submissions and cookie resets", async () => {
  await fixture.seed(5);
  for (let i=0;i<20;i++) assert.equal((await react(5, 1)).statusCode, 200);
  assert.equal((await react(5, 1)).statusCode, 429);
  community = newCommunity();
  for (let i=1;i<=120;i++) assert.equal((await react(5, i)).statusCode, 200);
  const blocked = await react(5, 121);
  assert.equal(blocked.statusCode, 429); assert.equal(blocked.headers["Retry-After"], "60");
});

async function competingWeek() {
  await fixture.seed(5, "2026-10-20T10:00:00Z");
  await fixture.seed(6, "2026-10-20T11:00:00Z");
  await react(5, 1); await react(5, 2); await react(6, 3);
}

test("a current week has no winner; the first visit after the UK week ends finalizes it", async () => {
  await competingWeek();
  clock = "2026-10-25T23:59:59Z"; // Sunday after clocks return to GMT.
  await community.refreshAwards();
  assert.equal(await community.latestAward(), null);
  clock = "2026-10-26T00:00:00Z";
  await community.refreshAwards(); // Cache must not suppress the first request across UK midnight.
  const award = await community.latestAward();
  assert.equal(award.id, 5); assert.equal(award.award_week, "2026-10-19"); assert.equal(award.award_reactions, 2);
});

test("award results survive late votes, restarts, and simultaneous award checks", async () => {
  await competingWeek(); clock = "2026-10-26T00:00:01Z";
  await Promise.all([community.refreshAwards(), newCommunity().refreshAwards(), newCommunity().refreshAwards()]);
  await react(6, 4); await react(6, 5); await react(6, 6);
  community = newCommunity(); await community.refreshAwards();
  assert.equal((await community.latestAward()).id, 5);
  assert.equal((await fixture.pool.query("SELECT COUNT(*)::int AS count FROM weekly_awards")).rows[0].count, 1);
  const [row] = await community.enrich([{ id: 6 }]); assert.equal(row.reaction_count, 4);
});

test("late votes cannot manufacture participation for a finished week", async () => {
  await fixture.seed(5); await fixture.seed(6);
  clock = "2026-10-26T00:00:00Z";
  await react(5, 1); await react(5, 2); await react(6, 3);
  await community.refreshAwards();
  assert.equal(await community.latestAward(), null);
  const result = (await fixture.pool.query("SELECT winner_id FROM weekly_awards")).rows[0];
  assert.equal(result.winner_id, null);
});

test("low participation is recorded with no winner and stays fixed", async () => {
  await fixture.seed(5); await fixture.seed(6);
  await react(5, 1); await react(6, 2);
  clock = "2026-10-26T00:00:00Z"; await community.refreshAwards();
  assert.equal(await community.latestAward(), null);
  assert.equal((await fixture.pool.query("SELECT winner_id FROM weekly_awards")).rows[0].winner_id, null);
});

test("one confession cannot win even with three reacting browsers", async () => {
  await fixture.seed(5); await react(5, 1); await react(5, 2); await react(5, 3);
  clock = "2026-10-26T00:00:00Z"; await community.refreshAwards();
  assert.equal(await community.latestAward(), null);
});

test("ties go to earliest submission, then lowest ID", async () => {
  await fixture.seed(6, "2026-10-20T10:00:00Z"); await fixture.seed(5, "2026-10-20T10:00:00Z");
  for (const id of [5,6]) for (const browser of [1,2,3]) await react(id, browser);
  clock = "2026-10-26T00:00:00Z"; await community.refreshAwards();
  assert.equal((await community.latestAward()).id, 5);
});

test("only that week's eligible paid confessions compete; old, demo, complimentary and hidden posts do not", async () => {
  await competingWeek();
  await fixture.seed(7, "2026-10-10T00:00:00Z");
  await fixture.seed(8, undefined, { demo: true }); await fixture.seed(9, undefined, { hidden: true });
  await fixture.seed(10, undefined, { complimentary: true });
  for (const browser of [1,2,3,4,5]) await react(10, browser);
  for (const browser of [1,2,3,4]) await react(7, browser);
  clock = "2026-10-26T00:00:00Z"; await community.refreshAwards();
  assert.equal((await community.latestAward()).id, 5);
});

test("a week before the autumn clock change uses Monday midnight BST, not UTC", async () => {
  await fixture.seed(5, "2026-10-12T00:00:00+01:00"); await fixture.seed(6, "2026-10-18T12:00:00+01:00");
  clock = "2026-10-18T22:59:59Z";
  await react(5, 1); await react(5, 2); await react(6, 3); await community.refreshAwards();
  assert.equal(await community.latestAward(), null);
  clock = "2026-10-18T23:00:00Z"; await community.refreshAwards();
  assert.equal((await community.latestAward()).award_week, "2026-10-12");
});

test("both DST changes preserve UK calendar-week boundaries", async () => {
  const rows = (await fixture.pool.query(`SELECT
    (extract(epoch FROM (('2026-10-26'::date::timestamp AT TIME ZONE 'Europe/London') - ('2026-10-19'::date::timestamp AT TIME ZONE 'Europe/London'))) / 3600)::int AS autumn,
    (extract(epoch FROM (('2026-03-30'::date::timestamp AT TIME ZONE 'Europe/London') - ('2026-03-23'::date::timestamp AT TIME ZONE 'Europe/London'))) / 3600)::int AS spring`)).rows;
  assert.equal(rows[0].autumn, 169);
  assert.equal(rows[0].spring, 167);
});

test("hiding a winner removes the public feature without replacing the stored winner", async () => {
  await competingWeek(); clock = "2026-10-26T00:00:00Z"; await community.refreshAwards();
  await fixture.pool.query("UPDATE copes SET is_hidden=TRUE WHERE id=5");
  community = newCommunity(); await community.refreshAwards();
  assert.equal(await community.latestAward(), null);
  assert.equal((await fixture.pool.query("SELECT winner_id FROM weekly_awards")).rows[0].winner_id, 5);
});

test("earned badges appear on the page and PNG, with a fresh social image URL", async () => {
  await competingWeek(); clock = "2026-10-26T00:00:00Z"; await community.refreshAwards();
  const [row] = await community.enrich([{ id: 5, body: "I rewrote the rewrite.", handle: "builder" }]);
  const html = renderConfession(row, "https://example.invalid");
  assert.match(html, /Excuse of the week/); assert.match(html, /card.png\?v=1&amp;award=2026-10-19/);
  assert.match(cardSvg(row), /EXCUSE OF THE WEEK/);
  assert(!cardSvg({ id: 6, body: "No award" }).includes("EXCUSE OF THE WEEK"));
  const png = await cardPng(row); assert.equal(png.readUInt32BE(16), 1200);
});

test("a failed reaction rolls back its insert, releases its client, and sets no cookie", async () => {
  await fixture.seed(5);
  let released = false;
  const failing = { ...fixture.pool, async connect() {
    const client = await fixture.pool.connect();
    return { async query(sql, args) {
      if (sql.startsWith("SELECT COUNT(*)::int AS count FROM confession_reactions")) throw new Error("test read failure");
      return client.query(sql, args);
    }, release() { released = true; client.release(); } };
  } };
  const res = response();
  await assert.rejects(createCommunity(failing, "https://example.invalid").react(5, { headers: { origin: "https://example.invalid" }, ip: "192.0.2.1" }, res), /test read failure/);
  assert(released); assert.equal(res.cookies.length, 0);
  assert.equal((await fixture.pool.query("SELECT COUNT(*)::int AS count FROM confession_reactions")).rows[0].count, 0);
});
