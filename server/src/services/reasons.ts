/**
 * Why a decision came out as it did, from its ledger row alone (Issue M).
 * Every rule string the server writes has an entry here — a test reads
 * server/src for them, and the fake DB refuses a rule without one — so
 * "why didn't it extend?" always has an answer: what happened, the
 * evidence on the row that made it so (named facts, each with the value
 * the row holds), and what the person can do. Pure, and deterministic:
 * the template every surface shows and the facts a model may phrase
 * (capabilities/explainDecision.ts), never anything the row doesn't say.
 */

export interface DecisionRowForReason {
  kind: string;
  rule: string;
  inputs: unknown;
  outcome: unknown;
}

/** One fact behind a decision: its name, how a sentence says it, and the
 * value the row holds, formatted. */
export interface Evidence {
  name: EvidenceName;
  label: string;
  value: string;
}

export interface Reason {
  kind: string;
  rule: string;
  /** Whether this rule has an entry (false only for a rule written
   * since, which the coverage test catches before it ships). */
  known: boolean;
  /** What kind of decision it was ("Session start"). */
  subject: string;
  /** What happened, as a clause ("the start was refused"). */
  what: string;
  because: Evidence[];
  /** What the person can do about it, when anything. */
  youCan: string | null;
}

type Format = "usd" | "minutes" | "meters" | "count" | "onoff" | "text" | "code" | "time";

/** The facts a reason may cite, and where on a row each is found: the
 * first of `keys` found at the shallowest depth, the outcome before the
 * inputs. */
const EVIDENCE = {
  price: { label: "the price", keys: ["totalUsd", "amountUsd", "priceUsd"], as: "usd" },
  shownPrice: {
    label: "the price shown",
    keys: ["shownTotalUsd", "quotedTotalUsd", "planPriceUsd"],
    as: "usd",
  },
  spentToday: { label: "spent today", keys: ["spentTodayUsd"], as: "usd" },
  pendingToday: { label: "awaiting approval today", keys: ["linkPendingTodayUsd"], as: "usd" },
  sessionSpent: { label: "spent on this session", keys: ["sessionSpentUsd"], as: "usd" },
  cap: { label: "the cap", keys: ["capUsd"], as: "usd" },
  sessionCap: { label: "the per-stop cap", keys: ["sessionCapUsd"], as: "usd" },
  dailyCap: { label: "the daily cap", keys: ["dailyCapUsd"], as: "usd" },
  stay: {
    label: "the stay",
    keys: ["stayMinutes", "durationMinutes", "minutes", "duration_minutes"],
    as: "minutes",
  },
  maxStay: { label: "the zone's max stay", keys: ["maxStayMinutes"], as: "minutes" },
  zone: { label: "zone", keys: ["providerZoneNumber"], as: "text" },
  distance: { label: "the distance from the car", keys: ["distanceM"], as: "meters" },
  accuracy: { label: "the location's accuracy", keys: ["accuracyM"], as: "meters" },
  dryRun: { label: "dry run", keys: ["dryRun"], as: "onoff" },
  shownDryRun: { label: "dry run when it was shown", keys: ["shownDryRun"], as: "onoff" },
  // Only a known code (a key of REASONS), never an error's free text: a
  // message can quote a URL, a credential or a card (security.test.ts).
  error: { label: "the error", keys: ["code", "error"], as: "code" },
  provider: { label: "the provider", keys: ["provider"], as: "text" },
  ticketCost: { label: "the expected cost of a ticket", keys: ["costTicketUsd"], as: "usd" },
  extendCost: { label: "the cost of more time", keys: ["costExtendUsd"], as: "usd" },
  extensions: { label: "extensions so far", keys: ["extendCount"], as: "count" },
  expiresAt: { label: "the meter's end", keys: ["expiresAt"], as: "time" },
  held: { label: "the hold", keys: ["heldUsd"], as: "usd" },
  captured: { label: "the amount captured", keys: ["capturedUsd"], as: "usd" },
  released: { label: "the amount released", keys: ["releasedUsd"], as: "usd" },
  balance: { label: "the balance", keys: ["balanceUsd"], as: "usd" },
  modelPrice: { label: "the price the model said", keys: ["modelPriceUsd"], as: "usd" },
  modelSpend: { label: "the assistant's spend today", keys: ["spentUsd"], as: "usd" },
  results: { label: "places found", keys: ["count"], as: "count" },
  radius: { label: "the search radius", keys: ["radiusM"], as: "meters" },
  startsAt: { label: "the start time", keys: ["startsAt"], as: "time" },
} as const satisfies Record<string, { label: string; keys: readonly string[]; as: Format }>;

export type EvidenceName = keyof typeof EVIDENCE;

/** [what happened, the evidence that explains it, what the person can do]. */
type Spec = readonly [
  what: string,
  because?: readonly EvidenceName[] | undefined,
  youCan?: string | undefined,
];

