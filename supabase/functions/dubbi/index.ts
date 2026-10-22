// Supabase Edge Function "dubbi" — the voice assistant's brain.
//   POST { text?, execute?, cancel?, conversation_id? }
//   Auth: the app sends your VaPiq session (Authorization: Bearer …);
//         the Siri Shortcut sends your personal Siri key (x-dubbi-token).
// Secrets (Supabase → Edge Functions → Secrets): ANTHROPIC_API_KEY.
// Set DUBBI_AI=off to switch the AI off without redeploying.
import Anthropic from "npm:@anthropic-ai/sdk@0.132.0";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { createDubbi } from "./core.js";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "sb_publishable_gcyK2z_8lvbOgHNcJfdX1g_8QCWJ_Xi";
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ALLOWED = [/^https:\/\/aatomasi-bot\.github\.io$/, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];

function cors(origin: string | null): Record<string, string> {
  const ok = origin && ALLOWED.some((re) => re.test(origin));
  return {
    "Access-Control-Allow-Origin": ok ? origin! : "https://aatomasi-bot.github.io",
    "Access-Control-Allow-Headers": "authorization, x-dubbi-token, content-type, apikey, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
const json = (body: unknown, status: number, h: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { ...h, "Content-Type": "application/json" } });

async function sha256(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  const h = cors(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: h });
  if (req.method !== "POST") return json({ error: "POST only" }, 405, h);

  // ── Who is asking ──
  const siriKey = req.headers.get("x-dubbi-token");
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  let sb, user, source: "app" | "siri";
  if (siriKey) {
    if (!SERVICE) return json({ reply: "Siri isn't set up on the server yet." }, 500, h);
    const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } });
    const { data: row } = await admin.from("dubbi_tokens").select("id,user_id").eq("token_hash", await sha256(siriKey)).maybeSingle();
    if (!row) return json({ reply: "This Siri key isn't valid any more. Create a new one in the Dubbi app." }, 401, h);
    await admin.from("dubbi_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", row.id);
    const { data: u } = await admin.auth.admin.getUserById(row.user_id);
    if (!u?.user) return json({ reply: "Unknown user." }, 401, h);
    sb = admin; user = u.user; source = "siri";
  } else if (bearer) {
    sb = createClient(URL_, ANON, { global: { headers: { Authorization: `Bearer ${bearer}` } }, auth: { persistSession: false } });
    const { data, error } = await sb.auth.getUser(bearer);
    if (error || !data.user) return json({ reply: "Please sign in again." }, 401, h);
    user = data.user; source = "app";
  } else {
    return json({ reply: "Not signed in." }, 401, h);
  }

  if ((Deno.env.get("DUBBI_AI") || "").toLowerCase() === "off") {
    return json({ reply: "Dubbi's AI is switched off right now. You can still use the app." }, 200, h);
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body */ }
  const dubbi = createDubbi({ sb, anthropic: new Anthropic(), userId: user.id, userEmail: user.email, log: console.warn });
  try {
    const out = await dubbi.handle({
      text: String(body.text ?? "").slice(0, 2000),
      execute: body.execute ?? null, cancel: body.cancel ?? null,
      conversationId: body.conversation_id ?? null, source,
    });
    return json(out, 200, h);
  } catch (e) {
    console.error("[dubbi]", e);
    const busy = e instanceof Anthropic.RateLimitError || (e instanceof Anthropic.APIError && (e.status ?? 0) >= 500);
    return json({ reply: busy ? "I'm a bit busy — please try again in a moment." : "Something went wrong on my side. Please try again." }, 502, h);
  }
});
