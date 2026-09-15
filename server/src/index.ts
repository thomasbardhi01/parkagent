import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { buildApp } from "./app.js";

// Secrets live in the repo-root .env (see .env.example), not in server/.
// Resolved from this module, so it works from src/ under tsx and from dist/ under node.
config({ path: fileURLToPath(new URL("../../.env", import.meta.url)) });

const app = buildApp();
app.listen({ port: Number(process.env["PORT"] ?? 3000), host: "0.0.0.0" });
