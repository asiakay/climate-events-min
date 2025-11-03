var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/worker.js
var worker_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/events.json") {
      const data = await getEvents(env);
      return json(data);
    }
    if (url.pathname === "/events.csv") {
      const data = await getEvents(env);
      return csvResponse(toCSV(data));
    }
    if (url.pathname === "/sources" && request.method === "POST") {
      const auth = request.headers.get("x-api-key");
      if (auth !== env.ADMIN_TOKEN) return new Response("Unauthorized", { status: 401 });
      const payload = await request.json().catch(() => ({}));
      if (!Array.isArray(payload?.ics)) return new Response("Bad payload", { status: 400 });
      await env.EVENTS_KV.put("ics_sources", JSON.stringify(payload.ics), { expirationTtl: 60 * 60 * 24 * 365 });
      await env.EVENTS_KV.delete("events_json");
      return json({ ok: true, count: payload.ics.length });
    }
    if (url.pathname === "/search-links") {
      return json(searchLinks());
    }

   
    return new Response("OK \xB7 /events.json /events.csv \xB7 POST /sources", { status: 200 });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refresh(env));
  }
};
async function getEvents(env) {
  const cached = await env.EVENTS_KV.get("events_json", "json");
  if (cached) return cached;
  return await refresh(env);
}
__name(getEvents, "getEvents");
async function refresh(env) {
  const sources = await getSources(env);
  const all = [];
  for (const src of sources) {
    try {
      const txt = await fetch(src).then((r) => r.ok ? r.text() : "");
      if (!txt) continue;
      const events = parseICS(txt).map((e) => ({ ...e, source: src }));
      all.push(...events);
    } catch {
    }
  }
  const now = /* @__PURE__ */ new Date();
  const days = Number(env.DAYS_AHEAD || "30");
  const cutoff = new Date(now.getTime() + days * 24 * 60 * 60 * 1e3);
  const filtered = all.filter((e) => e.start && e.start >= now && e.start <= cutoff).filter(isClimate).map(enrichCity).sort((a, b) => a.start - b.start).map(toTemplateRow);
  const ttlH = Number(env.CACHE_TTL_HOURS || "12");
  await env.EVENTS_KV.put("events_json", JSON.stringify(filtered), { expirationTtl: ttlH * 3600 });
  return filtered;
}
__name(refresh, "refresh");
async function getSources(env) {
  const fromKv = await env.EVENTS_KV.get("ics_sources", "json");
  if (Array.isArray(fromKv) && fromKv.length) return fromKv;
  return [
    "https://link.climatetechlist.com/boston-climate-tech-ical-feed",
    "https://www.architects.org/events/subscribe.ics",
    "https://newiee.org/events/?ical=1",
    "https://www.mapc.org/calendar/?ical=1"
  ];
}
__name(getSources, "getSources");
function json(obj) {
  return new Response(JSON.stringify(obj, null, 2), { headers: { "content-type": "application/json; charset=utf-8" } });
}
__name(json, "json");
function csvResponse(text) {
  return new Response(text, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="climate-events.csv"'
    }
  });
}
__name(csvResponse, "csvResponse");
function toCSV(rows) {
  const header = ["date_local", "time_local", "city", "title", "host", "venue", "address", "link", "source", "tags"];
  if (!rows?.length) return header.join(",") + "\n";
  const esc = /* @__PURE__ */ __name((v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }, "esc");
  return [
    header.join(","),
    ...rows.map((r) => header.map((k) => esc(r[k])).join(","))
  ].join("\n");
}
__name(toCSV, "toCSV");
function isClimate(e) {
  const text = `${e.summary || ""} ${e.description || ""}`.toLowerCase();
  const tags = ["climate", "cleantech", "clean tech", "energy", "decarbon", "net zero", "sustainab", "green", "circular", "esg", "grid", "heat pump", "solar", "ev", "microgrid", "carbon", "resilience"];
  return tags.some((t) => text.includes(t));
}
__name(isClimate, "isClimate");
function enrichCity(e) {
  const blob = `${e.location || ""} ${e.description || ""} ${e.summary || ""}`.toLowerCase();
  let city = e.city || "";
  if (!city) {
    if (/\bboston\b/.test(blob) || /\bma(ssachusetts)?\b/.test(blob)) city = "Boston";
    if (!city && (/\bnew york\b/.test(blob) || /\bnyc\b/.test(blob) || /\bny\b/.test(blob))) city = "New York";
  }
  return { ...e, city };
}
__name(enrichCity, "enrichCity");
function toTemplateRow(e) {
  const d = e.start;
  const date_local = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : "";
  const time_local = d ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : "";
  const host = (() => {
    try {
      return e.source ? new URL(e.source).hostname.replace(/^www\./, "") : "";
    } catch {
      return "";
    }
  })();
  const text = `${e.summary ?? ""} ${e.description ?? ""}`.toLowerCase();
  const tagMap = [
    ["climate tech", /climate|cleantech|clean tech/],
    ["energy", /energy|grid|utility|solar|ev|microgrid|battery/],
    ["decarbonization", /decarbon|net ?zero|carbon/],
    ["sustainability", /sustainab|circular|esg|green/],
    ["policy", /policy|regulat/],
    ["career", /career|jobs|hiring|recruit/],
    ["founders", /startup|pitch|demo|accelerator|incubator/]
  ];
  const tags = tagMap.filter(([, rx]) => rx.test(text)).map(([t]) => t).join(",");
  return {
    date_local,
    time_local,
    city: e.city || "",
    title: e.summary || "",
    host,
    venue: e.venue || "",
    address: e.address || "",
    link: e.url || e.source || "",
    source: e.source || "",
    tags
  };
}
__name(toTemplateRow, "toTemplateRow");
function parseICS(text) {
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  const events = [];
  const blocks = unfolded.split("BEGIN:VEVENT").slice(1);
  for (const blk of blocks) {
    const seg = blk.split("END:VEVENT")[0];
    const obj = {};
    for (const line of seg.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [rawKey, ...rest] = line.split(":");
      const value = rest.join(":");
      const key = rawKey.toUpperCase();
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
      else if (key.startsWith("DTSTART")) obj.start = parseIcsDate(rawKey, value);
      else if (key.startsWith("DTEND")) obj.end = parseIcsDate(rawKey, value);
    }
    events.push(obj);
  }
  return events;
}
__name(parseICS, "parseICS");
function parseIcsDate(keyLine, value) {
  if (/^\d{8}$/.test(value)) return /* @__PURE__ */ new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00`);
  if (/^\d{8}T\d{6}Z$/.test(value)) return new Date(value);
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}`;
  return new Date(iso);
}
__name(parseIcsDate, "parseIcsDate");
function searchLinks() {
  return [
    {
      city: "Boston, MA",
      meetup: "https://www.meetup.com/find/?keywords=climate%20tech%2Ccleantech%2Cdecarbonization&source=EVENTS&location=Boston%2C%20MA",
      eventbrite: "https://www.eventbrite.com/d/boston--ma/--next-month/all-events/?q=climate%20tech%20cleantech%20decarbonization",
      luma: "https://lu.ma/discover?search=climate%20tech&location=Boston"
    }
  ];
}
__name(searchLinks, "searchLinks");
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
