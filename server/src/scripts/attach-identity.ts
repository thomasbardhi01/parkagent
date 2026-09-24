/**
 * Attach a real sign-in identity to an existing (script-created) user, so
 * the owner's pre-auth account and its whole history carry over instead of
 * a fresh account appearing at first sign-in.
 *
 * Usage:
 *   pnpm -C server attach-identity -- --user <id> --email <e> [--apple-sub <s>]
 *   pnpm -C server attach-identity -- --api-key-prefix <8 chars> --email <e>
 *   (prod: fly ssh console -a parkagent-api -C "node dist/scripts/attach-identity.js …")
 *
 * --api-key-prefix finds the user by the first 8 characters of their api
 * key (users.api_key_prefix) — the one handle the owner already holds
 * locally (Config.xcconfig) when the user id is only in the prod database.
 * It refuses unless exactly one live user matches.
 *
 * The email is stored VERIFIED — this command is the owner asserting the
 * mailbox is theirs — so the first Apple/email sign-in with that address
 * merges onto this user rather than creating a new one. --apple-sub links
 * the Apple identity directly (find it in the server log's decisions line
 * after a first sign-in, or from a decoded identity token's `sub`).
 */

import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { config } from "dotenv";

import { createPrisma } from "../db.js";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

async function main(): Promise<number> {
  // pnpm forwards the literal "--" in `pnpm -C server attach-identity -- …`
  // (the loader-args pitfall); parseArgs reads everything after it as a
  // positional and throws, so the documented command never ran. Drop it.
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const { values: flags } = parseArgs({
    args,
    options: {
      user: { type: "string" },
      "api-key-prefix": { type: "string" },
      email: { type: "string" },
      "apple-sub": { type: "string" },
    },
  });
  const keyPrefix = flags["api-key-prefix"];
  if (!flags.email || Boolean(flags.user) === Boolean(keyPrefix)) {
    console.error(
      "Usage: pnpm -C server attach-identity -- (--user <id> | --api-key-prefix <8 chars>) " +
        "--email <e> [--apple-sub <s>]",
    );
    return 1;
  }
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set (repo-root .env).");
    return 1;
  }
  const email = flags.email.trim().toLowerCase();
  const appleSub = flags["apple-sub"];

  const prisma = createPrisma(databaseUrl);
  try {
    let user;
    if (keyPrefix) {
      const matches = await prisma.user.findMany({
        where: { apiKeyPrefix: keyPrefix, deletedAt: null },
      });
      if (matches.length !== 1) {
        console.error(
          matches.length === 0
            ? `No live user's api key starts with ${keyPrefix}.`
            : `${matches.length} users' api keys start with ${keyPrefix} ` +
                `(${matches.map((m) => m.id).join(", ")}); pass --user instead.`,
        );
        return 1;
      }
      user = matches[0]!;
      console.log(
        `Api key ${keyPrefix}… belongs to ${user.name} (${user.id})${user.isAdmin ? " [admin]" : ""}.`,
      );
    } else {
      user = await prisma.user.findUnique({ where: { id: flags.user! } });
      if (!user) {
        console.error(`No user with id ${flags.user}.`);
        return 1;
      }
    }
    if (user.deletedAt) {
      console.error(`User ${flags.user} is a deleted-account tombstone; refusing.`);
      return 1;
    }
    const emailOwner = await prisma.user.findUnique({ where: { email } });
    if (emailOwner && emailOwner.id !== user.id) {
      console.error(
        `${email} already belongs to user ${emailOwner.id} (${emailOwner.name}). ` +
          "Merging two existing users is manual — move the rows or pick another email.",
      );
      return 1;
    }
    if (appleSub) {
      const subOwner = await prisma.user.findUnique({ where: { appleSub } });
      if (subOwner && subOwner.id !== user.id) {
        console.error(`That Apple subject already belongs to user ${subOwner.id}.`);
        return 1;
      }
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        email,
        emailVerified: true,
        ...(appleSub ? { appleSub } : {}),
      },
    });
    await prisma.decision.create({
      data: {
        kind: "auth_identity",
        inputs: { via: "attach-identity", appleSubAttached: Boolean(appleSub) },
        rule: "identity_attached",
        outcome: { ok: true },
        userId: user.id,
      },
    });
    console.log(
      `Attached ${email}${appleSub ? " and the Apple identity" : ""} to ${user.name} (${user.id}).`,
    );
    console.log("Sign in with that address (or Apple) in the app to pick up this account.");
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

process.exitCode = await main();
