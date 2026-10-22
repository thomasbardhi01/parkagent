# ParkAgent architecture

Four views of how the system fits together. Mermaid renders on GitHub.
**Rule:** a PR that changes a flow shown here updates the diagram and the matching row in `docs/feature-map.md` in the same PR. Red = money can move; dashed blue = planned.

## Runtime today

The phone senses, the server decides, providers execute. Every request authenticates through one function, but money passes through three different gates depending on whether it's a start, an extension or a stop.

```mermaid
flowchart LR
  subgraph Phone["iPhone app"]
    LR["LocationReporter<br/>fixes · speedMps · left_car / returned_to_car"]
    PL["ParkLifecycle<br/>waiting park · Pay · Stop"]
    AV["Assistant chat"]
  end

  subgraph API["Fastify server (Fly, one machine)"]
    AUTH["makeAuthenticate<br/>JWT or x-api-key → authedUser"]
    R1["/parked · /location<br/>/parked/:id/confirm"]
    R2["/session/start · extend · stop"]
    R3["/assistant/message · confirm"]
    PS["pendingSession<br/>advanceWalk · settlePark · startParkSession"]
    G1["runStart gate<br/>caps · dry run · zone · link"]
    G2["applyExtension<br/>own cap check · advisory lock"]
    G3["stop<br/>executor directly"]
    AT["AssistantTools + loop<br/>2,586 lines · ToolContext"]
    POL["policyFor · spentToday"]
    EX["executorFor<br/>DryRunExecutor when dry run"]
    JOBS["Jobs<br/>extendTick · settle · janitors"]
    DEC[("decisions<br/>audit of every money step")]
  end

  subgraph Out["Outside services"]
    PB["ParkBoston"]
    SH["SpotHero · ParkWhiz<br/>deep links"]
    ST["Stripe<br/>holds · Issuing · Link"]
    AN["Anthropic API<br/>Sonnet 5.5 · Haiku"]
    AM["Apple Maps geocoder"]
  end

  DB[("Postgres<br/>sessions · pending_parks<br/>location_fixes · users")]

  LR --> AUTH
  PL --> AUTH
  AV --> AUTH
  AUTH --> R1 & R2 & R3
  R1 --> PS
  PS --> G1
  R2 --> G1 & G2 & G3
  R3 --> AT
  AT --> AN & AM & SH
  AT -. "street: start_via_app" .-> PL
  JOBS --> G2
  G1 & G2 --> POL
  G1 & G2 & G3 --> EX
  EX --> PB
  G1 --> ST
  PS & G1 & G2 & G3 & AT --> DEC
  PS & POL & JOBS --> DB

  classDef money stroke:#b42318,stroke-width:2.5px
  classDef ext stroke:#b7791f,stroke-width:2px
  class G1,G2,G3,EX money
  class PB,SH,ST,AN,AM ext
```

## Park lifecycle: when a session gets paid

Each park the phone reports becomes a `pending_parks` row. Every transition is a compare-and-set on the previous status, so two requests can't both start a session. `starting` is the only state where money is in flight.

```mermaid
stateDiagram-v2
  direction LR
  [*] --> at_car: /parked (app lists walk_away)
  at_car --> prompted: walk-away by pace
  at_car --> confirmed: Pay tapped at the car
  prompted --> confirmed: Pay tapped, back at car
  prompted --> starting: Pay tapped while away
  confirmed --> starting: app sends left_car (on foot)
  confirmed --> prompted: pace only (red light can't pay)
  starting --> started: provider confirmed
  starting --> start_failed: failed, or stale with no live session
  starting --> prompted: refused before provider
  started --> ended: return dwell · returned_to_car (CoreMotion's drive) · drove_off
  at_car --> declined: Not now
  prompted --> declined: Not now
  at_car --> cancelled: drove off before paying
  confirmed --> cancelled: drove off before paying
  at_car --> superseded: newer park
  prompted --> expired: 60 min, no walk-away
  confirmed --> expired: 60 min
  ended --> [*]
```

## After WS-4: one gate for every caller

The app, the in-app assistant, Grok over REST, and Claude over MCP all become callers of the same capability functions. Who is acting travels as a `Principal`; one money gate decides; the phone stays the only source of arrival.

```mermaid
flowchart LR
  subgraph Callers
    APP["iPhone app<br/>JWT"]
    LOOP["In-app assistant<br/>Sonnet 5.5"]
    GROK["Grok bot<br/>REST /agent + OpenAPI"]
    CL["Claude · any MCP client<br/>/mcp, stateless 2026-07-28"]
    SIRI["Siri App Intents<br/>(after field day)"]
  end

  P["Principal<br/>actor · scopes · agentKeyId"]

  subgraph Cap["capabilities/* (pure functions)"]
    C1["geocode · quoteStreet<br/>searchGarages · buildItinerary"]
    C2["proposePlan → plan + mandate token"]
    C3["confirmPlan (token bound to plan hash)"]
  end

  GATE["moneyGate<br/>caps · dry run · consent · max stay · link"]
  LIFE["Park lifecycle<br/>pending_parks · arrival from phone only"]
  EXE["Executor · providers"]
  DEC[("decisions<br/>actor · agent_key_id · trace_id")]

  APP --> P
  LOOP --> P
  GROK -- "Bearer pak_" --> P
  CL -- "Bearer pak_" --> P
  SIRI -.-> P
  P --> C1 & C2 & C3
  C3 --> GATE
  GATE -- "street, start now" --> LIFE
  LIFE --> GATE
  GATE --> EXE
  GATE --> DEC
  APP -. "walks away: left_car" .-> LIFE

  classDef money stroke:#b42318,stroke-width:2.5px
  classDef planned stroke:#1d5fa8,stroke-width:2px,stroke-dasharray:5 4
  class GATE,EXE money
  class P,C1,C2,C3,GROK,CL,SIRI planned
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
  CI["CI<br/>Linux jobs · ios only if iOS changed<br/>ui-tests by label · server-pg races (not required)"]
  PROD["Fly: parkagent-api<br/>DRY_RUN=true"]
  FR["nightly FR suite<br/>73 tests vs prod"]

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

  classDef safe stroke:#2f7a4a,stroke-width:2px
  classDef money stroke:#b42318,stroke-width:2.5px
  class GUARD,CI,FR,REV safe
  class PROD money
```
