/** `kind:rule` of every decision this test file wrote with a rule that
 * has no reason (services/reasons.ts); reasonsGate.ts fails the file if
 * any. A module of its own, importing nothing: the setup file loads it
 * before the test file's `vi.mock`s are registered, so it must not load
 * the app (helpers.js would, and a mocked module would then stay real). */
export const unexplainedRules = new Set<string>();
