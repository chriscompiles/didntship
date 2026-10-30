const { randomBytes, createHash } = require("node:crypto");

const COOKIE = "ds_reactor";
const LOCK = "SELECT pg_advisory_xact_lock(100138, 2)";
const MIN_ENTRIES = 2;
const MIN_VOTERS = 3;
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS confession_reactions (
    confession_id INTEGER NOT NULL REFERENCES copes(id) ON DELETE CASCADE,
    voter_hash CHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (confession_id, voter_hash)
  );
  CREATE INDEX IF NOT EXISTS confession_reactions_created_idx ON confession_reactions(created_at);
  CREATE TABLE IF NOT EXISTS weekly_awards (
    week_start DATE PRIMARY KEY,
    winner_id INTEGER REFERENCES copes(id) ON DELETE SET NULL,
    reaction_count INTEGER NOT NULL DEFAULT 0 CHECK (reaction_count >= 0),
    decided_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
  );
  CREATE INDEX IF NOT EXISTS weekly_awards_winner_idx ON weekly_awards(winner_id);
`;

const hash = (value) => createHash("sha256").update(value).digest("hex");
function browserToken(req) {
  const value = String(req.headers.cookie || "").split(";")
    .map((part) => part.trim()).find((part) => part.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1);
  return /^[a-f0-9]{64}$/.test(value || "") ? value : null;
}

function weekLabel(week) {
  return new Date(String(week).slice(0, 10) + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" });
}

function createCommunity(pool, publicUrl, options = {}) {
  const origin = new URL(publicUrl).origin;
  const now = options.now || (() => new Date());
  const buckets = new Map();
  const salt = randomBytes(16).toString("hex");
  let lastSweep = 0;
  let checkedAt = 0;
  let checkedDay = "";
  let refreshing;

  function allowed(key, limit, timestamp) {
    if (timestamp - lastSweep > 60000) {
      for (const [key, value] of buckets) if (value.until <= timestamp) buckets.delete(key);
      lastSweep = timestamp;
    }
    if (!buckets.has(key) && buckets.size >= 10000) return false;
    let value = buckets.get(key);
    if (!value || value.until <= timestamp) { value = { count: 0, until: timestamp + 60000 }; buckets.set(key, value); }
    return ++value.count <= limit;
  }

  async function refreshAwards() {
    if (refreshing) return refreshing;
    const localDay = now().toLocaleDateString("en-GB", { timeZone: "Europe/London" });
    if (localDay === checkedDay && Date.now() - checkedAt < 60000) return;
    refreshing = (async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(LOCK);
        const timestamp = now();
        const pending = await client.query(`
          SELECT DISTINCT date_trunc('week', c.created_at AT TIME ZONE 'Europe/London')::date::text AS week_start
          FROM copes c
          WHERE c.is_demo = FALSE AND c.is_complimentary = FALSE AND c.amount_pence > 0 AND c.stripe_session IS NOT NULL
            AND c.created_at < (date_trunc('week', $1::timestamptz AT TIME ZONE 'Europe/London') AT TIME ZONE 'Europe/London')
            AND NOT EXISTS (SELECT 1 FROM weekly_awards w WHERE w.week_start = date_trunc('week', c.created_at AT TIME ZONE 'Europe/London')::date)
          ORDER BY week_start`, [timestamp]);
        for (const { week_start } of pending.rows) {
          const entries = await client.query(`
            SELECT c.id, COUNT(r.confession_id)::int AS reactions
            FROM copes c LEFT JOIN confession_reactions r ON r.confession_id = c.id
              AND r.created_at >= ($1::date::timestamp AT TIME ZONE 'Europe/London')
              AND r.created_at < (($1::date + 7)::timestamp AT TIME ZONE 'Europe/London')
            WHERE c.is_demo = FALSE AND c.is_complimentary = FALSE AND c.is_hidden = FALSE AND c.amount_pence > 0 AND c.stripe_session IS NOT NULL
              AND c.created_at >= ($1::date::timestamp AT TIME ZONE 'Europe/London')
              AND c.created_at < (($1::date + 7)::timestamp AT TIME ZONE 'Europe/London')
            GROUP BY c.id ORDER BY reactions DESC, c.created_at ASC, c.id ASC`, [week_start]);
          const voters = await client.query(`
            SELECT COUNT(DISTINCT r.voter_hash)::int AS voters FROM confession_reactions r JOIN copes c ON c.id = r.confession_id
            WHERE c.is_demo = FALSE AND c.is_complimentary = FALSE AND c.is_hidden = FALSE AND c.amount_pence > 0 AND c.stripe_session IS NOT NULL
              AND c.created_at >= ($1::date::timestamp AT TIME ZONE 'Europe/London')
              AND c.created_at < (($1::date + 7)::timestamp AT TIME ZONE 'Europe/London')
              AND r.created_at >= ($1::date::timestamp AT TIME ZONE 'Europe/London')
              AND r.created_at < (($1::date + 7)::timestamp AT TIME ZONE 'Europe/London')`, [week_start]);
          const winner = entries.rows.length >= MIN_ENTRIES && voters.rows[0].voters >= MIN_VOTERS && entries.rows[0].reactions > 0 ? entries.rows[0] : null;
          await client.query(`INSERT INTO weekly_awards (week_start, winner_id, reaction_count, decided_at)
            VALUES ($1, $2, $3, $4) ON CONFLICT (week_start) DO NOTHING`, [week_start, winner?.id || null, winner?.reactions || 0, timestamp]);
        }
        await client.query("COMMIT");
        checkedAt = Date.now();
        checkedDay = localDay;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    })();
    try { await refreshing; } finally { refreshing = null; }
  }

  async function enrich(rows) {
    const ids = rows.map((row) => Number(row.id)).filter(Number.isInteger);
    if (!ids.length) return rows;
    const result = await pool.query(`
      SELECT c.id, (SELECT COUNT(*)::int FROM confession_reactions r WHERE r.confession_id = c.id) AS reaction_count,
        w.week_start::text AS award_week, w.reaction_count AS award_reactions
      FROM copes c LEFT JOIN weekly_awards w ON w.winner_id = c.id
      WHERE c.id = ANY($1::int[]) AND c.is_hidden = FALSE`, [ids]);
    const byId = new Map(result.rows.map((row) => [row.id, row]));
    return rows.map((row) => ({ ...row, ...byId.get(row.id) }));
  }

  async function latestAward() {
    const result = await pool.query(`SELECT c.id, c.body, c.handle, w.week_start::text AS award_week, w.reaction_count AS award_reactions
      FROM weekly_awards w JOIN copes c ON c.id = w.winner_id
      WHERE c.is_hidden = FALSE AND c.is_demo = FALSE AND c.is_complimentary = FALSE ORDER BY w.week_start DESC LIMIT 1`);
    return result.rows[0] || null;
  }

  async function reactionStates(ids, req) {
    const token = browserToken(req);
    const result = await pool.query(`SELECT c.id, (SELECT COUNT(*)::int FROM confession_reactions r WHERE r.confession_id = c.id) AS count,
      EXISTS (SELECT 1 FROM confession_reactions r WHERE r.confession_id = c.id AND r.voter_hash = $2) AS reacted
      FROM copes c WHERE c.id = ANY($1::int[]) AND c.is_hidden = FALSE AND c.is_demo = FALSE
        AND (c.is_complimentary = TRUE OR (c.amount_pence > 0 AND c.stripe_session IS NOT NULL))`, [ids, token ? hash(token) : ""]);
    return result.rows;
  }

  async function react(id, req, res) {
    res.set("Cache-Control", "no-store");
    if (req.headers.origin !== origin || req.headers["sec-fetch-site"] === "cross-site") return res.status(403).json({ error: "Please react from this site." });
    const token = browserToken(req) || randomBytes(32).toString("hex");
    const time = Date.now();
    // Express trusts only Render's final proxy hop. Hash network addresses in short-lived memory; never store them with votes.
    if (!allowed("network:" + hash(salt + (req.ip || req.socket?.remoteAddress || "unknown")), 120, time) || !allowed("browser:" + hash(token), 20, time)) {
      res.set("Retry-After", "60");
      return res.status(429).json({ error: "A lot of shared regret. Please try again in a minute." });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(LOCK);
      const result = await client.query(`SELECT id FROM copes WHERE id = $1 AND is_hidden = FALSE AND is_demo = FALSE
        AND (is_complimentary = TRUE OR (amount_pence > 0 AND stripe_session IS NOT NULL)) FOR SHARE`, [id]);
      if (!result.rows[0]) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Confession not found." }); }
      await client.query(`INSERT INTO confession_reactions (confession_id, voter_hash, created_at) VALUES ($1, $2, $3)
        ON CONFLICT (confession_id, voter_hash) DO NOTHING`, [id, hash(token), now()]);
      const count = await client.query("SELECT COUNT(*)::int AS count FROM confession_reactions WHERE confession_id = $1", [id]);
      await client.query("COMMIT");
      if (!browserToken(req)) res.cookie(COOKIE, token, { httpOnly: true, secure: origin.startsWith("https:"), sameSite: "lax", path: "/", maxAge: 365 * 24 * 60 * 60 * 1000 });
      return res.json({ id, count: count.rows[0].count, reacted: true });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  return { refreshAwards, enrich, latestAward, reactionStates, react };
}

module.exports = { createCommunity, SCHEMA, browserToken, weekLabel, MIN_ENTRIES, MIN_VOTERS };