const RAISE_STOP = "You can raise your per-stop cap in Limits.";
const RAISE_DAY = "You can raise your daily cap in Limits, or wait until tomorrow.";
const RELINK = "Reconnect the parking account from Account.";
const TAP_AGAIN = "Tap Pay again to see the current price.";
const PROPOSE_AGAIN = "Ask for the plan again.";
const NONE = undefined;

/**
 * The reasons, by rule; a `kind:rule` key overrides a rule that means
 * different things on different kinds (expired, refused, replayed…).
 */
const REASONS: Record<string, Spec> = {
  // ---- detecting a park and quoting it (FR-54, FR-55)
  auto_pay_ok: ["everything checked out, so it was safe to pay automatically", ["price", "zone"]],
  candidates_disagree: [
    "the two sides of the street charge differently, so it asked which side the car is on",
    ["zone"],
    "Pick the side the car is on.",
  ],
  unknown_zone: [
    "no metered zone was close enough",
    ["radius"],
    "If there is a meter here, report its zone number.",
  ],
  free_period: ["the meter isn't charging right now, so there was nothing to pay", ["stay"]],
  rate_above_ceiling: [
    "the meter's rate is above the auto-pay ceiling, so it asked first",
    ["price", "zone"],
  ],
  session_cap_exceeded: [
    "the price would pass the per-stop cap",
    ["price", "sessionCap"],
    RAISE_STOP,
  ],
  daily_cap_exceeded: [
    "today's spending plus this would pass the daily cap",
    ["price", "spentToday", "dailyCap"],
    RAISE_DAY,
  ],
  needs_zone_number: [
    "the block's pay-by-app zone number isn't known yet, so it asked for it",
    NONE,
    "Read the zone number off the sign and enter it.",
  ],
  max_stay_exceeded: [
    "the time asked for is longer than the zone allows",
    ["stay", "maxStay"],
    "Choose a shorter stay.",
  ],
  place_garage: ["it looked like a garage, not the street, so nothing was paid at a meter", NONE],
  place_lot_fee: ["it looked like a paid lot, so nothing was paid at a meter", NONE],
  place_nopay: ["it looked like a place with nothing to pay, so it didn't ask", NONE],
  place_unknown: ["it couldn't tell what kind of place this was, so it asked", NONE],
  ignore: ["nothing needed paying here", NONE],
  confirm: ["it needed your say before paying", ["price", "zone"]],
  not_now: ["you said not now, so nothing was paid", ["price"]],
  confirmed: ["it was confirmed", NONE],
  "street_confirmed:confirmed": [
    "you tapped Pay; it pays when you walk away from the car",
    ["shownPrice", "zone"],
  ],
  confirmed_at_car: [
    "you tapped Pay at the car; it pays once you walk away",
    ["shownPrice", "zone"],
  ],
  agent_plan_bound: [
    "the car parked at the spot your agent confirmed, so it will pay when you walk away, with no prompt",
    ["shownPrice", "stay", "zone", "dryRun"],
  ],
  left_car_event: ["the phone said you left the car, so it asked to pay", ["price", "zone"]],
  walk_away: ["you walked away from the car, so it asked to pay", ["price", "distance"]],
  already_paid: ["a session already covered this car, so it didn't ask", NONE],
  free_now: ["the meter stopped charging before you left, so there was nothing to pay", NONE],
  returned: ["you came back to the car before paying, so the park was closed", ["distance"]],
  drove_off: ["the car drove off before anything was paid", ["distance"]],
  near_for_60s: ["you were back at the car for a minute, so the park was closed", ["distance"]],
  returned_event: ["the phone said you were back at the car, so the park was closed", NONE],
  fix_away: ["a location fix put the phone away from the car", ["distance"]],
  newer_park: ["a newer park replaced this one", NONE],
  newer_park_elsewhere: [
    "the car parked somewhere else, so this session stopped being extended",
    ["distance"],
  ],
  linked_to_session: ["this park became a paid session", NONE],
  ttl_expired: [
    "nobody walked away from this park within the hour, so it stopped waiting",
    NONE,
    "If you're still parked, open the app to pay.",
  ],
  start_stale: ["a start that never answered stopped holding the park", NONE],
  park_awaits_walk_away: [
    "the park is waiting for you to walk away before it pays",
    NONE,
    "Walk away from the car, or tap Pay once you have.",
  ],
  park_closed: ["the park was already closed, so nothing was paid", NONE, TAP_AGAIN],

  // ---- starting, extending and stopping a session
  start_ok: ["the session was started and paid", ["price", "stay", "zone", "dryRun"]],
  receipt_mismatch: [
    "the session was started and paid, but the provider's receipt didn't match what you were shown, so the session was flagged for review and your limits count the receipt",
    ["price", "stay", "zone", "dryRun"],
    "Check the receipt in your parking app.",
  ],
  started: ["it started", NONE],
  "session_start_walkaway:started": [
    "the session was started when you walked away",
    ["price", "stay", "zone"],
  ],
  late_success: ["the start finished after it had timed out, and the session was kept", ["price"]],
  start_timeout: ["the provider didn't answer in time, so the start was given up", NONE, TAP_AGAIN],
  "session_start_walkaway:error": ["the start hit an error at the provider", ["error"], TAP_AGAIN],
  failed: ["it failed", ["error"]],
  "session_start_walkaway:failed": ["the start failed at the provider", ["error"], TAP_AGAIN],
  error: ["it hit an error", ["error"]],
  refused: ["it was refused", ["error"]],
  "session_start_walkaway:refused": [
    "the start was refused before reaching the provider",
    ["error"],
    TAP_AGAIN,
  ],
  quote_changed: [
    "the price changed between what you were shown and the start, so nothing was paid",
    ["shownPrice", "price"],
    TAP_AGAIN,
  ],
  zone_number_changed: [
    "the zone number changed since you were shown it, so nothing was paid",
    ["zone"],
    TAP_AGAIN,
  ],
  dry_run_changed: [
    "dry run changed since you were shown the price, so nothing was paid",
    ["shownDryRun", "dryRun"],
    TAP_AGAIN,
  ],
  provider_not_linked: [
    "no parking account is linked for this city",
    ["provider"],
    "Link the parking account from Account.",
  ],
  wallet_not_ready: [
    "the way you pay wasn't ready (no card to hold against, a frozen card, or the card not yet on the parking account)",
    NONE,
    "Check how you pay in the Wallet.",
  ],
  executor_failed: ["the provider's site failed during the step", ["error"], TAP_AGAIN],
  start_failed: ["the start failed", ["error"], TAP_AGAIN],
  declined: [
    "the provider declined the payment",
    ["error"],
    "Check the card on the parking account.",
  ],
  card_declined: [
    "the card on the parking account was declined",
    NONE,
    "Check the card on the parking account.",
  ],
  // The executor's error codes (services/executor.ts), when one is the rule.
  auth_expired: ["the parking account's sign-in had expired", ["provider"], RELINK],
  zone_not_found: [
    "the provider didn't know that zone number",
    ["zone"],
    "Check the zone number on the sign.",
  ],
  payment_declined: [
    "the provider declined the payment",
    NONE,
    "Check the card on the parking account.",
  ],
  network: ["the provider couldn't be reached", NONE, TAP_AGAIN],
  browser_crashed: ["the automation crashed during the step", NONE, TAP_AGAIN],
  hold_declined: [
    "your card declined the hold, so nothing was paid",
    ["price"],
    "Try another card in the Wallet.",
  ],
  hold_failed: ["the hold on your card couldn't be placed, so nothing was paid", NONE],
  leg_paid: ["the session's payment went through against the hold", ["captured"]],
  leg_failed: ["the session's payment failed, so the hold was released", ["released"]],
  sweep: ["a leftover hold was settled", ["held"]],
  extend_ok: ["the session was extended", ["price", "stay", "expiresAt"]],
  extension_in_progress: ["an extension was already running, so it didn't start another", NONE],
  stop_ok: ["the session was stopped", NONE],
  stopped_at_return: ["you came back to the car, so the session was stopped early", ["distance"]],
  ended_at_return: [
    "you came back to the car; this provider can't stop early, so the session runs to its end",
    ["expiresAt"],
  ],
  ended_drove_off: ["the car drove off, so the session was ended", ["distance"]],
  stop_failed: ["stopping the session failed at the provider", ["error"]],

  // ---- the auto-extend worker (extend_tick)
  extend: [
    "a ticket looked likelier than the cost of more time",
    ["ticketCost", "extendCost", "expiresAt"],
  ],
  extend_failed: ["it tried to extend, but the provider step failed", ["error"]],
  expired: ["it expired", ["expiresAt"]],
  "extend_tick:expired": ["the meter ran out before anything extended it", ["expiresAt"]],
  warn_max_stay: [
    "the zone's max stay was nearly used up, so it warned you instead of extending",
    ["maxStay", "expiresAt"],
    "Move the car before the max stay runs out.",
  ],
  hold_return_likely: [
    "you looked likely to be back before the meter ran out",
    ["distance", "expiresAt"],
  ],
  hold_not_near_expiry: ["the meter wasn't close enough to running out to act", ["expiresAt"]],
  hold_session_cap: [
    "more time would pass the per-stop cap",
    ["extendCost", "sessionSpent"],
    RAISE_STOP,
  ],
  hold_daily_cap: ["more time would pass the daily cap", ["extendCost", "spentToday"], RAISE_DAY],
  hold_needs_review: [
    "the provider's receipt for this session didn't match what you were shown, so it won't add time on its own",
    NONE,
    "Extend it yourself if you need more time.",
  ],
  receipt_needs_review: [
    "the provider's receipt for this session didn't match what you were shown, so time isn't added automatically",
    NONE,
  ],
  hold_gate_refused: [
    "the spending check refused more time (an amount it couldn't read), so it didn't extend",
    ["extendCost", "spentToday"],
  ],
  hold_max_extensions: ["the limit on automatic extensions was already used up", ["extensions"]],
  hold_auto_extend_disabled: ["auto-extend is switched off", NONE],
  hysteresis_hold: ["a decision a moment ago was still settling, so it held steady", NONE],
  hold_at_car: ["the phone was at the car, so it didn't buy time", ["distance"]],
  hold_back_at_car: ["you were back at the car, so it didn't buy time", ["distance"]],
  hold_car_moved: ["the car had moved, so it stopped extending", ["distance"]],
  hold_position_unknown: [
    "it didn't know where the phone was recently enough to buy time",
    NONE,
    "Keep location on for ParkAgent.",
  ],
  hold_returned: ["you had come back to the car, so it didn't extend", NONE],
  phone_not_away: [
    "the phone wasn't known to be away from the car, so it didn't extend",
    ["distance"],
  ],

  // ---- the money gate (services/moneyGate.ts)
  agents_not_allowed: [
    "you haven't said agents may act for you",
    NONE,
    "Turn on agents in Account if you want them to.",
  ],
  amount_over_daily_cap: [
    "the amount would pass the daily cap",
    ["price", "spentToday"],
    RAISE_DAY,
  ],
  amount_invalid: [
    "an amount it had to check against your limits wasn't one it could read, so it refused rather than guess",
    ["price", "spentToday"],
  ],
  minutes_invalid: [
    "the time it was asked to buy wasn't a whole number of minutes above zero, so it bought none",
    ["stay", "maxStay"],
  ],
  policy_violation: ["it was over your limits", ["price"], "Check your limits."],

  // ---- the assistant: plans, confirms, tools
  proposed: ["a plan was proposed", ["price"]],
  none_meets: [
    "nothing found met every part of the request, so it said so",
    NONE,
    "Loosen the price or walk limit and ask again.",
  ],
  no_zone_here: ["there was no parking data for that place", ["radius"]],
  garage_search_unavailable: [
    "the garage search was down on a garage-only request",
    ["provider"],
    "Try again shortly.",
  ],
  ungrounded_number: [
    "the reply stated an amount no search stood behind, so that sentence was dropped",
    NONE,
  ],
  turn_complete: ["the assistant answered", NONE],
  daily_spend_cap: [
    "the assistant reached its spending limit for today",
    ["modelSpend", "cap"],
    "Try again tomorrow.",
  ],
  relax_applied: ["the request's limits were relaxed as you asked", NONE],
  book_failed: ["booking the garage failed", ["error"], PROPOSE_AGAIN],
  garage_confirmed: ["the garage was confirmed and handed off to its checkout", NONE],
  garage_link_pushed: ["the garage's checkout link was sent to you", NONE],
  itinerary_edited: ["the itinerary was edited", ["price"]],
  itinerary_repriced: ["the edited itinerary was priced again", ["price", "spentToday"]],
  itinerary_signed_off: ["you signed off on the itinerary", ["price"]],
  near_miss_not_confirmable: [
    "that option breaks a limit you set; it was shown for information only",
    NONE,
    "Change the limit, then ask again.",
  ],
  nothing_to_confirm: ["there was nothing on that plan to confirm", NONE],
  over_daily_cap: [
    "the plan's total would pass the daily cap",
    ["price", "spentToday", "cap"],
    RAISE_DAY,
  ],
  street_confirmed: ["the street spot was confirmed; it pays at the curb", NONE],
  street_pay_on_arrival: ["a street spot for later pays when the car parks there, not now", NONE],
  unknown_option: ["that option wasn't on the plan", NONE, PROPOSE_AGAIN],
  conversation_deleted: ["the conversation was deleted", NONE],
  conversations_deleted: ["the conversations were deleted", NONE],
  retention_purge: ["an old conversation was deleted after its retention period", NONE],
  ambiguous: ["several places matched the name, so it asked which", ["results"]],
  asked: ["the assistant asked you a question", NONE],
  booked: ["the garage was booked or handed off to its checkout", ["price", "provider"]],
  closest_only: [
    "it found only the closest match, not the place named",
    ["results"],
    "Say the place another way if it's wrong.",
  ],
  duration_needed: ["it needed to know how long you'd stay", NONE, "Say how long."],
  empty_patch: ["the request didn't change", NONE],
  garage_search_error: ["the garage search failed", ["provider", "error"], "Try again shortly."],
  geocode_error: ["looking up the place failed", NONE, "Try again shortly."],
  geocoder_unavailable: ["place lookup isn't available", NONE],
  hard_constraint_violation: ["a proposed option broke a limit of the request", NONE],
  invalid_patch: ["the request change couldn't be read", ["error"]],
  invalid_plan: ["the proposed plan couldn't be read", NONE],
  model_price_mismatch: [
    "the assistant's price differed from the search's, which is the one shown",
    ["modelPrice", "price"],
  ],
  must_say_no: ["nothing met the request, so only a card saying so could be proposed", NONE],
  needs_confirmation: [
    "nothing books or spends without your Confirm tap on a proposed plan",
    NONE,
    PROPOSE_AGAIN,
  ],
  no_match: ["no place matched that name", NONE, "Say the place another way."],
  not_found: ["it couldn't find that", NONE],
  ok: ["the step went through", ["results"]],
  tool_error: ["an assistant step hit an error", NONE],
  unknown: ["it couldn't run", NONE],
  option_expired: ["the garage offer expired with the provider's search", NONE, "Search again."],
  options_available: ["options that met the request existed, so a 'none' card was refused", NONE],
  outside_coverage: ["the place is outside the cities covered", NONE],
  past_window: ["the time asked for was in the past", ["startsAt"], "Give a future time."],
  place_lookup: ["it looked the place up", NONE],
  place_unresolved: ["it couldn't tell which place you meant, so it asked", NONE],
  request_already_updated: ["the request had already been updated", NONE],
  request_unchanged: ["the request didn't change", NONE],
  request_updated: ["the request was updated", ["stay"]],
  requested_time_moved: [
    "the time you asked for had passed, so it moved to the next one",
    ["startsAt"],
  ],
  stale_or_unknown_option: [
    "a proposed option wasn't in the latest search of the request",
    NONE,
    PROPOSE_AGAIN,
  ],
  time_in_past: ["the time asked for is in the past", ["startsAt"], "Give a future time."],
  too_many_edits: ["too many changes came at once", NONE],
  too_many_stops: ["the itinerary had too many stops", NONE, "Ask for 12 stops or fewer."],
  tool_not_available_for_intent: ["that step isn't available for this kind of request", NONE],
  unreadable_time: ["the time couldn't be read", ["startsAt"], "Say the time another way."],
  conflicting_patch: ["the request change contradicted itself", NONE],
  explain_phrased: ["a decision was explained in plain words", NONE],

  // ---- the nightly audit's summary (#256): the model's words, checked
  // against the findings, or the template's when it can't be used
  model: ["the model wrote it, and every line was checked against the facts", NONE],
  "audit_summary:template_off": [
    "the model summary is switched off, so the template wrote it",
    NONE,
  ],
  "audit_summary:template_over_budget": [
    "the model's daily budget was spent, so the template wrote it",
    NONE,
  ],
  "audit_summary:template_refused": ["the model declined, so the template wrote it", NONE],
  "audit_summary:template_failed": ["the model call failed, so the template wrote it", NONE],
  "audit_summary:template_ungrounded": [
    "the model's lines didn't match the findings, so the template wrote it",
    NONE,
  ],

  // ---- external agents (WS-4)
  agents_may_act: ["you said agents may act for you", NONE],
  agents_may_not_act: ["you said agents may not act for you", NONE],
  created: ["it was created", NONE],
  revoked: ["it was revoked", NONE],
  "agent_key:created": ["an agent key was created", NONE],
  "agent_key:revoked": ["an agent key was revoked", NONE],
  garage_handoff: [
    "your agent confirmed a garage; checkout is at the garage",
    ["price", "provider"],
  ],
  pending_arrival: [
    "your agent confirmed a street spot; it pays only once your phone parks there",
    ["price", "dryRun"],
  ],
  garage_option_expired: [
    "the garage offer had expired, so your agent's confirm didn't go through",
    NONE,
    "Have the agent search again.",
  ],
  garage_book_failed: ["booking the garage failed after the confirm", ["error"]],
  mandate_not_found: ["the agent's confirmation wasn't valid for this plan", NONE],
  mandate_used: ["the agent's confirmation had already been used", NONE],
  mandate_expired: [
    "the agent's confirmation expired after ten minutes",
    NONE,
    "Have the agent propose again.",
  ],
  plan_hash_mismatch: ["the plan changed after the agent proposed it", NONE, PROPOSE_AGAIN],
  scope_required: ["the agent's key may not do that", NONE],

  // ---- the ParkAgent card, holds and Issuing
  approved: ["the card charge matched a waiting session and fit the budget", ["price"]],
  declined_unknown_card: ["the charge came from a card ParkAgent doesn't manage", ["price"]],
  declined_wrong_mcc: ["the merchant wasn't a parking merchant", ["price"]],
  declined_no_pending_session: ["no parking session was waiting for this charge", ["price"]],
  declined_over_daily_cap: [
    "the charge would pass the daily cap",
    ["price", "spentToday"],
    RAISE_DAY,
  ],
  declined_dry_run: ["dry run was on, so no money could move", ["price"]],
  declined_no_hold: [
    "the ParkAgent card pays only against a hold on your card, and none was live",
    ["price"],
  ],
  declined_over_hold: [
    "the charge was more than the hold on your card for this session",
    ["price", "held"],
  ],
  hold_placed: ["a hold for the quote plus a small buffer was placed on your card", ["held"]],
  hold_captured: [
    "the hold captured what the ParkAgent card paid and released the rest",
    ["captured", "released"],
  ],
  hold_released: ["the hold was released in full; nothing was charged", ["released"]],
  capture_deferred: ["the provider's charge hadn't arrived yet, so capture waited", ["held"]],
  settle_failed: ["settling the hold failed", ["error"]],
  authorization_reversed: ["the card authorization was reversed", ["released"]],
  reconciled_released: ["the hold was found released and recorded so", ["captured"]],
  reconciled_captured: ["the hold was found captured and recorded so", ["captured"]],
  replayed: ["a duplicate delivery was answered from the recorded decision", NONE],
  "wallet_hold:dry_run": ["dry run was on, so no hold was placed", ["held"]],
  prepared: ["the ParkAgent card was prepared", NONE],
  reveal_ok: ["the card details were shown once", NONE],
  freeze_ok: ["the card was frozen", NONE],
  unfreeze_ok: ["the card was unfrozen", NONE],
  cancel_abandoned: ["an unused card was canceled", NONE],
  freeze_abandoned_transacted: [
    "an unused card that had paid before was frozen, not canceled",
    NONE,
  ],
  funded: ["the top-up arrived", ["price"]],
  funding_move_failed: ["moving the top-up failed", ["price", "error"]],
  funding_unavailable: ["funding isn't available right now", ["price"]],
  intent_created: ["a top-up was started", ["price"]],
  topup_ok: ["the top-up went through", ["price", "balance"]],
  topup_unavailable: ["top-ups aren't available for this provider", NONE],
  insufficient_funds: ["there wasn't enough balance", ["price", "balance"]],
  dry_run: ["dry run was on, so no money moved", ["price"]],
  stripe_failed: ["the payment service failed", ["error"]],
  stripe_not_configured: ["the payment service isn't set up, so no hold was placed", NONE],
  approval_expired: ["the Link approval expired before it was used", ["price"], PROPOSE_AGAIN],
  card_already_revealed: ["the one-time card had already been shown", NONE],
  card_unreadable: ["the one-time card couldn't be read", NONE],
  unknown_spend_request: ["there was no such Link spend request", NONE],
  not_approved: ["the Link spend request wasn't approved yet", NONE, "Approve it in Link."],
  card_used: ["the one-time card was already used", NONE],
  card_expired: ["the one-time card had expired", NONE, PROPOSE_AGAIN],
  reveal_failed: ["showing the one-time card failed", NONE],

  // ---- the wallet and payment source
  set: ["how you pay was changed", NONE],
  consent_required: ["that way to pay needs your consent first", NONE],
  link_not_configured: ["Link isn't available yet", NONE],
  link_not_connected: ["Link isn't connected", NONE, "Connect Link in the Wallet."],
  no_funding_method: ["there's no card to place holds on", NONE, "Add a card in the Wallet."],
  parkagent_card_not_live: ["the ParkAgent card isn't live yet", NONE],
  funding_method_added: ["a card was added", NONE],
  funding_method_in_use: ["the card is in use by a session, so it wasn't removed", NONE],
  funding_method_reactivated: ["a card was reactivated", NONE],
  funding_method_readd_refused: [
    "a removed card can't be added back",
    NONE,
    "Add it as a new card.",
  ],
  funding_method_removed: ["a card was removed", NONE],
  funding_method_default: ["the card holds are placed on was changed", NONE],
  hold_in_progress: ["a hold is in progress, so the card wasn't changed", NONE],
  setup_intent_created: ["adding a card was started", NONE],
  connect_started: ["connecting Link was started", NONE],
  connected: ["Link was connected", NONE],
  disconnected: ["Link was disconnected", NONE],

  // ---- limits (and the violations services/limits.ts names)
  saved: ["your limits were saved", NONE],
  above_ceiling: ["that limit is above the ceiling", ["sessionCap", "dailyCap"]],
  below_minimum: ["that limit is below the minimum", ["sessionCap", "dailyCap"]],
  session_above_daily: [
    "the per-stop cap was above the daily cap",
    ["sessionCap", "dailyCap"],
    "Set the per-stop cap at or below the daily cap.",
  ],
  out_of_range: ["that value is out of range", NONE],
  "limits_update:refused": [
    "those limits weren't allowed (above the ceiling, or a per-stop cap above the daily cap)",
    ["sessionCap", "dailyCap"],
    "Choose limits within the ceilings shown.",
  ],

  // ---- parking accounts
  link_ok: ["the parking account was linked", ["provider"]],
  link_queued: ["linking the parking account started", ["provider"]],
  link_dead_letter: [
    "linking the parking account kept failing, so it stopped trying",
    ["provider", "error"],
    RELINK,
  ],
  no_session_cookies: [
    "the sign-in didn't carry a session, so the account wasn't linked",
    ["provider"],
    RELINK,
  ],
  verification_failed: ["the linked account couldn't be verified", ["provider", "error"], RELINK],
  provider_not_supported: ["that provider isn't supported", NONE],
  unlink_ok: ["the parking account was unlinked", ["provider"]],
  verified: ["the parking account was checked and works", ["provider"]],
  expiring: ["the parking account's sign-in is about to expire", ["provider"], RELINK],
  "provider_health:expired": ["the parking account's sign-in expired", ["provider"], RELINK],
  check_failed: ["checking the parking account failed", ["provider", "error"]],
  setup_ok: ["the card was added to the parking account", ["provider"]],
  no_card: ["there was no card to add to the parking account", ["provider"]],
  sandbox: ["a sandbox run: the card would have been added", ["provider"]],
  "provider_setup_card:dry_run": ["dry run was on, so the card wasn't added", ["provider"]],
  ui_changed: ["the provider's site changed, so the step couldn't run", ["provider"]],
  unsupported_card_brand: ["the provider doesn't take that card brand", ["provider"]],
  "provider_setup_card:unknown": [
    "adding the card couldn't run: a part it needs isn't configured",
    ["provider"],
  ],
  // The per-provider circuit breaker (services/circuitBreaker.ts).
  open: ["the provider kept failing, so calls to it paused", ["provider", "error"]],
  half_open: ["the pause on the provider ended; the next call is a trial", ["provider"]],
  closed: ["calls to the provider resumed", ["provider"]],

  // ---- accounts and identity
  deleted: ["the account was deleted", NONE],
  apple_token_revoked: ["the Sign in with Apple token was revoked", NONE],
  apple_token_revoke_failed: ["revoking the Sign in with Apple token failed; it will retry", NONE],
  apple_token_revoke_dead_letter: ["revoking the Sign in with Apple token kept failing", NONE],
  apple_code_exchange_failed: ["exchanging the Sign in with Apple code failed", ["error"]],
  apple_code_sub_mismatch: ["the Sign in with Apple code was for a different person", NONE],
  apple_refresh_token_stored: ["the Sign in with Apple token was stored, sealed", NONE],
  identity_merged: ["two sign-ins with the same verified email became one account", NONE],
  unverified_email_released: ["an unverified email was released from an account", NONE],
  user_created: ["the account was created", NONE],
  identity_attached: ["a sign-in was attached to the account", NONE],
  fr_throwaway_minted: ["a test account was made", NONE],
  fr_throwaway_sessions_cleared: ["a test account's sessions were cleared", NONE],

  // ---- places and zone numbers
  place_confirmed: ["you confirmed what kind of place this is", NONE],
  place_corrected: ["you corrected what kind of place this is", NONE],
  place_not_here: ["you said the place wasn't here", NONE],
  report_ok: ["your zone number report was recorded", NONE],
  verified_precedence: ["a verified zone number already stands, so it was kept", NONE],
  import_precedence: ["the imported zone number stands until a report is verified", NONE],
  // ---- the parking-sign reader (Issue N): advisory, it never pays
  "sign_check:agrees": ["the signs agree with the zone's data", NONE],
  "sign_check:stricter": [
    "the signs are stricter than the zone's data, so it offered a shorter stay",
    NONE,
    "Accept the shorter stay if the signs are right.",
  ],
  "sign_check:conflicts": [
    "the signs restrict parking here now or within minutes",
    NONE,
    "Check the signs before leaving the car.",
  ],
  "sign_check:unreadable": [
    "the signs couldn't be read",
    NONE,
    "Try another photo, closer and straight on.",
  ],
  accepted_shorter_stay: ["you accepted the shorter stay the signs set", ["maxStay"]],
  "sign_check:retention_purge": [
    "an old sign check's text and kept photo were cleared after 30 days",
    NONE,
  ],
};

