# ParkAgent architecture

Four views of how the system fits together. Mermaid renders on GitHub.
**Rule:** a PR that changes a flow shown here updates the diagram and the matching row in `docs/feature-map.md` in the same PR. Red = money can move; dashed blue = planned.

## Runtime today

The phone senses, the server decides, providers execute. Every request authenticates through one function, and money passes through one gate, `moneyGate`, whoever asks.

```mermaid
flowchart LR
  subgraph Phone["iPhone app"]
    LR["LocationReporter<br/>fixes · speedMps · left_car / returned_to_car"]
    PL["ParkLifecycle<br/>waiting park · Pay · Stop"]
    AV["Assistant chat"]
  end

  subgraph API["Fastify server (Fly, one machine)"]
    AUTH["makeAuthenticate<br/>JWT, Bearer pak_ or x-api-key → Principal<br/>actor · scopes · trace<br/>path ids parsed first (routes/ids.ts)"]
    R1["/parked · /location<br/>/parked/:id/confirm"]
    R2["/session/start · extend · stop<br/>receipt bound: needs_review, excess counted"]
    R3["/assistant/message · confirm"]
    R4["/agent/* REST · OpenAPI 3.1<br/>/mcp · stateless 2026-07-28<br/>seven tools: the /agent calls + explain_decision"]
    R5["/parked/:id/signs · accept"]
    PS["pendingSession<br/>advanceWalk (door rule) · settlePark · movePark<br/>startParkSession · phonePosition"]
    GATE["moneyGate<br/>consent · fails closed (amount, minutes) · usable account<br/>caps (+ receipt excess) · max stay · dry run · as shown<br/>auto extend: not needs_review; phone away + no newer park (under lock)"]
    EXT["applyExtension<br/>advisory lock · withAcceptedStay · asks the gate again"]
    AT["AssistantTools (adapter) + loop<br/>execute · ToolContext"]
    CAP["capabilities/*<br/>geocode · quoteStreet · searchGarages<br/>buildItinerary · proposePlan · confirmPlan"]
    RS["capabilities/readSigns<br/>strict SignRules · grounded in the phone's OCR text<br/>SIGN_READER, off by default"]
    POL["policyFor · spentToday"]
    EX["executorFor<br/>DryRunExecutor when dry run"]
    JOBS["Jobs<br/>extendTick (phonePosition · Reconnect push) · settle · janitors"]
    DEC[("decisions<br/>actor · agent_key_id · trace_id")]
    TR["/admin/parks/:id/trace (admin)<br/>trace:export · trace:replay"]
    AUD["/admin/audit · audit invariants<br/>report-only · template summary"]
    HL["/health<br/>commit · effective dry run · degraded"]
  end

  subgraph Out["Outside services"]
    PB["ParkBoston"]
    SH["SpotHero · ParkWhiz<br/>deep links"]
    ST["Stripe<br/>holds · Issuing · Link"]
    AN["Anthropic API<br/>claude-sonnet-5-5 (assistant) · claude-haiku-5-5 (explain)<br/>thinking blocks passed back unchanged"]
    AM["Apple Maps geocoder"]
    OT["OTel collector<br/>OTLP/HTTP (OTEL_EXPORTER_OTLP_ENDPOINT)"]
  end

  DB[("Postgres<br/>sessions · pending_parks<br/>location_fixes · users")]
  PF[("park_fixes<br/>every fix a park read or refused · 30 days")]
  PLAN[("assistant_plans<br/>confirmed by an agent · bound once")]

  LR --> AUTH
  PL --> AUTH
  AV --> AUTH
  AUTH --> R1 & R2 & R3 & R4 & R5
  R1 --> PS
  PS --> GATE
  R2 --> GATE
  R3 --> AT
  R4 -- "agentActions, as /agent" --> CAP
  R5 --> RS
  RS --> AN
  RS -. "advisory: warn, or a shorter stay on accept" .-> PL
  R5 -- "accept: max stay, never longer, never below what was paid" --> GATE
  AT --> AN
  AT --> CAP
  CAP --> AM & SH
  CAP --> GATE
  AN -- "stop_reason refusal → the server's sentence, refused on the turn row" --> AT
  CAP -- "explainDecision: template (deterministic)" --> DEC
  AT -. "street: start_via_app" .-> PL
  JOBS -- "as job for the owner" --> GATE
  GATE --> EXT
  GATE --> POL
  GATE & EXT --> EX
  EX --> PB
  GATE --> ST
  PS & GATE & AT & JOBS & RS & R5 --> DEC
  PS & POL & JOBS --> DB
  R1 -- "each fix, read or refused (why)" --> PF
  TR --> PF & DEC
  JOBS -. "retention: delete after 30 days" .-> PF
  AUD -. "reads" .-> DEC
  AUD -. "reads sessions · pending_parks · park_fixes" .-> DB & PF
  AUD -. "AUDIT_SUMMARY: findings only, grounded" .-> AN
  CAP -. "agent confirm: pending_arrival, no park" .-> PLAN
  R1 -- "/parked in the plan's zone (as /parked resolves it), in the window, same dry run, a plan for now (park_now), consent still on: bound once, held confirmed, pays on left_car" --> PLAN
  HL -. "effectiveDryRun, per request" .-> POL
  R1 & R2 & R3 -. "request spans" .-> OT
  AT -. "invoke_agent · chat · execute_tool (no words)" .-> OT
  GATE -. "money_gate span" .-> OT
  CAP & RS & AUD -. "chat span: each model call (explain, sign reader, audit summary)" .-> OT
  AUTH -. "trace_id (the request span, or traceparent)" .-> DEC

  classDef money stroke:#b42318,stroke-width:2.5px
  classDef ext stroke:#b7791f,stroke-width:2px
  class GATE,EXT,EX money
  class PB,SH,ST,AN,AM,OT ext
```

