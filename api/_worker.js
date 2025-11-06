export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 🔍 Debug binding check
    if (url.pathname === "/debug") {
      return json(Object.keys(env));
    }

    // 📅 List all events
    if (url.pathname === "/events.json") {
      const data = await getEvents(env);
      return json(data);
    }

    // 🏙️ Filter by city
   if (url.pathname.startsWith("/city/") && url.pathname.endsWith(".json")) {
  const city = decodeURIComponent(url.pathname.split("/city/")[1].replace(".json", "")).trim();
  const stmt = env.DB.prepare(`
    SELECT * FROM events
    WHERE TRIM(LOWER(city)) = LOWER(?)
    AND city != ''
    ORDER BY date ASC
  `);
  const { results } = await stmt.bind(city).all();
  return json(results);
}
    // 📥 Community event upload
    if (url.pathname === "/api/events" && request.method === "POST") {
      try {
        const body = await request.json();
        if (!body.title || !body.city) {
          return json({ error: "title and city are required" }, 400);
        }

        const id = crypto.randomUUID();
        await env.DB.prepare(`
          INSERT INTO events (
            id, title, date, time, city, venue_name, address,
            organizer, link, source, tags, image_url, description,
            verified, source_type, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).bind(
          id,
          body.title,
          body.date || null,
          body.time || null,
          body.city,
          body.venue_name || "",
          body.address || "",
          body.organizer || "",
          body.link || "",
          "community",
          JSON.stringify(body.tags || []),
          body.image_url || "",
          body.description || "",
          0, // verified
          "community"
        ).run();

        // Clear cache so /events.json updates
        await env.EVENTS_KV.delete("events_json");

        return json({ ok: true, id });
      } catch (err) {
        return json({ error: err.message || "failed to insert" }, 500);
      }
    }

    // 🔁 Admin route: refresh feeds manually
    if (url.pathname === "/refresh" && request.method === "POST") {
      const auth = request.headers.get("x-api-key");
      if (auth !== env.ADMIN_TOKEN) return new Response("Unauthorized", { status: 401 });
      const refreshed = await refresh(env);
      return json({ ok: true, count: refreshed.length });
    }

    return new Response("OK · /events.json · /city/{city}.json · POST /api/events · POST /refresh", { status: 200 });
  },

  // ⏰ Cloudflare cron trigger
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refresh(env));
  },
};

// ---------- Helper Functions ----------
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// 🧠 Cached fetch from KV or refresh
async function getEvents(env) {
  const cached = await env.EVENTS_KV.get("events_json", "json");
  if (cached) return cached;
  const refreshed = await refresh(env);
  return refreshed;
}

// 🔄 Refresh from ICS sources + sync to D1
async function refresh(env) {
  const sources = await getSources(env);
  const all = [];

  for (const src of sources) {
    try {
      const txt = await fetch(src).then(r => (r.ok ? r.text() : ""));
      if (!txt) continue;
      const events = parseICS(txt).map(e => ({ ...e, source: src }));
      all.push(...events);
    } catch (e) {
      console.log("⚠️ fetch error", e);
    }
  }

  const now = new Date();
  const cutoff = new Date(now.getTime() + 30 * 86400 * 1000);
  const filtered = all
    .filter(e => e.start && e.start >= now && e.start <= cutoff)
    .filter(isClimate)
    .map(enrichCity)
    .sort((a, b) => a.start - b.start)
    .map(toTemplateRow);

  await env.EVENTS_KV.put("events_json", JSON.stringify(filtered), { expirationTtl: 12 * 3600 });
  await syncEventsToD1(env, filtered);

  return filtered;
}

// 🗂️ Write parsed events into D1
async function syncEventsToD1(env, events) {
  if (!env.DB) return;
  for (const e of events) {
    const id = crypto.randomUUID();
    const tags = JSON.stringify(e.tags?.split(",").map(t => t.trim()).filter(Boolean));
    await env.DB.prepare(`
      INSERT OR REPLACE INTO events
      (id, title, date, time, city, venue_name, address, organizer, link, source, tags, source_type, verified, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).bind(
      id,
      e.title || e.summary || "",
      e.date_local,
      e.time_local === "00:00" ? null : e.time_local,
      e.city || "",
      e.venue || "",
      e.address || "",
      e.host || "",
      e.link || "",
      e.source || "",
      tags,
      "feed",
      1 // verified
    ).run();
  }
}

// ---------- ICS Parsing + Helpers ----------
async function getSources(env) {
  const kv = await env.EVENTS_KV.get("ics_sources", "json");
  if (Array.isArray(kv) && kv.length) return kv;
  return [
    "https://link.climatetechlist.com/boston-climate-tech-ical-feed",
    "https://www.architects.org/events/subscribe.ics",
    "https://newiee.org/events/?ical=1",
    "https://www.mapc.org/calendar/?ical=1",
  ];
}

function parseICS(text) {
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  const events = [];
  for (const chunk of unfolded.split("BEGIN:VEVENT").slice(1)) {
    const seg = chunk.split("END:VEVENT")[0];
    const obj = {};
    for (const line of seg.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [keyRaw, ...rest] = line.split(":");
      const key = keyRaw.toUpperCase();
      const value = rest.join(":");
      if (key.startsWith("SUMMARY")) obj.summary = value;
      else if (key.startsWith("DESCRIPTION")) obj.description = value;
      else if (key.startsWith("LOCATION")) {
        obj.location = value;
        const parts = value.split(/,(.+)/);
        if (parts.length >= 2) {
          obj.venue = parts[0].trim();
          obj.address = parts[1].trim();
        }
      } else if (key.startsWith("URL")) obj.url = value;
      else if (key.startsWith("DTSTART")) obj.start = parseIcsDate(value);
    }
    events.push(obj);
  }
  return events;
}

function parseIcsDate(v) {
  if (/^\d{8}$/.test(v)) return new Date(`${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T00:00:00`);
  if (/^\d{8}T\d{6}Z$/.test(v)) return new Date(v);
  return new Date();
}

function isClimate(e) {
  const t = `${e.summary || ""} ${e.description || ""}`.toLowerCase();
  return ["climate", "energy", "decarbon", "solar", "green", "cleantech"].some(x => t.includes(x));
}

function enrichCity(e) {
  const blob = `${e.location || ""} ${e.description || ""} ${e.summary || ""}`.toLowerCase();
  let city = e.city || "";
  if (!city) {
    if (/\bboston\b/.test(blob)) city = "Boston";
    if (!city && /\bnew york\b/.test(blob)) city = "New York";
  }
  return { ...e, city };
}

function toTemplateRow(e) {
  const d = e.start;
  const date_local = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : "";
  const time_local = d ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : "";
  const host = e.source ? new URL(e.source).hostname.replace(/^www\./, "") : "";
  const tags = ["climate tech", "energy", "policy", "career", "founders"].filter(t => (e.summary + e.description).toLowerCase().includes(t.split(" ")[0])).join(",");
  return { date_local, time_local, city: e.city || "", title: e.summary || "", host, venue: e.venue || "", address: e.address || "", link: e.url || "", source: e.source || "", tags };
}
