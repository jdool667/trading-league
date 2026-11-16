/**
 * Trading League API. All data lives in one KV key: {trades: [], prices: {}}.
 *
 *   GET            -> {trades, prices}
 *   POST {action: "trade",  pass, trader, side, ticker, qty, price, date}
 *   POST {action: "delete", pass, id}
 *   POST {action: "price",  pass, ticker, price}
 *
 * Writes need the shared passphrase (secret PASS). Every reply is the full state.
 */

const TRADERS = ["Jack", "Perez", "Bell", "Brown", "Ethan"];
const KEY = "state";

export default {
  async fetch(request, env) {
    const cors = {
      "access-control-allow-origin": env.ALLOWED_ORIGIN || "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    };
    const reply = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { ...cors, "content-type": "application/json" } });

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const state = (await env.LEAGUE.get(KEY, "json")) || { trades: [], prices: {} };
    if (request.method === "GET") return reply(state);
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
      state.trades.push({ id: crypto.randomUUID(), trader: body.trader, side: body.side, ticker, qty, price, date, createdAt: Date.now() });
    } else if (body.action === "delete") {
      state.trades = state.trades.filter((t) => t.id !== body.id);
    } else if (body.action === "price") {
      const ticker = String(body.ticker || "").trim().toUpperCase();
      const price = Number(body.price);
      if (!ticker || !(price > 0)) return reply({ error: "Invalid price" }, 400);
      state.prices[ticker] = { price, updatedAt: Date.now() };
    } else {
      return reply({ error: "Unknown action" }, 400);
    }

    await env.LEAGUE.put(KEY, JSON.stringify(state));
    return reply(state);
  },
};