## Park lifecycle: when a session gets paid

Each park the phone reports becomes a `pending_parks` row. Every transition is a compare-and-set on the previous status, so two requests can't both start a session. `starting` is the only state where money is in flight.

```mermaid
stateDiagram-v2
  direction LR
  [*] --> at_car: /parked (app lists walk_away)
  [*] --> confirmed: /parked at an agent's confirmed park_now spot (its zone, its window, its dry run, consent still on)
  at_car --> prompted: walk-away (two fixes clear at a walk, or left_car off the door)
  at_car --> confirmed: Pay tapped at the car
  prompted --> confirmed: Pay tapped, back at car
  prompted --> starting: Pay tapped while away
  confirmed --> starting: left_car (on foot) on a fix clear of the door
  confirmed --> prompted: pace only (red light can't pay), or a fix clear of the door after a left_car refused at it
  starting --> started: provider confirmed
  starting --> start_failed: failed, or stale with no live session
  starting --> prompted: refused before provider
  starting --> confirmed: a walk-away start threw before the provider (waits for the next left_car)
  starting --> free: the meter stopped charging
  prompted --> covered: a running session at this spot pays it
  started --> ended: return dwell · returned_to_car (CoreMotion's drive) · drove_off
  at_car --> declined: Not now
  prompted --> declined: Not now
  at_car --> cancelled: drove off before paying
  confirmed --> cancelled: drove off before paying
  at_car --> superseded: newer park
  confirmed --> superseded: newer park
  prompted --> superseded: newer park
  prompted --> expired: 60 min, no walk-away
  confirmed --> expired: 60 min
  at_car --> expired: 60 min
  ended --> [*]
```

