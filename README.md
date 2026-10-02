# Deskside for Alexa+

**The help desk tech you can talk to.** Deskside is an MCP server that gives Alexa+ the skills of a patient home and small-office IT person: it checks whether an online service is down before blaming your laptop, walks you through a fix one spoken step at a time, remembers where you stopped (even days later), opens a ticket with every step already tried, and keeps watching an outage in the background so the next conversation starts with *"while you were away, Zoom came back."*

- **Demo video (2.5 min):** https://youtu.be/D6WFENVsa1U
- **Live demo (simulated Echo Show, voice in and out):** https://deskside.meshulam791.workers.dev
- **MCP endpoint (Streamable HTTP):** `https://deskside.meshulam791.workers.dev/mcp?ws=<your-workspace>`
- **IT board (what the household's tech person sees):** https://deskside.meshulam791.workers.dev/dashboard.html
- **The board as an MCP App, in a minimal host:** https://deskside.meshulam791.workers.dev/apps.html

## Why

Most "my internet is broken" calls end in one of two places: the service itself is down, or one of five standard fixes works. People don't know which, so they either give up or wait for the one family member who "does computers." Deskside does the first hour of that job by voice, and hands the rest to a human with the homework already done.

## What Alexa+ can do with it

| Say | What happens |
|---|---|
| "Is Slack down?" | `check_service_status` reads Slack's official status feed right now and answers "it's not you" or "let's troubleshoot." 15 services: Zoom, Slack, Gmail/Meet/Drive, Outlook.com, Teams, OneDrive, Microsoft 365 apps, GitHub, Jira/Confluence/Trello, Dropbox, Discord, Figma, Cloudflare, ChatGPT, Claude. |
| "The office printer says offline." | `start_troubleshooting` picks a guided fix (internet, printer, email, video calls, slow computer, sign-in) and asks the first question. |
| "No, still nothing." | `answer_troubleshooting` moves to the next step. Steps that depend on a live service (Gmail, Outlook, Zoom, Teams, Meet) check its status in the middle of the flow. |
| "My email still won't send." (two days later) | The same session resumes: *"We already started on this two days ago and got through 2 steps. Picking up where we stopped…"* |
| (fix doesn't work) | A ticket is opened automatically with the full trail of steps tried, so nobody repeats them. |
| "Open a ticket and keep watching Zoom." | `open_ticket` with `watch_service`. A cron trigger re-reads the status every ten minutes and marks the ticket resolved when the vendor reports recovery. |
| "How's our tech today?" | `tech_briefing`: outages on the services this place relies on, what the watcher found while you were away, and any fix left half-way. |
| "Remember the office printer is an HP LaserJet M110." | `remember_device` keeps an inventory, and fixes are noted on the device. |

Also: `list_tickets`, `update_ticket`, `schedule_followup` ("check again in an hour"), `list_devices`, `set_relied_services`.

## How it fits the Alexa+ track

- **MCP server, spec 2025-11-25 and later, Streamable HTTP.** Built on `@modelcontextprotocol/server` 2.2.0 with `createMcpHandler`, which serves both the 2025-11-25 protocol and the newer 2026-07-28 revision from one endpoint. Verified with raw JSON-RPC (`initialize` negotiates `2025-11-25`).
- **State across sessions.** Troubleshooting sessions, tickets, device inventory and events live in Cloudflare D1, scoped to a workspace (one household or office). A conversation can stop mid-fix and resume days later.
- **Autonomous background work.** A Worker cron trigger watches outages, resolves tickets when vendors recover, and runs scheduled follow-ups. The next conversation reports what changed.
- **Agentic workflow across services.** One spoken problem can touch a vendor status API, a troubleshooting tree, the ticket store and the watcher, without the person naming any tool.
- **Media support: an MCP App.** `open_ticket`, `list_tickets`, `update_ticket` and `tech_briefing` declare `_meta.ui.resourceUri = ui://deskside/board.html` (MIME `text/html;profile=mcp-app`). On a screen device the board shows live service health and tickets, and its "Mark fixed" button calls `update_ticket` back through the host. Tested end to end with the official `AppBridge` in `/apps.html`.
- **An Agent Skill.** [`skills/deskside-helpdesk/SKILL.md`](skills/deskside-helpdesk/SKILL.md) teaches any agent the help-desk method: status first, one step at a time, never ask for passwords or codes, escalate with the trail.
- **The Echo Show simulation.** The demo page is an MCP *client*: it lists Deskside's tools and calls them over Streamable HTTP, with a Workers AI model (Llama 4 Scout) choosing the tools and the browser's Web Speech API for speech in and out.

## Design decisions worth knowing

- **Facts come from the server, not the model.** Every tool returns a `spoken` sentence built from real data. When tools ran, the simulator speaks those sentences, so a model can't paraphrase "ticket 4" into "ticket 5" or "degraded" into "fine."
- **Dialog on rails.** While a guided fix is active, short answers ("yes", "no, still nothing", "Gmail") go straight to `answer_troubleshooting`. Restating the problem ("my email still won't send") resumes instead of counting as "no." This came from testing: smaller models answered the troubleshooting questions themselves.
- **Model choice was measured.** The same four-turn script was run against four Workers AI models on 2026-10-01. Llama 4 Scout and Mistral Small 3.1 called the right tool every time; Qwen3 30B claimed "I saved the printer" without calling any tool, so it was dropped.
- **Degrades instead of dying.** If Workers AI is unavailable (for example the free daily quota is used up), a keyword router keeps the main requests working. A D1 "overloaded" blip is retried once.
- **Safety by default.** The sign-in playbook tells people to type reset addresses themselves and that real support never asks for a password or a code. Nothing in Deskside asks for credentials.

## Run it yourself

```bash
npm install
npx wrangler d1 create deskside            # put the id in wrangler.jsonc
npx wrangler d1 execute deskside --remote --file=schema.sql
npx wrangler deploy
```

Connect any MCP client to `https://<your-worker>/mcp?ws=<workspace>`. Everything runs on Cloudflare's free tier.

Tests and probes used during development: `test/convo.py` (multi-turn voice scripts against the live demo), and the local watcher check (`npx wrangler dev --test-scheduled`, then `curl "localhost:8787/__scheduled?cron=*/10+*+*+*+*"`).

## Layout

```
src/index.ts        Worker: /mcp, /api/chat, /api/state, cron watcher
src/server.ts       MCP server: tools, MCP App resource
src/status.ts       Vendor status feeds (Statuspage, Slack, Google, Microsoft)
src/playbooks.ts    Guided troubleshooting trees
src/agent.ts        Simulated Alexa+: MCP client + Workers AI tool calling
src/db.ts           D1 helpers
src/ui/board.html   MCP App view
public/             Echo Show simulator, IT board, MCP Apps preview host
skills/             Agent Skill
schema.sql          D1 schema
```

## Open-source extra

The status adapters are also published as a standalone, dependency-free library with tests on real feed captures: [status-feeds](https://github.com/danielhagever/status-feeds).

## License

MIT, see [LICENSE](LICENSE).
