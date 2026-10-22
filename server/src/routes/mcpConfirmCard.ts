/**
 * The MCP Apps confirm card (io.modelcontextprotocol/ui), served at
 * `ui://parkagent/confirm-card` only with MCP_APPS on. Static HTML: the
 * host hands it propose_plan's result (`ui/notifications/tool-result`) and
 * it shows the spot, the price, the user's caps and the arrival rule, with
 * one Confirm button that calls confirm_plan through the host. It holds no
 * secret of its own: the one-time confirmToken is the plan's, and a host
 * without UI confirms with it the same way.
 */

export const CONFIRM_CARD_URI = "ui://parkagent/confirm-card";
export const CONFIRM_CARD_MIME = "text/html;profile=mcp-app";

export const CONFIRM_CARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Confirm parking</title>
<style>
  body { font: 15px/1.4 -apple-system, system-ui, sans-serif; margin: 16px; color: #1a1a1a; background: #fff; }
  @media (prefers-color-scheme: dark) { body { color: #f2f2f2; background: #1c1c1e; } }
  h1 { font-size: 17px; margin: 0 0 8px; }
  p { margin: 4px 0; }
  .muted { opacity: .7; font-size: 13px; }
  button { margin-top: 12px; font: inherit; padding: 8px 16px; border-radius: 8px; border: 0; background: #0a84ff; color: #fff; }
  button:disabled { opacity: .5; }
</style>
</head>
<body>
<h1 id="spot">Waiting for the plan…</h1>
<p id="price"></p>
<p id="caps" class="muted"></p>
<p class="muted">Nothing is paid until your phone reports the car parked and you walk away. A street spot answers "pending arrival".</p>
<button id="confirm" disabled>Confirm</button>
<p id="status" class="muted"></p>
<script>
  let nextId = 1;
  const pending = new Map();
  let plan = null;
  const $ = (id) => document.getElementById(id);
  const money = (n) => typeof n === "number" ? "$" + n.toFixed(2) : "";
  function request(method, params) {
    const id = nextId++;
    window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
    return new Promise((resolve) => pending.set(id, resolve));
  }
  function show(result) {
    const body = result && result.structuredContent;
    const option = body && body.plan && body.plan.options && body.plan.options[0];
    if (!option || !body.confirmToken) { $("spot").textContent = "Nothing to confirm."; return; }
    plan = { planId: body.planId, confirmToken: body.confirmToken };
    $("spot").textContent = option.label || option.name || option.zoneId || "Parking";
    $("price").textContent = money(option.priceUsd) + (option.durationMinutes ? " for " + option.durationMinutes + " min" : "");
    const caps = result._meta && result._meta["io.parkagent/caps"];
    if (caps) $("caps").textContent = "Your caps: " + money(caps.sessionCapUsd) + " per stop, " + money(caps.dailyCapUsd) + " a day";
    $("confirm").disabled = false;
  }
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || msg.jsonrpc !== "2.0") return;
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (msg.method === "ui/notifications/tool-result") show(msg.params);
  });
  $("confirm").addEventListener("click", async () => {
    if (!plan) return;
    $("confirm").disabled = true;
    const reply = await request("tools/call", { name: "confirm_plan", arguments: plan });
    const body = reply.result && reply.result.structuredContent;
    $("status").textContent = reply.error ? "Not confirmed." : body && body.error ? "Not confirmed: " + body.error : body && body.status === "pending_arrival" ? "Confirmed. It pays when your phone reports the car parked." : "Confirmed.";
  });
  request("ui/initialize", { appInfo: { name: "parkagent-confirm-card", version: "1.0.0" }, appCapabilities: {} });
</script>
</body>
</html>
`;