A newer park supersedes a park still waiting, at any distance. More than 100 m from a running session's car, it marks the car moved (`car_moved_at`, `noteCarMoved`), and the extension worker buys that session nothing more. Every move that gives a park its session goes through one helper, `movePark`: a compare-and-set from the state it was read in, then the caller's ledger row, then the newer-park check (`noteNewerParkSince`), whether the start settled, a late success adopted it, a relink did, the stale-start sweep did, or the start threw. So a park that was mid-start or closed when the newer one landed is checked the moment it takes a session, and that session is never extended for a spot the car left (#246, #285). As a belt, the worker and the gate under the extension lock read the newest park again (`checkNewerPark`) before buying time. Accepted: `/parked` doesn't take the extension lock, so a newer park that lands while the provider is charging still buys that one extension, within the caps.

The door rule (#287): the app's `left_car` is not the walk-away when its fix may have the phone at the car's door (`mayBeAtTheDoor`: distance − accuracy ≤ 10 m, or accuracy over 65 m). The refused walk is kept (`walk_said_at`, `walk_said_usable`), and the next fix off the door, at a walk, reads as `fix_away`: it asks again and never pays by itself, so only a second tap pays. A usable fix within 30 m since, a pace over 3 m/s since, or `returned_to_car` forgets it.

Where the phone is for a running session is the lifecycle's alone (`phonePosition`, `services/pendingSession.ts`, #301): the park row the walk rules keep, plus the newest fix that is still reporting, judged on its report time (`ts`) within the last 5 minutes, so a still phone's heartbeat keeps it counting. A usable fix within 30 m of the car reads `at_car`, whatever the walk rules hold, and `/location` doesn't store a fix sent more than 5 minutes ahead of the server's clock. The extension worker reads it, and the money gate reads it again under the extension lock. Neither measures distance itself, and a session with no park row is `unknown`, so nothing is bought for it. The worker's cost model reads only a walk trend over the last 10 minutes of the same fixes (distance, heading, walk ETA), which prices an extension and never says the phone is away.

Open before `DRY_RUN=false`: a drive-off straight after a return never sets `back_at` (#306); the car-moved rule ignores fix accuracy and zone boundaries (#291); a tap from the seat after a real walk-away pays (#293); a retried tap can pay a park that was asked again (#307).

## WS-4 as built: one gate for every caller

The app, the in-app assistant, Grok over REST, and Claude over MCP are all callers of the same capability functions. Who is acting travels as a `Principal`; one money gate decides; the phone stays the only source of arrival. An agent's street confirm writes no park: it leaves a confirmed `park_now` plan and its consumed mandate, and the phone's next `/parked` at that zone, inside the mandate's 10 minutes and under the same dry run, with the person's consent still on, binds to it once (E3).

```mermaid
flowchart LR
  subgraph Callers
    APP["iPhone app<br/>JWT"]
    LOOP["In-app assistant<br/>Sonnet 5.5"]
    GROK["Grok bot<br/>REST /agent + OpenAPI"]
    CL["Claude · any MCP client<br/>/mcp, stateless 2026-07-28<br/>seven tools, annotated"]
    SIRI["Siri App Intents<br/>(after field day)"]
  end

  P["Principal<br/>actor · scopes · agentKeyId"]

  subgraph Cap["capabilities/* (pure functions)"]
    C1["geocode · quoteStreet<br/>searchGarages · buildItinerary"]
    C2["proposePlan → plan + mandate token"]
    C3["confirmPlan (token bound to plan hash)"]
    C4["explainDecision<br/>template; phrased only with EXPLAIN_MODEL"]
  end

  GATE["moneyGate<br/>consent · fails closed · caps · dry run · max stay · usable account"]
  LIFE["Park lifecycle<br/>pending_parks · arrival from phone only<br/>E3: binds a park_now plan once"]
  EXE["Executor · providers"]
  OT["OTel collector<br/>OTLP/HTTP, opt-in"]
  DEC[("decisions<br/>actor · agent_key_id · trace_id")]
  KEYS[("agent_keys<br/>pak_ hash · scopes · revoked_at")]
  MAND[("mandates<br/>token hash · plan_hash · scopes · caps · consumed_at")]
  CARD["MCP Apps confirm card<br/>ui:// · MCP_APPS, off by default"]

  APP --> P
  LOOP --> P
  GROK -- "Bearer pak_ (agent_keys)" --> P
  CL -- "Bearer pak_" --> P
  CL -. "propose_plan _meta.ui" .-> CARD
  CARD -- "confirm_plan via host" --> P
  SIRI -.-> P
  P --> C1 & C2 & C3
  P --> C4
  P -.- KEYS
  C2 -- "mint" --> MAND
  C3 -- "consume once" --> MAND
  APP -- "Confirm tap: mint" --> MAND
  HAIKU[["claude-haiku-5-5<br/>EXPLAIN_MODEL (off by default)"]]
  C4 -. "phrases the reason (strict schema, grounded)" .-> HAIKU
  C4 -- "reads one row" --> DEC
  GROK -- "GET /agent/decisions/:id/why" --> C4
  CL -- "explain_decision (MCP)" --> C4
  APP -- "GET /me/decisions/:id/why" --> C4
  C3 --> GATE
  C3 -. "street: pending_arrival (consent + cap, no park)" .-> LIFE
  APP -- "/parked: the only arrival" --> LIFE
  LIFE -. "E3: a consumed, unexpired agent mandate, same dry run" .-> MAND
  LIFE --> GATE
  GATE --> EXE
  GATE --> DEC
  GATE -. "money_gate span" .-> OT
  C4 -. "chat span (EXPLAIN_MODEL on)" .-> OT
  APP -. "walks away: left_car" .-> LIFE

  classDef money stroke:#b42318,stroke-width:2.5px
  classDef planned stroke:#1d5fa8,stroke-width:2px,stroke-dasharray:5 4
  class GATE,EXE money
  class SIRI planned
```

## How it gets built

A coordinator session plans and reviews; workers each own one branch in their own worktree; you merge. Guard, the branch ruleset, CI and the nightly suite stand between any session and production.

```mermaid
flowchart TB
  YOU(["You<br/>merge · secrets · fly"])
  subgraph Mac["Your Mac mini"]
    COORD["coord<br/>dispatch · review · status issue"]
    REV["fresh reviewer subagent<br/>per PR"]
    W1["w-principal<br/>D0 → D → E"]
    W2["w-ios-motion<br/>#231 fix → C → F (MCP)"]
    W3["w-walkaway<br/>A tests → B Postgres"]
    GUARD["guard plugin<br/>blocks merge · push main · fly writes<br/>secret reads · settings edits"]
  end
  GH["GitHub<br/>PRs · ruleset on main"]
  CI["CI<br/>Linux jobs · ios only if iOS changed<br/>ui-tests by label · server-pg races (required: approved, not yet set)"]
  PROD["Fly: parkagent-api<br/>DRY_RUN=true"]
  FR["nightly FR suite<br/>73 tests vs prod"]
  NA["nightly audit step<br/>(nightly-fr)"]

  COORD -- "issues via SendMessage" --> W1 & W2 & W3
  W1 & W2 & W3 -- "/report" --> COORD
  COORD --> REV
  W1 & W2 & W3 -- "open PR" --> GH
  GUARD -. "every Bash / file call" .- W1 & W2 & W3 & COORD
  GH --> CI
  CI -- "green" --> YOU
  YOU -- "squash merge" --> GH
  GH -- "main" --> PROD
  PROD --> FR
  FR -- "red opens an issue" --> GH
  PROD --> NA
  NA -- "one 'Nightly audit' issue (GITHUB_TOKEN)" --> GH

  classDef safe stroke:#2f7a4a,stroke-width:2px
  classDef money stroke:#b42318,stroke-width:2.5px
  class GUARD,CI,FR,NA,REV safe
  class PROD money
```
