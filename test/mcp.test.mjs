// End-to-end tests against the live server, through the official MCP client over Streamable HTTP,
// the way Alexa+ or any MCP host connects. Run: BASE=https://deskside.meshulam791.workers.dev node --test test/
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const BASE = process.env.BASE ?? "https://deskside.meshulam791.workers.dev";
const WS = "qa-" + Math.random().toString(36).slice(2, 8);
let client;
const call = async (name, args = {}) => client.callTool({ name, arguments: args });
const spoken = (r) => r.structuredContent?.spoken ?? r.content?.[0]?.text ?? "";

before(async () => {
  client = new Client({ name: "deskside-tests", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp?ws=${WS}`)));
});
after(async () => {
  await client?.close();
  await fetch(`${BASE}/api/reset?ws=${WS}`, { method: "POST" });
});

test("lists the 11 tools and the MCP App resource", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["answer_troubleshooting", "check_service_status", "list_devices", "list_tickets", "open_ticket", "remember_device", "schedule_followup", "set_relied_services", "start_troubleshooting", "tech_briefing", "update_ticket"]);
  const board = tools.filter((t) => t._meta?.ui?.resourceUri === "ui://deskside/board.html").map((t) => t.name).sort();
  assert.deepEqual(board, ["list_tickets", "open_ticket", "tech_briefing", "update_ticket"]);
  const { resources } = await client.listResources();
  assert.ok(resources.some((r) => r.uri === "ui://deskside/board.html"));
  const res = await client.readResource({ uri: "ui://deskside/board.html" });
  assert.equal(res.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.ok(!res.contents[0].text.includes("__APP_BUNDLE__"), "bundle placeholder must be replaced");
  assert.ok(res.contents[0].text.includes("window.McpApps"));
});

test("serves the 2025-11-25 protocol to older clients", async () => {
  const r = await fetch(`${BASE}/mcp?ws=${WS}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy", version: "1" } } }),
  });
  const text = await r.text();
  assert.match(text, /"protocolVersion":"2025-11-25"/);
});

test("every status feed answers with a real health value", async () => {
  const names = ["Zoom", "Slack", "GitHub", "Jira", "Dropbox", "Discord", "Figma", "Cloudflare", "ChatGPT", "Claude", "Gmail", "Outlook", "Teams", "OneDrive", "Word"];
  const results = await Promise.all(names.map((n) => call("check_service_status", { service: n })));
  const unknown = results.map((r, i) => [names[i], r.structuredContent?.services?.[0]?.health]).filter(([, h]) => !h || h === "unknown");
  assert.deepEqual(unknown, [], `feeds that failed: ${JSON.stringify(unknown)}`);
});

test("an unknown service is refused politely", async () => {
  const r = await call("check_service_status", { service: "fax machine" });
  assert.equal(r.isError, true);
});

const PATHS = {
  // playbook problem text -> answers that reach "fixed", and answers that reach "escalate"
  "the printer says offline": { fixed: ["no", "yes"], escalate: ["yes", "no", "no", "no"] },
  "the wifi is not working": { fixed: ["one device", "yes"], escalate: ["all devices", "yes", "no"] },
  "my email won't send": { fixed: ["outlook", "yes", "yes"], escalate: ["gmail", "no", "yes", "no"] },
  "my computer is so slow": { fixed: ["yes"], escalate: ["no", "no", "no", "no"] },
  "I can't log in to my account": { fixed: ["yes"], escalate: ["no", "no", "no"] },
  "my zoom camera isn't working": { fixed: ["zoom", "yes"], escalate: ["zoom", "no", "no", "no"] },
};

