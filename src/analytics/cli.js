#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SidechatAPIClient } from "../index.js";
import { AnalyticsDatabase } from "./AnalyticsDatabase.js";
import { SnapshotCollector } from "./SnapshotCollector.js";

const here = dirname(fileURLToPath(import.meta.url));
const defaultDatabasePath = resolve(here, "../../data/yikstein.sqlite");
const { command, groupId, databasePath, relogin } = parseArguments(process.argv.slice(2));

if (command === "help" || !command) {
  printHelp();
  process.exit(command ? 0 : 1);
}

const database = new AnalyticsDatabase(databasePath ?? defaultDatabasePath);
try {
  if (command === "login") {
    await authenticate(database, true);
    console.log("Authenticated. Token stored locally in the SQL database.");
  } else if (command === "groups") {
    const token = await authenticate(database, relogin);
    const api = new SidechatAPIClient(token);
    const memberships = await getMemberships(api);
    console.log("School memberships:");
    memberships.forEach((membership, index) => {
      console.log(`${index === 0 ? "* " : "  "}${membership.groupId}${membership.type ? ` (${membership.type})` : ""}`);
    });
  } else if (command === "capture") {
    const token = await authenticate(database, relogin);
    const api = new SidechatAPIClient(token);
    const selectedGroupId = groupId ?? (await getMemberships(api))[0].groupId;
    if (!selectedGroupId) throw new Error("No school membership is available on this account.");
    const collector = new SnapshotCollector(api, database);
    let current = database.getLatestSnapshot(selectedGroupId);
    if (!current) {
      console.log(`Authenticating complete. First capture for school ${selectedGroupId}; locking the UTC three-month window…`);
      const initial = await collector.capture(selectedGroupId, new Date(), { forceNew: true });
      current = database.getSnapshot(initial.snapshotId);
    } else if (current.status !== "complete") {
      console.log("Resuming the interrupted capture before continuing blocks…");
      const resumed = await collector.capture(selectedGroupId, new Date(), {
        forceNew: true,
        runType: current.run_type,
        parentSnapshotId: current.parent_snapshot_id,
        blockedPostId: current.blocked_post_id,
        window: { windowStart: current.window_start, windowEnd: current.window_end },
      });
      current = database.getSnapshot(resumed.snapshotId);
    }

    if (current.blocked_post_id && database.snapshotHasPost(current.id, current.blocked_post_id)) {
      throw new Error("The prior blocked post is still present in the latest capture; stopping to avoid blocking it again.");
    }

    let blocksCompleted = 0;
    while (database.countSnapshotPosts(current.id) > 0) {
      const nextBlockablePost = database.getNextBlockablePost(current.id);
      if (!nextBlockablePost) {
        console.log(`Complete. No blockable posts remain after ${blocksCompleted} blocks.`);
        break;
      }
      console.log(`Blocking next available post source ${nextBlockablePost.id}, then capturing the same locked window again…`);
      throwIfSourceError(await api.hidePostsFromUser(nextBlockablePost.id), "block the next post's source");
      const next = await collector.capture(selectedGroupId, new Date(), {
        forceNew: true,
        runType: "blocked_author",
        parentSnapshotId: current.id,
        blockedPostId: nextBlockablePost.id,
        window: { windowStart: current.window_start, windowEnd: current.window_end },
      });
      current = database.getSnapshot(next.snapshotId);
      if (database.snapshotHasPost(current.id, nextBlockablePost.id)) {
        throw new Error("The blocked post is still present after its follow-up capture; stopping to avoid repeating the same block.");
      }
      blocksCompleted += 1;
      console.log(`Saved follow-up capture ${blocksCompleted}: ${database.countSnapshotPosts(current.id)} posts remain.`);
    }
    if (database.countSnapshotPosts(current.id) === 0) {
      console.log(`Complete. The locked window is exhausted after ${blocksCompleted} blocks.`);
    }
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  database.close();
}

async function getMemberships(api) {
  const currentUser = await api.getCurrentUser();
  const memberships = Array.isArray(currentUser?.memberships) ? currentUser.memberships : [];
  const normalized = memberships
    .map((membership) => ({
      groupId: membership?.groupId ?? membership?.group_id,
      type: membership?.type,
    }))
    .filter((membership) => typeof membership.groupId === "string" && membership.groupId.length > 0);
  if (normalized.length === 0) throw new Error("No school memberships were returned for this account.");
  return normalized;
}

async function authenticate(database, forceLogin) {
  const storedToken = database.getAuthToken();
  if (storedToken && !forceLogin) return storedToken;

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const phoneNumber = (await rl.question("US phone number (10 digits): ")).replace(/\D/g, "");
    if (!/^\d{10}$/.test(phoneNumber)) throw new Error("Enter a 10-digit US phone number.");
    const api = new SidechatAPIClient();
    await api.loginViaSMS(phoneNumber);
    const code = (await rl.question("SMS verification code: ")).trim();
    await api.verifySMSCode(phoneNumber, code);
    if (!api.userToken) {
      throw new Error("No user token returned. Complete source-app registration first, then retry.");
    }
    database.saveAuthToken(api.userToken);
    return api.userToken;
  } finally {
    rl.close();
  }
}

function parseArguments(args) {
  const [command, ...rest] = args;
  let groupId;
  let databasePath;
  let relogin = false;
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === "--group") groupId = rest[++index];
    else if (rest[index] === "--database") databasePath = resolve(rest[++index]);
    else if (rest[index] === "--relogin") relogin = true;
    else throw new Error(`Unknown option: ${rest[index]}`);
  }
  return { command, groupId, databasePath, relogin };
}

function printHelp() {
  console.log(`
Usage:
  npm run analytics -- login [--database path/to/data.sqlite]
  npm run analytics -- groups [--relogin] [--database path/to/data.sqlite]
  npm run analytics -- capture [--group GROUP_ID] [--relogin] [--database path/to/data.sqlite]

capture authenticates if needed, defaults to the account's primary school membership,
locks a three-calendar-month UTC window, saves the first capture, then repeatedly
blocks the next available non-self post source and saves another capture over that
exact same window until no blockable posts remain. Every capture and its raw
responses are stored in SQLite. Interrupted captures resume from their saved cursor.
`);
}

function throwIfSourceError(payload, action) {
  if (!payload || typeof payload !== "object") return;
  if (payload.success === false || payload.error || payload.errors || (typeof payload.message === "string" && /forbidden|error|failed/i.test(payload.message))) {
    throw new Error(`Could not ${action}: ${payload.message ?? payload.error ?? "source service rejected the request"}`);
  }
}