/** What kind of decision a row is. */
const KIND_TEXT: Record<string, string> = {
  parked_quote: "Quoting a park",
  street_pending: "Waiting for the walk-away",
  street_prompt: "Asking to pay",
  street_confirmed: "Your Pay",
  street_declined: "Not now",
  park_lifecycle: "The park",
  park_cancelled_at_return: "Back at the car",
  place_confirmation: "The place",
  session_start: "Session start",
  session_start_walkaway: "Session start",
  session_extend: "Session extension",
  session_stop: "Session stop",
  session_end_return: "Session end",
  session_car_moved: "The car moved",
  extend_tick: "Auto-extend check",
  issuing_authorization: "Card authorization",
  wallet_hold: "Card hold",
  wallet_funding: "Your card",
  payment_source: "How you pay",
  limits_update: "Your limits",
  zone_number_report: "Zone number report",
  assistant_tool: "Assistant step",
  assistant_plan: "Assistant plan",
  assistant_confirm: "Plan confirmation",
  assistant_reply: "Assistant reply",
  assistant_turn: "Assistant turn",
  assistant_history: "Assistant history",
  agent_confirm: "Agent confirmation",
  agent_consent: "Agents",
  agent_key: "Agent key",
  provider_link: "Linking a parking account",
  provider_health: "Parking account check",
  provider_unlink: "Unlinking a parking account",
  provider_setup_card: "Adding the card",
  provider_topup: "Top-up",
  card_topup: "Top-up",
  card_topup_intent: "Top-up",
  card_topup_funded: "Top-up",
  card_withdraw: "Withdrawal",
  card_prepare: "The ParkAgent card",
  card_reveal: "Card details",
  card_status: "The ParkAgent card",
  card_janitor: "The ParkAgent card",
  link_card_reveal: "Link card",
  link_wallet: "Link",
  account_delete: "Account deletion",
  auth_identity: "Sign-in",
  circuit_breaker: "The provider",
  audit_summary: "Nightly audit summary",
  sign_check: "The parking signs",
};

