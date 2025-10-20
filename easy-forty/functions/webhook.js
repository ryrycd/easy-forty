export async function onRequestPost(context) {
  const { request, env } = context;
  const raw = await request.text();
  // Verify Telnyx signature if configured
  if (env.TELNYX_PUBLIC_KEY) {
    const ts = request.headers.get("telnyx-timestamp");
    const sig = request.headers.get("telnyx-signature-ed25519");
    const ok = await verifyEd25519(env.TELNYX_PUBLIC_KEY, ts ? (ts + "|" + raw) : raw, sig);
    if (!ok) return new Response("invalid signature", { status: 401 });
  }

  const body = JSON.parse(raw || "{}");
  const event = body.data || body; // be flexible
  const payload = event.payload || event.data || {};
  const text = (payload.text || payload.body || "").trim();
  const from = (payload.from?.phone_number || payload.from || payload.sender || "").trim();
  const to = (payload.to?.[0]?.phone_number || payload.to || "").toString().trim();
  const direction = (payload.direction || "").toLowerCase();
  const media = payload.media || payload.media_urls || payload.parts || [];

  // We only handle inbound messages
  if (direction && direction !== "inbound" && direction !== "in") {
    return new Response("ok", { status: 200 });
  }

  const now = new Date().toISOString();
  await ensureSchema(env.DB);

  // Lookup lead by phone
  const phone = from.replace(/\s|-/g,'');
  const lead = await env.DB.prepare("SELECT * FROM leads WHERE phone = ?").bind(phone).first();

  // Handle keywords (STOP is auto-handled by Toll-Free network but we record opt-out)
  const upper = text.toUpperCase();
  if (["STOP", "CANCEL", "END", "QUIT", "UNSUBSCRIBE", "STOPALL"].includes(upper)) {
    if (lead) {
      await env.DB.prepare("UPDATE leads SET status = 'OPTED_OUT', last_updated = ? WHERE id = ?").bind(now, lead.id).run();
    }
    return new Response("ok", { status: 200 });
  }

  if (upper === "HELP") {
    const help = `${env.BRAND_NAME||"Easy Forty"} help: We text your link, you sign up & deposit $5, then reply DONE and send a screenshot. Questions? ${env.SUPPORT_EMAIL||"support@easyforty.com"}. Reply STOP to opt out.`;
    if (from) await sendSMS(env, from, help);
    return new Response("ok", { status: 200 });
  }

  if (upper === "DONE") {
    if (lead) {
      await env.DB.prepare("UPDATE leads SET status = 'REPLIED_DONE', last_updated = ? WHERE id = ?").bind(now, lead.id).run();
      const ask = "Great! Please reply with an MMS screenshot showing your $5 deposit so we can verify.";
      await sendSMS(env, from, ask);
      await env.DB.prepare("INSERT INTO messages (lead_id, direction, text, created_at) VALUES (?, 'out', ?, ?)").bind(lead.id, ask, now).run();
    } else {
      await sendSMS(env, from, "We couldn't find your number in our system. Please resubmit the form at https://easyforty.com");
    }
    return new Response("ok", { status: 200 });
  }

  // Detect MMS proof
  const mediaList = Array.isArray(media) ? media : [];
  if (mediaList.length > 0 && lead) {
    const keys = [];
    for (let i=0; i<mediaList.length; i++) {
      const item = mediaList[i];
      const url = (item.url || item.media_url || item) + "";
      if (!url) continue;
      // Fetch the media (Telnyx may require auth for some URLs)
      const headers = {};
      if (url.includes("telnyx.com") && env.TELNYX_API_KEY) {
        headers["Authorization"] = `Bearer ${env.TELNYX_API_KEY}`;
      }
      const res = await fetch(url, { headers });
      if (res.ok) {
        const key = `leads/${lead.id}/${Date.now()}_${i}`;
        await env.PROOFS.put(key, await res.arrayBuffer());
        await env.DB.prepare("INSERT INTO evidence (lead_id, r2_key, created_at) VALUES (?, ?, ?)").bind(lead.id, key, now).run();
        keys.push(key);
      }
      await env.DB.prepare("INSERT INTO messages (lead_id, direction, text, media_url, created_at) VALUES (?, 'in', ?, ?, ?)").bind(lead.id, text || "(media)", url, now).run();
    }

    // Mark verified and rotate if needed
    await env.DB.exec("BEGIN IMMEDIATE;");
    try {
      await env.DB.prepare("UPDATE leads SET status = 'VERIFIED', last_updated = ? WHERE id = ?").bind(now, lead.id).run();

      const link = await env.DB.prepare("SELECT * FROM links WHERE id = ?").bind(lead.link_id).first();
      if (link) {
        const newCount = (link.used_count || 0) + 1;
        await env.DB.prepare("UPDATE links SET used_count = ? WHERE id = ?").bind(newCount, link.id).run();
        if (newCount >= link.cap && link.active === 1) {
          await env.DB.prepare("UPDATE links SET active = 0 WHERE id = ?").bind(link.id).run();
          const next = await env.DB.prepare("SELECT id FROM links WHERE used_count < cap AND active = 0 ORDER BY id LIMIT 1").first();
          if (next && next.id) {
            await env.DB.prepare("UPDATE links SET active = 1 WHERE id = ?").bind(next.id).run();
          }
        }
      }
      await env.DB.exec("COMMIT;");
    } catch (e) {
      await env.DB.exec("ROLLBACK;");
      console.error("rotate error", e);
    }

    // Notify user
    const msg = `Thanks! We received your screenshot and marked you VERIFIED. We'll send your payout to ${lead.payout_handle} soon.`;
    await sendSMS(env, from, msg);
    return new Response("ok", { status: 200 });
  }

  // Log any other inbound text
  if (lead) {
    await env.DB.prepare("INSERT INTO messages (lead_id, direction, text, created_at) VALUES (?, 'in', ?, ?)").bind(lead.id, text, now).run();
  }

  return new Response("ok", { status: 200 });
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

async function verifyEd25519(pemOrRaw, message, signatureB64) {
  try {
    if (!signatureB64) return false;
    const sig = Uint8Array.from(atob(signatureB64), c => c.charCodeAt(0));
    let raw;
    if (pemOrRaw.includes("BEGIN PUBLIC KEY")) {
      // Convert PEM to raw
      const b64 = pemOrRaw.replace(/-----.*?-----/g, "").replace(/\s/g, "");
      const der = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      // Minimal ASN.1 parsing is complex; assume env provides raw base64 if PEM fails
      raw = der;
    } else {
      raw = Uint8Array.from(atob(pemOrRaw), c => c.charCodeAt(0));
    }
    const key = await crypto.subtle.importKey(
      "raw",
      raw,
      { name: "Ed25519", namedCurve: "Ed25519" },
      false,
      ["verify"]
    );
    const enc = new TextEncoder();
    const ok = await crypto.subtle.verify({ name: "Ed25519" }, key, sig, enc.encode(message));
    return !!ok;
  } catch (e) {
    console.error("verify error", e);
    return false;
  }
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
