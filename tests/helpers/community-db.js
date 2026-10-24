const { PGlite } = require("@electric-sql/pglite");
const { SCHEMA } = require("../../lib/community");

async function createTestDatabase() {
  const db = new PGlite();
  await db.exec(`CREATE TABLE copes (
    id SERIAL PRIMARY KEY, body TEXT NOT NULL, handle TEXT, link TEXT,
    amount_pence INTEGER NOT NULL, pinned_until TIMESTAMPTZ, pinned_from TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(), stripe_session TEXT UNIQUE,
    currency TEXT NOT NULL DEFAULT 'usd', is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    is_hidden BOOLEAN NOT NULL DEFAULT FALSE
  ); ${SCHEMA}`);
  // PGlite has one physical connection. Lease it for each complete transaction,
  // matching pg.Pool's client ownership rather than interleaving BEGIN statements.
  let tail = Promise.resolve();
  const query = async (sql, params = []) => {
    if (!params.length && sql.split(";").filter((part) => part.trim()).length > 1) {
      await db.exec(sql); return { rows: [] };
    }
    return db.query(sql, params);
  };
  const pool = {
    async connect() {
      const previous = tail;
      let release;
      tail = new Promise((resolve) => { release = resolve; });
      await previous;
      return { query, release };
    },
    async query(sql, params) {
      const client = await this.connect();
      try { return await client.query(sql, params); } finally { client.release(); }
    },
  };
  async function seed(id, created = "2026-10-20T10:00:00Z", extra = {}) {
    await pool.query(`INSERT INTO copes (id, body, handle, link, amount_pence, created_at, stripe_session, is_demo, is_hidden)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, extra.body || "An unfinished project " + id, extra.handle || null,
      extra.link || null, extra.amount ?? 100, created, extra.session === null ? null : "cs_test_" + id, !!extra.demo, !!extra.hidden]);
  }
  return { db, pool, seed };
}

module.exports = { createTestDatabase };
