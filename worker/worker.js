/**
 * Trading League API, backed by a D1 (SQLite) database. See schema.sql.
 *
 *   GET            -> {trades, prices}   (also refreshes live prices every 5 min)
 *   GET ?lookup=X  -> {matches: [{symbol, name, exchange, price}]}  (tries X and X.L)
 *   GET ?history=1 -> {series: {ticker: [[ms, priceGbp], ...]}}      (for the race chart, cached 30 min)
 *   POST {action: "trade",  pass, trader, side, ticker, qty, price, date}
 *   POST {action: "delete", pass, id}
 *   POST {action: "price",  pass, ticker, price}
 *   POST {action: "suggest", pass, author, text}
 *   Replies are added by hand: see README.
 *
 * Writes need the shared passphrase (secret PASS). Every reply is the full state.
 */

const TRADERS = ["Jack", "Perez", "Bell", "Brown", "Ethan"];
const QUOTE_EVERY_MS = 5 * 60 * 1000;

// Yahoo Finance's free chart endpoint (unofficial, no key).
async function quote(symbol) {
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(symbol) + "?range=1d&interval=1d";
  try {
    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
    if (!res.ok) return null;
    const meta = (await res.json()).chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice) return null;
    return { price: meta.regularMarketPrice, currency: meta.currency, name: meta.longName || meta.shortName || symbol, exchange: meta.fullExchangeName || "" };
  } catch {
    return null;
  }
}

async function priceInGbp(ticker, fxCache) {
  const q = await quote(ticker);
  return q ? toGbp(q, fxCache) : null;
}

async function toGbp(q, fxCache) {
  if (q.currency === "GBP") return q.price;
  if (q.currency === "GBp" || q.currency === "GBX") return q.price / 100; // pence
  if (!(q.currency in fxCache)) fxCache[q.currency] = (await quote(q.currency + "GBP=X"))?.price || null;
  return fxCache[q.currency] ? q.price * fxCache[q.currency] : null;
}

// Refreshes live prices for every traded ticker, at most once every 5 minutes.
// Tickers Yahoo can't find keep their typed-in price.
async function refreshQuotes(db) {
  const last = await db.prepare("SELECT value FROM meta WHERE key = 'quotedAt'").first("value");
  if (Date.now() - (last || 0) < QUOTE_EVERY_MS) return;
  await db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('quotedAt', ?)").bind(Date.now()).run();

  const { results } = await db.prepare("SELECT DISTINCT ticker FROM trades LIMIT 50").all();
  const fxCache = {};
  for (const { ticker } of results) {
    const price = await priceInGbp(ticker, fxCache);
    if (price) {
      await db.prepare("INSERT OR REPLACE INTO prices (ticker, price, updatedAt, live) VALUES (?, ?, ?, 1)")
        .bind(ticker, Math.round(price * 10000) / 10000, Date.now()).run();
    }
  }
}

async function loadState(db) {
  const trades = (await db.prepare("SELECT * FROM trades").all()).results;
  const prices = {};
  for (const p of (await db.prepare("SELECT * FROM prices").all()).results) {
    prices[p.ticker] = { price: p.price, updatedAt: p.updatedAt, live: p.live === 1 };
  }
  const suggestions = (await db.prepare("SELECT * FROM suggestions ORDER BY createdAt DESC LIMIT 200").all()).results;
  return { trades, prices, suggestions };
}

async function gbpRate(currency, fxCache) {
  if (currency === "GBP") return 1;
  if (currency === "GBp" || currency === "GBX") return 0.01;
  if (!(currency in fxCache)) fxCache[currency] = (await quote(currency + "GBP=X"))?.price || null;
  return fxCache[currency];
}

