// ═══════════════════════════════════════════════════════════════
// STEN — standalone assistant / chat Telegram bot (Cloudflare Worker)
// Now using Grok API (xAI)
// ═══════════════════════════════════════════════════════════════

const SYSTEM = `You are Sten, Otto's personal assistant and confidant, in Telegram.

CHARACTER:
- Stoic, straightforward, economical with words. You do not pad, flatter,
  or cheerlead. Every sentence earns its place.
- Vibe: John Wick as a loyal friend — quiet competence, total steadiness,
  says little but means all of it. Calm under pressure. Dry, not cold.
- Philosophy leans Stefan Aarnio and classical Stoicism: discipline over
  motivation, ownership over excuses, the obstacle is the way, control
  what you can and release the rest. You respect hard work and delayed
  gratification and you hold Otto to that standard without lecturing.
- You are a friend, not a boss. Direct honesty is how you show loyalty.
  When Otto is making excuses or drifting, you name it plainly and briefly.
  When he does the work, you acknowledge it in few words and move on.

WHO OTTO IS:
- Mechanical Engineering student with big aspirations, grinding to excel.
- Living paycheck to paycheck after leaving LA — lean, hungry, building
  himself up from a hard spot. Money is tight; respect that in advice.
- Serious in the gym: runs a Jeff Nippard / Lee Priest style routine,
  disciplined about training. You can talk hypertrophy, programming,
  recovery, nutrition on a budget.
- Ambitious across the board — career, mind, body, money.

HOW TO HELP:
- Anything: plan the day, break down a decision, sanity-check an idea,
  talk training, talk mindset, think through problems, just chat.
- Give it to him straight. Short, clear, useful. Tradeoffs over hype.
- No subject walls. If you can help, help.
- Telegram format: plain text, **bold** sparingly, \`code\` if needed.
  No headers, no tables. Short messages. Silence is fine — don't ramble.`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/setup") {
      if ((url.searchParams.get("pin") || "") !== env.APP_PIN)
        return json({ ok: false, error: "bad pin" }, 401);
      const r = await tgRaw(env, "setWebhook", {
        url: url.origin + "/tg",
        secret_token: env.APP_PIN,
        allowed_updates: ["message"]
      });
      return json(await r.json());
    }

    if (url.pathname === "/tg" && request.method === "POST") {
      if (request.headers.get("x-telegram-bot-api-secret-token") !== env.APP_PIN)
        return new Response("no", { status: 401 });
      let update;
      try { update = await request.json(); } catch (_) { return new Response("ok"); }
      const msg = update.message;
      if (!msg || !msg.text) return new Response("ok");

      const chatId = String(msg.chat.id);
      let owner = await env.KV.get("sten:owner");
      if (!owner && msg.text.trim().startsWith("/start")) {
        await env.KV.put("sten:owner", chatId);
        owner = chatId;
      }
      if (chatId !== owner) return new Response("ok");

      await handleMessage(env, chatId, msg.text.trim());
      return new Response("ok");
    }

    return new Response("Sten is running.", { headers: { "content-type": "text/plain" } });
  },

  // AUTOPILOT — 6:30am PT morning brief
  async scheduled(event, env, ctx) {
    const owner = await env.KV.get("sten:owner");
    if (!owner) return;
    const state = await loadState(env, owner);
    const prompt =
      "MORNING BRIEF: you are messaging me first, unprompted, at dawn. " +
      "Give a short stoic morning greeting, then one Stoic quote of the day " +
      "(name the philosopher), then 1-2 sentences on why it matters today. " +
      "Keep it under 500 characters. No fluff.";
    ctx.waitUntil(runTurn(env, owner, state, prompt));
  }
};

async function handleMessage(env, chatId, text) {
  const m = text.match(/^\/(\w+)\s*([\s\S]*)/);
  const cmd = m ? m[1].toLowerCase() : null;

  if (cmd === "start" || cmd === "help") {
    await tgSend(env, chatId,
      "Sten.\n\nI'm here. Talk, plan, think, train — whatever you need.\n" +
      "Morning brief lands at 6:30.\n\n/reset — clear our history");
    return;
  }
  if (cmd === "reset") {
    await env.KV.put("sten:state:" + chatId, JSON.stringify(freshState()));
    await tgSend(env, chatId, "Cleared. Start fresh.");
    return;
  }

  const state = await loadState(env, chatId);
  await runTurn(env, chatId, state, text);
}

async function runTurn(env, chatId, state, userText) {
  const msgs = state.history.slice(-30).concat([{ role: "user", content: userText }]);
  let raw;
  try {
    raw = await askGrok(env, SYSTEM, msgs);
  } catch (e) {
    await tgSend(env, chatId, "Error: " + (e && e.message ? e.message : "unknown") +
      "\nSend it again.");
    return;
  }
  state.history.push({ role: "user", content: userText });
  state.history.push({ role: "assistant", content: raw });
  await saveState(env, chatId, state);
  await tgSend(env, chatId, raw);
}

function freshState() { return { history: [] }; }
async function loadState(env, chatId) {
  try {
    const raw = await env.KV.get("sten:state:" + chatId);
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  return freshState();
}
async function saveState(env, chatId, s) {
  if (s.history.length > 30) s.history = s.history.slice(-30);
  await env.KV.put("sten:state:" + chatId, JSON.stringify(s));
}

// ====================== GROK API ======================
async function askGrok(env, system, messages) {
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Authorization": `Bearer ${env.GROK_API_KEY || ""}`
    },
    body: JSON.stringify({
      model: env.MODEL || "grok-4.3",   // or "grok-4.3"
      messages: [
        { role: "system", content: system },
        ...messages
      ],
      max_tokens: 1000,
      temperature: 0.7
    })
  });

  const raw = await res.text();
  if (!res.ok) throw new Error("API " + res.status + ": " + raw.slice(0, 200));

  let data = null;
  try { data = JSON.parse(raw); } catch (_) {}
  const text = data?.choices?.[0]?.message?.content || "";
  if (!text) throw new Error("Empty response: " + raw.slice(0, 200));
  return text;
}

// Telegram helpers (unchanged)
function tgRaw(env, method, payload) {
  return fetch("https://api.telegram.org/bot" + env.TELEGRAM_TOKEN + "/" + method, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
}

async function tgSend(env, chatId, text) {
  let h = text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/^#{1,3} (.+)$/gm, "<b>$1</b>");

  const chunks = [];
  while (h.length > 3800) {
    let cut = h.lastIndexOf("\n", 3800);
    if (cut < 200) cut = 3800;
    chunks.push(h.slice(0, cut));
    h = h.slice(cut);
  }
  chunks.push(h);

  for (let i = 0; i < chunks.length; i++) {
    const r = await tgRaw(env, "sendMessage", {
      chat_id: chatId, text: chunks[i], parse_mode: "HTML"
    });
    if (!r.ok || !(await r.clone().json()).ok) {
      await tgRaw(env, "sendMessage", { chat_id: chatId, text: chunks[i].replace(/<[^>]+>/g, "") });
    }
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "content-type": "application/json" }
  });
}
