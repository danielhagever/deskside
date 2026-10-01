# Friction log

Each entry: the task, the steps, what I expected, what happened, severity, the workaround, and a suggestion.
Severity: high = blocked progress, medium = cost real time, low = annoyance.

## 1. No way to test against real Alexa+ as an outside developer
- **Task:** See Deskside's MCP server running inside Alexa+ on an Echo Show.
- **Steps:** Read the hackathon resources for Alexa+, the Agent Skills link and the MCP transport spec.
- **Expected:** A developer preview, sandbox or simulator where a self-hosted MCP server URL can be registered and talked to.
- **Actual:** The track describes Alexa+ integrations ("brands in Preview") but offers no way for a hackathon entrant to connect a server to Alexa+. The documented fallback is to build a simulated Alexa+ experience.
- **Severity:** high
- **Workaround:** Built an Echo Show simulator that is a real MCP client over Streamable HTTP, with Workers AI choosing tools and Web Speech for voice.
- **Suggestion:** A public Alexa+ MCP sandbox (even text-only, rate-limited) where developers paste an MCP URL and test multi-turn conversations, plus a published list of what Alexa+ supports from the MCP spec (MCP Apps on Echo Show, elicitation, protocol versions).

## 2. Unclear which MCP features Alexa+ actually renders or honors
- **Task:** Decide whether to invest in MCP Apps UI, structured content and tool annotations.
- **Expected:** A compatibility table: protocol revisions, transports, MCP Apps, structuredContent, elicitation, sampling, OAuth.
- **Actual:** The judging text lists "media support (cards, carousels)" and "MCP Apps" as creative, but nothing says how Echo Show displays them.
- **Severity:** medium
- **Workaround:** Implemented the MCP Apps spec (`ui://` resource, `text/html;profile=mcp-app`) and verified it with the official `AppBridge` in a small host page.
- **Suggestion:** Publish the Alexa+ MCP client capabilities, and how a `ui://` view maps onto Echo Show screen sizes.

## 3. MCP SDK v2 peer pin blocks the Cloudflare `agents` helper
- **Task:** Install `agents` (Cloudflare) with `@modelcontextprotocol/server` 2.2.0 and `@modelcontextprotocol/client` 2.2.0.
- **Actual:** npm ERESOLVE: `agents@0.24.0` declares `peer @modelcontextprotocol/client@"2.0.0"` (exact), so the latest client cannot be installed next to it.
- **Severity:** medium
- **Workaround:** Dropped `agents` and used `createMcpHandler` from `@modelcontextprotocol/server` 2.2.0 directly; it already serves 2025-11-25 and 2026-07-28 on Workers.
- **Suggestion:** (for the ecosystem) loosen the peer range to `^2.0.0`.

## 4. Workers AI model choice for tool calling is trial and error
- **Task:** Pick a free-tier model that reliably calls MCP tools.
- **Actual:** Several models are tagged "function calling", but behavior differed sharply on the same script: one model replied "I've saved the printer" without calling any tool, and `tool_choice: "required"` did not change that.
- **Severity:** medium
- **Workaround:** Measured four models with the same multi-turn script and chose Llama 4 Scout; added dialog rules so short answers in a guided fix bypass the model.
- **Suggestion:** (for Alexa+) document how Alexa+ decides between a skill's tools mid-conversation, and whether a skill can hold the floor during a multi-turn flow.

## 5. Local runtime lags the production compatibility date
- **Task:** Run the cron watcher locally with `wrangler dev --test-scheduled`.
- **Actual:** "This Worker requires compatibility date 2026-09-01, but the newest date supported by this server binary is 2026-06-24."
- **Severity:** low
- **Workaround:** Set the compatibility date to 2026-06-24.
- **Suggestion:** Have `wrangler dev` clamp the date with a warning instead of refusing to start.

## 6. Status data has no single standard
- **Task:** Answer "is it down?" for common household and office services.
- **Actual:** Four formats: Atlassian Statuspage `summary.json` (Zoom, GitHub, Atlassian, Dropbox, Discord, Figma, Cloudflare, OpenAI, Claude), Slack's own `api/v2.0.0/current`, Google's `incidents.json`, and Microsoft's consumer posts feed. Several hosts moved (zoom.us to zoomstatus.com, status.slack.com to slack-status.com).
- **Severity:** low
- **Workaround:** One adapter per format, all probed live before shipping.
- **Suggestion:** An Alexa+ "service health" capability that skills can query would make "is it down?" a one-liner for every skill.