/** Whether `rule` (on `kind`, when a kind-specific entry exists) has a
 * reason. */
export function hasReason(kind: string, rule: string): boolean {
  return `${kind}:${rule}` in REASONS || rule in REASONS;
}

/** Every rule (and `kind:rule`) with a reason, for the coverage test. */
export function reasonKeys(): string[] {
  return Object.keys(REASONS);
}

/** Whether `rule` has an entry that holds on any kind (no `kind:`
 * prefix): what a rule literal at a site whose kind the scan can't see
 * needs. */
export function hasGenericReason(rule: string): boolean {
  return rule in REASONS;
}

/** The kinds reasons name, so the scan can tell a kind literal from a
 * rule. */
export function reasonKinds(): string[] {
  return Object.keys(KIND_TEXT);
}

export function reasonOf(row: DecisionRowForReason): Reason {
  const spec = REASONS[`${row.kind}:${row.rule}`] ?? REASONS[row.rule];
  const subject = KIND_TEXT[row.kind] ?? "A decision";
  if (!spec) {
    return {
      kind: row.kind,
      rule: row.rule,
      known: false,
      subject,
      what: `it recorded "${row.rule}"`,
      because: [],
      youCan: null,
    };
  }
  const [what, names = [], youCan] = spec;
  const because = names.flatMap((name): Evidence[] => {
    const value = evidenceValue(row, name);
    return value === null ? [] : [{ name, label: EVIDENCE[name].label, value }];
  });
  return {
    kind: row.kind,
    rule: row.rule,
    known: true,
    subject,
    what,
    because,
    youCan: youCan ?? null,
  };
}

