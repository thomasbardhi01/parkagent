# Your own agent (WS-4)

Let Grok, Claude or a script plan your parking. It acts as you, with less:

1. Make a key: `POST /me/agent-keys {"label":"Grok","scopes":["read","confirm"]}`. The key (`pak_…`) is shown once.
2. Let agents act: `PATCH /me/settings {"agentsMayAct":true}`. Off by default; turn it off any time, or `DELETE /me/agent-keys/:id`.
3. Give the agent the key and the tools: `GET /agent/openapi.json` (OpenAPI 3.1), or `examples/grok-tool.json` (OpenAI-style functions).

The agent sends `Authorization: Bearer pak_…` to `/agent/*` only. It names places; it never sends a location.

What it can do: look up a place, quote street parking, search garages, price a day, propose a plan, and confirm it once with the plan's `confirmToken` (10 minutes). `read` covers all but the confirm; `confirm` covers the confirm.

What a confirm does: a garage answers with its checkout link; a street spot answers `pending_arrival`. Nothing is paid until your phone reports the car parked and you walk away, the same as without an agent. Your caps, dry run and linked accounts apply as they do to you. 60 calls a minute per key.

Details: `server/API.md` → "External agents".
