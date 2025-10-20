export async function onRequestPost(context) {
  const { request, env } = context;
  const data = await request.json().catch(() => ({}));
  const phone = String((data.phone || "")).trim();
  const payout = String((data.payout_handle || "")).trim();
  const consent = Boolean(data.consent);

  if (!consent) return json({ error: "Consent required" }, 400);
  if (!/^\+?[1-9]\d{6,15}$/.test(phone.replace(/\s|-/g,''))) return json({ error: "Invalid phone" }, 400);
  if (!payout) return json({ error: "Missing payout handle" }, 400);

  // Ensure schema exists (idempotent)
  await ensureSchema(env.DB);

  // Insert or update lead
  const now = new Date().toISOString();
  const normalized = phone.replace(/\s|-/g,'');

  // Start transaction for link selection & lead insert
  await env.DB.exec("BEGIN IMMEDIATE;");
  try {
    const linkRow = await env.DB.prepare(
      "SELECT id, url FROM links WHERE active = 1 AND used_count < cap ORDER BY id LIMIT 1"
    ).first();

    if (!linkRow) {
      await env.DB.exec("ROLLBACK;");
      return json({ error: "No active referral link available right now. Please try later." }, 503);
    }

    let lead = await env.DB.prepare(
      "SELECT * FROM leads WHERE phone = ?"
    ).bind(normalized).first();

    if (!lead) {
      await env.DB.prepare(
        "INSERT INTO leads (phone, payout_handle, status, link_id, created_at, last_updated) VALUES (?, ?, 'LINK_SENT', ?, ?, ?)"
      ).bind(normalized, payout, linkRow.id, now, now).run();
      lead = await env.DB.prepare("SELECT * FROM leads WHERE phone = ?").bind(normalized).first();
    } else {
      // If user re-submits, keep existing link_id but update handle
      await env.DB.prepare(
        "UPDATE leads SET payout_handle = ?, last_updated = ? WHERE id = ?"
      ).bind(payout, now, lead.id).run();
    }

    await env.DB.exec("COMMIT;");

    // Compose SMS
    const brand = env.BRAND_NAME || "Easy Forty";
    const pledge = env.PLEDGE_AMOUNT || "40";
    const site = env.SITE_URL || "https://easyforty.com";
    const howto = `1) Open link 2) Sign up 3) Deposit $5 4) Reply DONE here.\n`;
    const sms = `${brand}: Here’s your unique Acorns link:\n${linkRow.url}\n\n${howto}Msg&data rates may apply. Reply HELP for help, STOP to opt out.`;

    // Send SMS via Telnyx
    await sendSMS(env, normalized, sms);

    // Log message
    await env.DB.prepare(
      "INSERT INTO messages (lead_id, direction, text, created_at) VALUES (?, 'out', ?, ?)"
    ).bind(lead.id, sms, now).run();

    return json({ ok: true });
  } catch (e) {
    await env.DB.exec("ROLLBACK;");
    return json({ error: "Server error" }, 500);
  }
}

async function sendSMS(env, to, text) {
  const res = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.TELNYX_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: env.TELNYX_FROM_NUMBER,
      to,
      text,
      messaging_profile_id: env.TELNYX_MESSAGING_PROFILE_ID || undefined
    })
  });
  if (!res.ok) {
    const err = await res.text().catch(()=>"");
    console.error("Telnyx send failed", res.status, err);
  }
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
    CREATE INDEX IF NOT EXISTS idx_links_active ON links(active);
    CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);
  `);
}
