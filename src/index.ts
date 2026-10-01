import { createMcpHandler } from "@modelcontextprotocol/server";
import type { Env } from "./db";
import * as db from "./db";
import { buildServer } from "./server";
import { runTurn, ALLOWED_MODELS, MODEL } from "./agent";
import { checkService, SERVICES, type ServiceStatus } from "./status";

function wsOf(req: Request): string {
  const u = new URL(req.url);
  return db.cleanWs(u.searchParams.get("ws") ?? req.headers.get("x-deskside-workspace"));
}

function mcp(env: Env, req: Request): Promise<Response> {
  const ws = wsOf(req);
  return createMcpHandler(() => buildServer(env, ws), { onerror: (e) => console.error("mcp", e.message) }).fetch(req);
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) return mcp(env, req);

    if (url.pathname === "/api/chat" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as {
        ws?: string;
        model?: string;
        messages?: { role: "user" | "assistant"; content: string }[];
      } | null;
      if (!body?.messages?.length) return json({ error: "messages required" }, 400);
      const history = body.messages
        .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .map((m) => ({ role: m.role, content: m.content.slice(0, 1000) }));
      try {
        const model = body.model && ALLOWED_MODELS.includes(body.model) ? body.model : MODEL;
        let out;
        try {
          out = await runTurn(env, (r) => mcp(env, r), url.origin, db.cleanWs(body.ws), history, model);
        } catch (e) {
          // D1 occasionally answers "overloaded" for a few seconds; one retry covers it.
          if (!/overloaded|D1_ERROR/i.test((e as Error).message)) throw e;
          await new Promise((r) => setTimeout(r, 1500));
          out = await runTurn(env, (r) => mcp(env, r), url.origin, db.cleanWs(body.ws), history, model);
        }
        return json(out);
      } catch (e) {
        console.error("chat", (e as Error).stack);
        return json(
          { reply: "Sorry, something went wrong on my side. Try again in a moment.", error: (e as Error).message, cards: [], trace: [] },
          200,
        );
      }
    }

    if (url.pathname === "/api/state") {
      const ws = wsOf(req);
      try {
        const [tickets, devices, events, services] = await Promise.all([
          db.listTickets(env, ws),
          db.listDevices(env, ws),
          db.recentEvents(env, ws, 25),
          db.getServices(env, ws),
        ]);
        return json({ ws, tickets, devices, events, services });
      } catch (e) {
        return json({ ws, tickets: [], devices: [], events: [], services: [], error: (e as Error).message }, 503);
      }
    }

    if (url.pathname === "/api/reset" && req.method === "POST") {
      const ws = wsOf(req);
      if (ws === "demo") return json({ error: "the shared demo workspace cannot be reset" }, 403);
      await env.DB.batch(
        ["tickets", "devices", "sessions", "services", "events"].map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE ws = ?`).bind(ws)),
      );
      return json({ ok: true });
    }

    return env.ASSETS.fetch(req);
  },

  // The watcher: every ten minutes, re-read the status of every service a ticket is watching,
  // note recoveries on the ticket, and run scheduled follow-ups. This is what lets Deskside say
  // "while you were away, Zoom came back" in the next conversation.
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext) {
    const nowIso = db.now();
    const { results: watched } = await env.DB.prepare(
      "SELECT * FROM tickets WHERE status IN ('open','waiting') AND (watch_service IS NOT NULL OR (followup_at IS NOT NULL AND followup_at <= ?)) LIMIT 200",
    )
      .bind(nowIso)
      .all<any>();
    if (!watched.length) return;
    const keys = [...new Set(watched.map((t) => t.watch_service).filter((k): k is string => !!k && !!SERVICES[k]))];
    const statuses = new Map<string, ServiceStatus>();
    for (const k of keys) statuses.set(k, await checkService(k));

    for (const t of watched) {
      const st = t.watch_service ? statuses.get(t.watch_service) : undefined;
      if (st && st.health === "operational" && t.watch_since_status && t.watch_since_status !== "operational") {
        await db.updateTicket(env, t.ws, t.num ?? t.id, {
          status: "resolved",
          note: `${st.name} reports it is working again (checked ${nowIso}). Try again; close the ticket if it works.`,
          watch_service: null,
          watch_since_status: "operational",
        });
        await db.addEvent(env, t.ws, "watch", `${st.name} is working again, so ticket ${t.num ?? t.id} is marked resolved.`);
      } else if (st && st.health !== t.watch_since_status && st.health !== "unknown") {
        await db.updateTicket(env, t.ws, t.num ?? t.id, { note: `${st.name} status changed to ${st.health}`, watch_since_status: st.health });
      }
      if (t.followup_at && t.followup_at <= nowIso) {
        const note = st ? `Follow-up: ${st.name} is ${st.health}.` : "Follow-up time reached: ask whether the problem is still happening.";
        await db.updateTicket(env, t.ws, t.num ?? t.id, { note, followup_at: null });
        await db.addEvent(env, t.ws, "followup", `Ticket ${t.num ?? t.id} follow-up: ${note}`);
      }
    }
  },
};