// Hourly closes (daily once the challenge is over 60 days old) since each ticker's first trade.
// Uses today's exchange rate for non-£ stocks, which is close enough for a chart.
async function history(db) {
  const cached = await db.prepare("SELECT value, updatedAt FROM cache WHERE key = 'history'").first();
  if (cached && Date.now() - cached.updatedAt < 30 * 60 * 1000) return JSON.parse(cached.value);
  const { results } = await db.prepare("SELECT ticker, MIN(date) AS first FROM trades GROUP BY ticker LIMIT 50").all();
  const fxCache = {};
  const now = Math.floor(Date.now() / 1000);
  const series = {};
  for (const { ticker, first } of results) {
    const start = Math.floor(Date.parse(first + "T00:00:00Z") / 1000);
    const interval = now - start > 60 * 86400 ? "1d" : "1h";
    const url = "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(ticker) + `?period1=${start}&period2=${now}&interval=${interval}`;
    try {
      const r = (await (await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } })).json()).chart?.result?.[0];
      const rate = r && (await gbpRate(r.meta.currency, fxCache));
      if (!r?.timestamp || !rate) continue;
      const closes = r.indicators.quote[0].close;
      series[ticker] = r.timestamp
        .map((t, i) => (closes[i] == null ? null : [t * 1000, Math.round(closes[i] * rate * 10000) / 10000]))
        .filter(Boolean);
    } catch {}
  }
  const data = { series };
  await db.prepare("INSERT OR REPLACE INTO cache (key, value, updatedAt) VALUES ('history', ?, ?)").bind(JSON.stringify(data), Date.now()).run();
  return data;
}

// "TSCO" could be Tractor Supply (US) or Tesco (TSCO.L), so return every match.
async function lookup(raw) {
  const symbol = raw.trim().toUpperCase().slice(0, 12);
  if (!symbol) return [];
  const candidates = symbol.includes(".") ? [symbol] : [symbol, symbol + ".L"];
  const matches = [];
  const fxCache = {};
  for (const s of candidates) {
    const q = await quote(s);
    if (q) matches.push({ symbol: s, name: q.name, exchange: q.exchange, price: await toGbp(q, fxCache) });
  }
  return matches;
}

export default {
  async fetch(request, env) {
    const db = env.DB;
    const cors = {
      "access-control-allow-origin": env.ALLOWED_ORIGIN || "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    };
    const reply = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { ...cors, "content-type": "application/json" } });

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    if (request.method === "GET") {
      const symbol = new URL(request.url).searchParams.get("lookup");
      if (symbol !== null) return reply({ matches: await lookup(symbol) });
      if (new URL(request.url).searchParams.has("history")) return reply(await history(db));
      await refreshQuotes(db);
      return reply(await loadState(db));
    }
    if (request.method !== "POST") return reply({ error: "Not found" }, 404);

    let body;
    try {
      body = await request.json();
    } catch {
      return reply({ error: "Bad request" }, 400);
    }
    if (body.pass !== env.PASS) return reply({ error: "Wrong passphrase" }, 401);

    if (body.action === "trade") {
      const ticker = String(body.ticker || "").trim().toUpperCase().slice(0, 12);
      const qty = Number(body.qty);
      const price = Number(body.price);
      const date = String(body.date || "");
      const valid =
        TRADERS.includes(body.trader) &&
        (body.side === "buy" || body.side === "sell") &&
        ticker && qty > 0 && price > 0 &&
        /^\d{4}-\d{2}-\d{2}$/.test(date);
      if (!valid) return reply({ error: "Invalid trade" }, 400);
      await db.prepare("INSERT INTO trades (id, trader, side, ticker, qty, price, date, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), body.trader, body.side, ticker, qty, price, date, Date.now()).run();
      await db.prepare("DELETE FROM cache").run();
      // Get a live price for a new ticker on the next load.
      await db.prepare("DELETE FROM meta WHERE key = 'quotedAt'").run();
    } else if (body.action === "delete") {
      await db.prepare("DELETE FROM trades WHERE id = ?").bind(String(body.id)).run();
      await db.prepare("DELETE FROM cache").run();
    } else if (body.action === "price") {
      const ticker = String(body.ticker || "").trim().toUpperCase();
      const price = Number(body.price);
      if (!ticker || !(price > 0)) return reply({ error: "Invalid price" }, 400);
      await db.prepare("INSERT OR REPLACE INTO prices (ticker, price, updatedAt, live) VALUES (?, ?, ?, 0)")
        .bind(ticker, price, Date.now()).run();
    } else if (body.action === "suggest") {
      const text = String(body.text || "").trim().slice(0, 1000);
      if (!TRADERS.includes(body.author) || !text) return reply({ error: "Invalid suggestion" }, 400);
      await db.prepare("INSERT INTO suggestions (id, author, text, createdAt) VALUES (?, ?, ?, ?)")
        .bind(crypto.randomUUID(), body.author, text, Date.now()).run();
    } else {
      return reply({ error: "Unknown action" }, 400);
    }

    return reply(await loadState(db));
  },
};
