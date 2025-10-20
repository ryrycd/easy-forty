// GET /admin/summary  (with X-ADMIN-KEY header) returns basic stats
export async function onRequest(context) {
  const { request, env } = context;
  const key = request.headers.get("x-admin-key");
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
    return new Response("Unauthorized", { status: 401 });
  }
  const url = new URL(request.url);
  const path = url.pathname;

  await ensureSchema(env.DB);

  if (path.endsWith("/summary")) {
    const totalLeads = await env.DB.prepare("SELECT COUNT(*) as c FROM leads").first();
    const verified = await env.DB.prepare("SELECT COUNT(*) as c FROM leads WHERE status = 'VERIFIED'").first();
    const activeLink = await env.DB.prepare("SELECT id, url, cap, used_count FROM links WHERE active = 1 LIMIT 1").first();
    const links = await env.DB.prepare("SELECT id, url, cap, used_count, active FROM links ORDER BY id").all();

    return json({ totalLeads: totalLeads?.c || 0, verified: verified?.c || 0, activeLink, links: links?.results || [] });
  }

  if (path.endsWith("/seed") && request.method === "POST") {
    const body = await request.json().catch(()=>({}));
    const links = Array.isArray(body.links) ? body.links : [];
    if (!links.length) return json({ error: "Provide {links:[{url,cap}]}" }, 400);
    await env.DB.exec("BEGIN IMMEDIATE;");
    try {
      for (const l of links) {
        if (!l.url || !l.cap) continue;
        await env.DB.prepare("INSERT INTO links (url, cap, active) VALUES (?, ?, 0)").bind(String(l.url), Number(l.cap)).run();
      }
      // If no active link exists, set the first as active
      const active = await env.DB.prepare("SELECT 1 a FROM links WHERE active = 1 LIMIT 1").first();
      if (!active) {
        const first = await env.DB.prepare("SELECT id FROM links ORDER BY id LIMIT 1").first();
        if (first?.id) await env.DB.prepare("UPDATE links SET active = 1 WHERE id = ?").bind(first.id).run();
      }
      await env.DB.exec("COMMIT;");
      return json({ ok: true });
    } catch (e) {
      await env.DB.exec("ROLLBACK;");
      return json({ error: "seed error" }, 500);
    }
  }

  return new Response("Not found", { status: 404 });
}

function json(obj, status=200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

async function ensureSchema(DB){
  await DB.exec(`
    CREATE TABLE IF NOT EXISTS links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      cap INTEGER NOT NULL,
      used_count INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT UNIQUE NOT NULL,
      payout_handle TEXT,
      status TEXT NOT NULL DEFAULT 'LINK_SENT',
      link_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_updated TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (link_id) REFERENCES links(id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER,
      direction TEXT,
      text TEXT,
      media_url TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER,
      r2_key TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
