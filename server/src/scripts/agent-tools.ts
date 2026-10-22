/**
 * Print the agent surface's six tools as OpenAI-style function definitions
 * — what examples/grok-tool.json holds. Generated from the routes' own zod
 * schemas, so the example can't drift (test/agentRoutes.test.ts compares).
 *
 *   pnpm -C server agent:tools > examples/grok-tool.json
 */

import { agentFunctionTools } from "../routes/agentOpenApi.js";

console.log(JSON.stringify(agentFunctionTools(), null, 2));