for (const [problem, paths] of Object.entries(PATHS)) {
  for (const [outcome, answers] of Object.entries(paths)) {
    test(`guided fix "${problem}" reaches ${outcome}`, async () => {
      const ws = `${WS}-${outcome}-${problem.length}`;
      const c = new Client({ name: "deskside-tests", version: "1.0.0" });
      await c.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp?ws=${ws}`)));
      const start = await c.callTool({ name: "start_troubleshooting", arguments: { problem } });
      assert.ok(start.structuredContent?.session_id, spoken(start));
      let last;
      for (const a of answers) {
        last = await c.callTool({ name: "answer_troubleshooting", arguments: { answer: a } });
        assert.ok(!last.isError, `answer "${a}" failed: ${spoken(last)}`);
        // A live outage on the checked service legitimately escalates early.
        if (last.structuredContent?.ticket && last.structuredContent?.services?.length) break;
      }
      const got = last.structuredContent?.outcome ?? (last.structuredContent?.ticket ? "escalated" : "in progress");
      if (outcome === "fixed" && last.structuredContent?.services?.some((s) => s.health === "outage" || s.health === "degraded")) return;
      assert.equal(got, outcome === "fixed" ? "fixed" : "escalated", `last reply: ${spoken(last)}`);
      if (outcome === "escalate") assert.match(spoken(last), /ticket/i);
      await c.close();
      await fetch(`${BASE}/api/reset?ws=${ws}`, { method: "POST" });
    });
  }
}

test("a guided fix resumes in a new session", async () => {
  await call("start_troubleshooting", { problem: "printer offline" });
  await call("answer_troubleshooting", { answer: "yes" });
  const again = await call("start_troubleshooting", { problem: "the printer is still offline" });
  assert.equal(again.structuredContent?.resumed, true);
  assert.match(spoken(again), /picking up where we stopped/i);
});

test("tickets: open, list, note, follow-up, close; per-workspace numbering", async () => {
  const ws = `${WS}-t`;
  const c = new Client({ name: "deskside-tests", version: "1.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp?ws=${ws}`)));
  const a = await c.callTool({ name: "open_ticket", arguments: { summary: "Laptop won't charge <b>x</b>", priority: "high", device: "dad's laptop" } });
  const b = await c.callTool({ name: "open_ticket", arguments: { summary: "Zoom drops", watch_service: "zoom" } });
  assert.equal(a.structuredContent.ticket.id, 1);
  assert.equal(b.structuredContent.ticket.id, 2);
  assert.equal(b.structuredContent.ticket.watch_service, "zoom");
  const list = await c.callTool({ name: "list_tickets", arguments: {} });
  assert.equal(list.structuredContent.tickets.length, 2);
  const f = await c.callTool({ name: "schedule_followup", arguments: { ticket_id: 1, minutes: 60 } });
  assert.ok(f.structuredContent.ticket.followup_at);
  const n = await c.callTool({ name: "update_ticket", arguments: { ticket_id: 1, note: "Tried another charger" } });
  assert.ok(n.structuredContent.ticket.history.some((h) => h.text === "Tried another charger"));
  const closed = await c.callTool({ name: "update_ticket", arguments: { ticket_id: 2, status: "closed" } });
  assert.equal(closed.structuredContent.ticket.status, "closed");
  assert.equal(closed.structuredContent.ticket.watch_service, null);
  const missing = await c.callTool({ name: "update_ticket", arguments: { ticket_id: 99, status: "closed" } });
  assert.equal(missing.isError, true);
  await c.close();
  await fetch(`${BASE}/api/reset?ws=${ws}`, { method: "POST" });
});

test("devices, relied services and the briefing", async () => {
  const d = await call("remember_device", { name: "office printer", kind: "printer", model: "HP LaserJet M110" });
  assert.match(spoken(d), /HP LaserJet M110/);
  const list = await call("list_devices", {});
  assert.ok(list.structuredContent.devices.some((x) => x.name === "office printer" && x.model === "HP LaserJet M110"));
  const s = await call("set_relied_services", { services: ["Slack", "Gmail", "nonsense"] });
  assert.deepEqual(s.structuredContent.services.sort(), ["google", "slack"]);
  const b = await call("tech_briefing", {});
  assert.equal(b.structuredContent.outages.length, 2);
  assert.ok(spoken(b).length > 10);
});

test("bad arguments are rejected, not crashed on", async () => {
  const r = await call("update_ticket", { ticket_id: "abc" });
  assert.equal(r.isError, true);
  const r2 = await call("schedule_followup", { ticket_id: 1, minutes: 1 });
  assert.equal(r2.isError, true);
});
