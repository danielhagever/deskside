// Deskside MCP server: a home and small-office IT help desk for Alexa+.
// Spec 2025-11-25 and 2026-07-28 over Streamable HTTP (via createMcpHandler).

import { McpServer } from "@modelcontextprotocol/server";
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import type { Env } from "./db";
import * as db from "./db";
import { SERVICES, checkService, resolveService, spokenStatus, type ServiceStatus } from "./status";
import { PLAYBOOKS, pickPlaybook, matchAnswer } from "./playbooks";
import boardHtml from "./ui/board.html";
import appBundle from "./ui/app-bundle.txt";

const BOARD_URI = "ui://deskside/board.html";
const PRIORITY = z.enum(["low", "normal", "high", "urgent"]);
const SERVICE_KEYS = Object.keys(SERVICES);

type Result = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

const reply = (spoken: string, data: Record<string, unknown> = {}): Result => ({
  content: [{ type: "text", text: spoken }],
  structuredContent: { spoken, ...data },
});
const fail = (spoken: string): Result => ({ content: [{ type: "text", text: spoken }], isError: true });

async function statusFor(keys: string[]): Promise<ServiceStatus[]> {
  return Promise.all(keys.map((k) => checkService(k)));
}

export function buildServer(env: Env, wsRaw: string): McpServer {
  const ws = db.cleanWs(wsRaw);
  const server = new McpServer(
    { name: "deskside", version: "0.1.0", title: "Deskside: help desk for Alexa+" },
    {
      instructions:
        "Deskside is a voice-first IT help desk for a household or small office. Keep spoken answers short. " +
        "When someone reports a problem with an online service, call check_service_status first, because an outage means it is not their fault. " +
        "For device or connection problems, use start_troubleshooting and then answer_troubleshooting one step at a time; it remembers where the person stopped, even days later. " +
        "Open a ticket when a fix needs hands on the device. Start a conversation with tech_briefing when the person asks how things are.",
    },
  );

  registerAppResource(server, "Deskside board", BOARD_URI, { description: "Live board of service health and open tickets" }, async () => ({
    contents: [{ uri: BOARD_URI, mimeType: RESOURCE_MIME_TYPE, text: boardHtml.replace("/*__APP_BUNDLE__*/", () => appBundle) }],
  }));

  // 1. Is it down, or is it me?
  server.registerTool(
    "check_service_status",
    {
      title: "Check if an online service is down",
      description: `Reads the vendor's official status page right now. Use it whenever someone says an app or website isn't working. Known services: ${SERVICE_KEYS.join(", ")}; common names like Gmail, Outlook, Jira or ChatGPT also work.`,
      inputSchema: z.object({ service: z.string().describe("Service name as the person said it, e.g. 'Zoom' or 'Gmail'") }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ service }) => {
      const key = resolveService(service);
      if (!key)
        return fail(
          `I don't have a status feed for ${service} yet. I can check ${Object.values(SERVICES)
            .map((s) => s.name)
            .join(", ")}.`,
        );
      const s = await checkService(key);
      await db.addEvent(env, ws, "status", `Checked ${s.name}: ${s.health}`);
      return reply(spokenStatus(s), { services: [s] });
    },
  );

  // 2. Guided troubleshooting that survives across sessions.
  server.registerTool(
    "start_troubleshooting",
    {
      title: "Start or resume a guided fix",
      description: `Starts a step-by-step fix for a problem described in plain words, or resumes the one already in progress. Problems covered: ${Object.values(
        PLAYBOOKS,
      )
        .map((p) => p.title)
        .join("; ")}.`,
      inputSchema: z.object({
        problem: z.string().describe("The problem in the person's words, e.g. 'the printer says offline'"),
        device: z.string().optional().describe("Which device, if known, e.g. 'office printer'"),
      }),
    },
    async ({ problem, device }) => {
      const key = pickPlaybook(problem);
      if (!key) {
        const t = await db.createTicket(env, ws, { summary: problem.slice(0, 120), details: `Reported by voice: ${problem}`, device });
        return reply(`I don't have a guided fix for that yet, so I opened ticket number ${t.id} with your description.`, { ticket: t });
      }
      const pb = PLAYBOOKS[key];
      const existing = await env.DB.prepare(
        "SELECT * FROM sessions WHERE ws = ? AND playbook = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1",
      )
        .bind(ws, key)
        .first<any>();
      if (existing) {
        const node = pb.nodes[existing.node];
        const trail = JSON.parse(existing.trail);
        return reply(
          `We already started on this ${timeAgo(existing.updated_at)} and got through ${trail.length} step${trail.length === 1 ? "" : "s"}. Picking up where we stopped: ${node.say}`,
          { session_id: existing.id, playbook: pb.title, step: existing.node, resumed: true },
        );
      }
      const id = crypto.randomUUID().slice(0, 8);
      const at = db.now();
      await env.DB.prepare(
        "INSERT INTO sessions (id, ws, playbook, node, device, trail, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '[]', ?, ?)",
      )
        .bind(id, ws, key, pb.start, device ?? "", at, at)
        .run();
      if (device)
        await db.upsertDevice(env, ws, { name: device, kind: key === "printer" ? "printer" : key === "internet" ? "router" : "other" });
      return reply(`Let's fix it together. ${pb.nodes[pb.start].say}`, {
        session_id: id,
        playbook: pb.title,
        step: pb.start,
        resumed: false,
      });
    },
  );

  server.registerTool(
    "answer_troubleshooting",
    {
      title: "Answer the current troubleshooting step",
      description:
        "Passes the person's answer to the step they were asked (yes, no, or the option they named) and returns the next step. Opens a ticket automatically when the fix needs hands on the device.",
      inputSchema: z.object({
        answer: z.string().describe("What the person answered, e.g. 'yes', 'no, still nothing', 'all devices', 'gmail'"),
        session_id: z.string().optional().describe("Session id from start_troubleshooting; omit to use the most recent active session"),
      }),
    },
    async ({ answer, session_id }) => {
      const s = session_id
        ? await env.DB.prepare("SELECT * FROM sessions WHERE ws = ? AND id = ?").bind(ws, session_id).first<any>()
        : await env.DB.prepare("SELECT * FROM sessions WHERE ws = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1")
            .bind(ws)
            .first<any>();
      if (!s || s.status !== "active") return fail("There is no troubleshooting in progress. Tell me what's wrong and I'll start one.");
      const pb = PLAYBOOKS[s.playbook];
      let nodeId: string = s.node;
      const trail = JSON.parse(s.trail) as { node: string; answer: string; at: string }[];
      const key = matchAnswer(pb.nodes[nodeId], answer);
      if (!key) {
        const options = Object.keys(pb.nodes[nodeId].answers ?? {}).join(" or ");
        return reply(`Sorry, I need a ${options} for this one. ${pb.nodes[nodeId].say}`, { session_id: s.id, step: nodeId });
      }
      trail.push({ node: nodeId, answer, at: db.now() });
      nodeId = pb.nodes[nodeId].answers![key];
      const spokenParts: string[] = [];
      const services: ServiceStatus[] = [];
      // Run live status checks inline, then keep walking.
      while (pb.nodes[nodeId].check) {
        const st = await checkService(pb.nodes[nodeId].check!);
        services.push(st);
        spokenParts.push(spokenStatus(st));
        if (st.health === "outage" || st.health === "degraded") {
          const t = await db.createTicket(env, ws, {
            summary: `${st.name} problem during ${pb.title.toLowerCase()}`,
            details: trailText(pb, trail),
            device: s.device,
            priority: "normal",
            watch_service: st.key,
            watch_since_status: st.health,
          });
          await finishSession(env, ws, s.id, "escalated", trail, nodeId, t.id);
          return reply(`${spokenParts.join(" ")} I opened ticket ${t.id} and I'm watching ${st.name}; I'll mark it when they fix it.`, {
            session_id: s.id,
            ticket: t,
            services,
          });
        }
        trail.push({ node: nodeId, answer: "continue", at: db.now() });
        nodeId = pb.nodes[nodeId].answers!.continue;
      }
      const node = pb.nodes[nodeId];
      if (node.outcome === "fixed") {
        await finishSession(env, ws, s.id, "fixed", trail, nodeId, null);
        await db.addEvent(env, ws, "fixed", `${pb.title}: fixed at step "${trail[trail.length - 1]?.node}"`);
        if (s.device)
          await db.upsertDevice(env, ws, {
            name: s.device,
            kind: "other",
            notes: `Last fix (${db.now().slice(0, 10)}): ${pb.nodes[trail[trail.length - 1].node].say.slice(0, 120)}`,
          });
        return reply([...spokenParts, node.say].join(" "), { session_id: s.id, outcome: "fixed", services });
      }
      if (node.outcome === "escalate") {
        const t = await db.createTicket(env, ws, {
          summary: pb.title,
          details: trailText(pb, trail),
          device: s.device,
          priority: node.priority ?? "normal",
        });
        await finishSession(env, ws, s.id, "escalated", trail, nodeId, t.id);
        return reply([...spokenParts, node.say, `It's ticket number ${t.id}.`].join(" "), {
          session_id: s.id,
          outcome: "escalated",
          ticket: t,
          services,
        });
      }
      await env.DB.prepare("UPDATE sessions SET node = ?, trail = ?, updated_at = ? WHERE id = ?")
        .bind(nodeId, JSON.stringify(trail), db.now(), s.id)
        .run();
      return reply([...spokenParts, node.say].join(" "), { session_id: s.id, step: nodeId, services });
    },
  );

  // 3. Tickets.
  registerAppTool(
    server,
    "open_ticket",
    {
      title: "Open a support ticket",
      description:
        "Records a problem that needs follow-up. Set watch_service when an online service outage is involved, so Deskside checks that service every ten minutes and notes when it recovers.",
      inputSchema: z.object({
        summary: z.string().describe("Short title, e.g. 'Laptop won't charge'"),
        details: z.string().optional(),
        priority: PRIORITY.optional(),
        device: z.string().optional(),
        watch_service: z.string().optional().describe("Service to watch, e.g. 'zoom'"),
      }),
      _meta: { ui: { resourceUri: BOARD_URI } },
    },
    async ({ summary, details, priority, device, watch_service }) => {
      let watch: string | null = null;
      let since: string | null = null;
      if (watch_service) {
        watch = resolveService(watch_service);
        if (watch) since = (await checkService(watch)).health;
      }
      const t = await db.createTicket(env, ws, { summary, details, priority, device, watch_service: watch, watch_since_status: since });
      const tickets = await db.listTickets(env, ws);
      return reply(`Done, that's ticket number ${t.id}${watch ? `, and I'm watching ${SERVICES[watch].name} for you` : ""}.`, {
        ticket: t,
        tickets,
      });
    },
  );

  registerAppTool(
    server,
    "list_tickets",
    {
      title: "List support tickets",
      description: "Lists open, waiting and recently resolved tickets for this household or office.",
      inputSchema: z.object({ status: z.enum(["open", "waiting", "resolved", "closed"]).optional() }),
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: BOARD_URI } },
    },
    async ({ status }) => {
      const tickets = await db.listTickets(env, ws, status);
      const spoken = tickets.length
        ? `You have ${tickets.length} ticket${tickets.length === 1 ? "" : "s"}. ${tickets
            .slice(0, 3)
            .map((t) => `Number ${t.id}, ${t.summary}, is ${t.status}.`)
            .join(" ")}`
        : "No open tickets. Everything's calm.";
      return reply(spoken, { tickets });
    },
  );

  registerAppTool(
    server,
    "update_ticket",
    {
      title: "Update a ticket",
      description: "Adds a note, changes status or priority, or closes a ticket when the problem is fixed.",
      inputSchema: z.object({
        ticket_id: z.number().int(),
        status: z.enum(["open", "waiting", "resolved", "closed"]).optional(),
        priority: PRIORITY.optional(),
        note: z.string().optional(),
      }),
      _meta: { ui: { resourceUri: BOARD_URI, visibility: ["model", "app"] } },
    },
    async ({ ticket_id, status, priority, note }) => {
      try {
        const t = await db.updateTicket(env, ws, ticket_id, {
          status,
          priority,
          note,
          ...(status === "closed" ? { watch_service: null, followup_at: null } : {}),
        });
        if (status === "closed") await db.addEvent(env, ws, "ticket", `Ticket #${t.id} closed`);
        return reply(`Ticket ${t.id} is now ${t.status}.`, { ticket: t, tickets: await db.listTickets(env, ws) });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    "schedule_followup",
    {
      title: "Schedule a follow-up check",
      description:
        "Asks Deskside to re-check a ticket later, for example 'check again in an hour'. If the ticket watches a service, the status is re-read at that time and noted on the ticket.",
      inputSchema: z.object({ ticket_id: z.number().int(), minutes: z.number().int().min(10).max(10080) }),
    },
    async ({ ticket_id, minutes }) => {
      const at = new Date(Date.now() + minutes * 60_000).toISOString();
      try {
        const t = await db.updateTicket(env, ws, ticket_id, { followup_at: at, note: `Follow-up scheduled for ${at}` });
        return reply(`I'll check ticket ${t.id} again in ${minutes >= 60 ? Math.round(minutes / 60) + " hours" : minutes + " minutes"}.`, {
          ticket: t,
        });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  // 4. Memory: devices and the services this place relies on.
  server.registerTool(
    "remember_device",
    {
      title: "Remember a device",
      description:
        "Saves a device in the household inventory (name, kind, model, notes) so later conversations can refer to it, e.g. 'the office printer is an HP LaserJet M110'.",
      inputSchema: z.object({
        name: z.string().describe("How people call it, e.g. 'office printer'"),
        kind: z.enum(["printer", "router", "laptop", "desktop", "phone", "tablet", "tv", "other"]),
        model: z.string().optional().describe("Make and model exactly as the person said it, e.g. 'HP LaserJet M110'"),
        notes: z.string().optional().describe("Only if the person gave extra details; otherwise leave it out"),
      }),
    },
    async (d) => {
      if (d.notes && /^(none|n\/a|no notes|none added|-)$/i.test(d.notes.trim())) d.notes = undefined;
      await db.upsertDevice(env, ws, d);
      return reply(`Got it, I'll remember the ${d.name}${d.model ? `, model ${d.model}` : ""}.`, {
        devices: await db.listDevices(env, ws),
      });
    },
  );

  server.registerTool(
    "list_devices",
    {
      title: "List remembered devices",
      description: "Lists the devices Deskside knows about, with models and notes from earlier fixes.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const devices = await db.listDevices(env, ws);
      return reply(
        devices.length ? `I know about ${devices.map((d: any) => d.name).join(", ")}.` : "I don't know any of your devices yet.",
        { devices },
      );
    },
  );

  server.registerTool(
    "set_relied_services",
    {
      title: "Set the services this place relies on",
      description: `Saves which online services the household or office depends on, so briefings and the ten-minute watcher cover them. Choose from: ${SERVICE_KEYS.join(", ")}.`,
      inputSchema: z.object({ services: z.array(z.string()).min(1).max(15) }),
    },
    async ({ services }) => {
      const keys = [...new Set(services.map(resolveService).filter((k): k is string => !!k))];
      if (!keys.length) return fail("I didn't recognise any of those services.");
      await db.setServices(env, ws, keys);
      return reply(`Okay, I'll keep an eye on ${keys.map((k) => SERVICES[k].name).join(", ")}.`, { services: keys });
    },
  );

  // 5. Briefing: what changed since we last talked.
  registerAppTool(
    server,
    "tech_briefing",
    {
      title: "Tech briefing",
      description:
        "Summarises everything since the last conversation: outages on the services this place relies on, ticket updates found by the background watcher, and any fix that was left half-way. Use it when someone asks how things are or what's new.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false },
      _meta: { ui: { resourceUri: BOARD_URI } },
    },
    async () => {
      const relied = await db.getServices(env, ws);
      const keys = relied.length ? relied : ["google", "outlook", "zoom"];
      const statuses = await statusFor(keys);
      const outages = statuses.filter((s) => s.health === "outage" || s.health === "degraded" || s.health === "maintenance");
      const tickets = await db.listTickets(env, ws);
      const events = await db.unseenEvents(env, ws, true);
      const active = await env.DB.prepare("SELECT * FROM sessions WHERE ws = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1")
        .bind(ws)
        .first<any>();
      const parts: string[] = [];
      parts.push(
        outages.length
          ? `Heads up: ${outages.map((o) => `${o.name} is ${o.health}`).join(", ")}.`
          : `All ${statuses.length} services you rely on are working.`,
      );
      const watcherNews = events.filter((e: any) => e.kind === "watch" || e.kind === "followup");
      if (watcherNews.length)
        parts.push(
          `While you were away: ${watcherNews
            .slice(0, 2)
            .map((e: any) => e.text)
            .join(" ")}`,
        );
      parts.push(tickets.length ? `${tickets.length} ticket${tickets.length === 1 ? " is" : "s are"} still open.` : "No open tickets.");
      if (active)
        parts.push(`We also have an unfinished fix: ${PLAYBOOKS[active.playbook].title.toLowerCase()}. Say "continue" to pick it up.`);
      return reply(parts.join(" "), {
        outages: statuses,
        tickets,
        events,
        unfinished: active ? { session_id: active.id, playbook: PLAYBOOKS[active.playbook].title } : null,
      });
    },
  );

  return server;
}

async function finishSession(env: Env, ws: string, id: string, status: string, trail: unknown[], node: string, ticketId: number | null) {
  await env.DB.prepare("UPDATE sessions SET status = ?, node = ?, trail = ?, ticket_id = ?, updated_at = ? WHERE ws = ? AND id = ?")
    .bind(status, node, JSON.stringify(trail), ticketId, db.now(), ws, id)
    .run();
}

function trailText(pb: (typeof PLAYBOOKS)[string], trail: { node: string; answer: string }[]): string {
  return (
    `${pb.title}. Steps already tried:\n` +
    trail.map((t, i) => `${i + 1}. ${pb.nodes[t.node]?.say.split(".")[0]}: answered "${t.answer}"`).join("\n")
  );
}

function timeAgo(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 2) return "a moment ago";
  if (mins < 60) return `${mins} minutes ago`;
  const h = Math.round(mins / 60);
  if (h < 36) return `${h} hour${h === 1 ? "" : "s"} ago`;
  return `${Math.round(h / 24)} days ago`;
}