/** The deterministic sentence for a reason: what every surface shows, and
 * the model's fallback. */
export function reasonText(reason: Reason): string {
  const facts = reason.because.map((e) => `${e.label} was ${e.value}`);
  const because = facts.length > 0 ? ` (${facts.join("; ")})` : "";
  const what = reason.what.charAt(0).toUpperCase() + reason.what.slice(1);
  return `${reason.subject}: ${what}${because}.${reason.youCan ? ` ${reason.youCan}` : ""}`;
}

/** The value of one fact on a row, formatted, or null when the row
 * doesn't carry it. */
export function evidenceValue(row: DecisionRowForReason, name: EvidenceName): string | null {
  const spec = EVIDENCE[name];
  const found = findKey([row.outcome, row.inputs], spec.keys);
  return found === undefined ? null : format(found, spec.as);
}

/** Breadth-first over the outcome then the inputs: the shallowest value
 * under any of `keys` (in their order at each depth). */
function findKey(roots: unknown[], keys: readonly string[]): unknown {
  let level = roots.filter(isRecord);
  for (let depth = 0; depth < 4 && level.length > 0; depth++) {
    for (const key of keys) {
      for (const node of level) {
        const value = node[key];
        if (typeof value === "number" || typeof value === "boolean") return value;
        if (typeof value === "string" && value.length > 0) return value;
      }
    }
    level = level.flatMap((node) => Object.values(node).filter(isRecord));
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function format(value: unknown, as: Format): string | null {
  switch (as) {
    case "usd":
      return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(2)}` : null;
    case "minutes":
      return typeof value === "number" && Number.isFinite(value)
        ? `${Math.round(value)} min`
        : null;
    case "meters":
      return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value)} m` : null;
    case "count":
      return typeof value === "number" && Number.isFinite(value) ? String(Math.round(value)) : null;
    case "onoff":
      return typeof value === "boolean" ? (value ? "on" : "off") : null;
    case "time": {
      const at = typeof value === "string" ? new Date(value) : null;
      return at && !Number.isNaN(at.getTime())
        ? `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`
        : null;
    }
    case "code":
      return typeof value === "string" && value in REASONS ? value : null;
    case "text":
      // An id (a provider, a zone number), never a sentence: no spaces,
      // no URL, no punctuation that could carry one.
      return typeof value === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(value) ? value : null;
  }
}
