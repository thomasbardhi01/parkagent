# Your own agent (WS-4)

Let Grok, Claude or a script plan your parking. It acts as you, with less:

1. Make a key: `POST /me/agent-keys {"label":"Grok","scopes":["read","confirm"]}`. The key (`pak_…`) is shown once.
2. Let agents act: `PATCH /me/settings {"agentsMayAct":true}`. Off by default; turn it off any time, or `DELETE /me/agent-keys/:id`.
3. Give the agent the key and the tools: `GET /agent/openapi.json` (OpenAPI 3.1), or `examples/grok-tool.json` (OpenAI-style functions).

The agent sends `Authorization: Bearer pak_…` to `/agent/*` or `/mcp` only. It names places; it never sends a location.

What it can do: look up a place, quote street parking, search garages, price a day, propose a plan, and confirm it once with the plan's `confirmToken` (10 minutes). `read` covers all but the confirm; `confirm` covers the confirm.

What a confirm does: a garage answers with its checkout link; a street spot answers `pending_arrival`. Nothing is paid until your phone reports the car parked and you walk away, the same as without an agent. Your caps, dry run and linked accounts apply as they do to you. 60 calls a minute per key.

Over MCP: point Claude Code, Claude Desktop or any MCP client at `https://parkagent-api.fly.dev/mcp` with the same key (`examples/mcp-config.json`, `examples/mcp-config.generic.json`).
The same six tools plus `explain_decision` (the why below), the same answers and refusals, and one budget across REST and MCP.
`propose_plan` hands back the one-time `confirmToken`; `confirm_plan` takes it with the `planId`.
Hosts with MCP Apps can show a confirm card (`MCP_APPS`, off unless the server turns it on).
2025-era MCP clients work too; nothing over MCP pays, and arrival still comes only from the phone.

Why something happened: `GET /agent/decisions/:id/why` answers with what happened, the facts on the record, and what you can do.

Details: `server/API.md` → "External agents".
