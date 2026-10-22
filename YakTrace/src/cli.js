#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SidechatAPIClient } from "sidechat.js";
import { AnalyticsDatabase } from "./AnalyticsDatabase.js";
import { generatePdfReport } from "./PdfReport.js";
import { recentWeeksWindow, SnapshotCollector } from "./SnapshotCollector.js";

const here = dirname(fileURLToPath(import.meta.url));
const runtimeDirectory = resolve(here, "../.runtime");
const defaultDatabasePath = resolve(runtimeDirectory, "yaktrace.sqlite");
const defaultReportDirectory = resolve(runtimeDirectory, "reports");
const { command, groupId, databasePath, relogin, weeks } = parseArguments(process.argv.slice(2));

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
    const selectedWeeks = weeks ?? await selectRecentWeeks();
    const captureWindow = recentWeeksWindow(new Date(), selectedWeeks);
    console.log("Unblocking all hidden sources before the fresh capture…");
    await performSourceAction(() => api.unhidePostsFromAllUsers(), "unblock all sources before capture");
    database.clearCaptures(selectedGroupId);
    console.log(`Authenticating complete. Starting a fresh capture for school ${selectedGroupId}; locking the most recent ${selectedWeeks} ${weekLabel(selectedWeeks)} in UTC…`);
    const initial = await collector.capture(selectedGroupId, new Date(), { forceNew: true, window: captureWindow });
    let current = database.getSnapshot(initial.snapshotId);

    const initialBlockablePosts = database.countBlockablePosts(current.id);
    let blocksCompleted = 0;
    console.log(`Iteration 0 complete: ${initialBlockablePosts} blockable posts in the locked window.`);
    while (database.countSnapshotPosts(current.id) > 0) {
      const nextBlockablePost = database.getNextBlockablePost(current.id);
      if (!nextBlockablePost) {
        console.log(`Complete. No blockable posts remain after ${blocksCompleted} blocks.`);
        break;
      }
      console.log(`Blocking next available post source ${nextBlockablePost.id}, then capturing the same locked window again…`);
      await performSourceAction(
        () => api.hidePostsFromUser(nextBlockablePost.id),
        "block the next post's source",
      );
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
      const remainingBlockablePosts = database.countBlockablePosts(current.id);
      console.log(iterationProgress(blocksCompleted, initialBlockablePosts, remainingBlockablePosts));
    }
    if (database.countSnapshotPosts(current.id) === 0) {
      console.log(`Complete. The locked window is exhausted after ${blocksCompleted} blocks.`);
    }
    console.log("Unblocking all hidden sources…");
    await performSourceAction(() => api.unhidePostsFromAllUsers(), "unblock all sources");
    console.log("All hidden sources have been unblocked.");
    console.log("Saving final personal-post capture over the same locked window…");
    const personal = await collector.capture(selectedGroupId, new Date(), {
      forceNew: true,
      runType: "personal_posts",
      parentSnapshotId: current.id,
      window: { windowStart: current.window_start, windowEnd: current.window_end },
      includePost: (post) => post?.authored_by_user === true,
    });
    console.log(`Saved final personal-post capture: ${personal.postsStored} posts.`);
    const reportPath = generatePdfReport(database, selectedGroupId, defaultReportDirectory);
    console.log(`Saved PDF report: ${reportPath}`);
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
  let weeks;
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === "--group") groupId = rest[++index];
    else if (rest[index] === "--database") databasePath = resolve(rest[++index]);
    else if (rest[index] === "--relogin") relogin = true;
    else if (rest[index] === "--weeks") weeks = parseWeeks(rest[++index]);
    else throw new Error(`Unknown option: ${rest[index]}`);
  }
  return { command, groupId, databasePath, relogin, weeks };
}

function printHelp() {
  console.log(`
Usage:
  npm run yaktrace -- login [--database path/to/data.sqlite]
  npm run yaktrace -- groups [--relogin] [--database path/to/data.sqlite]
  npm run yaktrace -- capture [--weeks 1-15] [--group GROUP_ID] [--relogin] [--database path/to/data.sqlite]

capture authenticates if needed, defaults to the account's primary school membership,
then lets you choose the most recent 1-15 weeks with the up/down arrow keys. Use
--weeks to skip the selector. The command locks that UTC window, saves the first
capture, then repeatedly
blocks the next available non-self post source and saves another capture over that
exact same window until no blockable posts remain. Capture state and reports are
stored only in YakTrace/.runtime/ (unless --database is supplied). It then unblocks
all hidden sources. Each command starts a fresh run, ending with a
personal-post-only capture.
`);
}

function parseWeeks(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 15) {
    throw new Error("--weeks must be a whole number from 1 through 15.");
  }
  return parsed;
}

async function selectRecentWeeks() {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
    console.log("No interactive terminal detected; defaulting to the most recent 1 week. Use --weeks 1-15 to choose a different window.");
    return 1;
  }

  let selectedWeeks = 1;
  const rawModeWasEnabled = stdin.isRaw;
  const render = () => {
    stdout.write(`\r\x1b[2KMost recent: ${selectedWeeks} ${weekLabel(selectedWeeks)}  (↑/↓ to change, Enter to confirm)`);
  };

  stdout.write("\nChoose the capture window.\n");
  render();
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return new Promise((resolve, reject) => {
    const finish = (result) => {
      stdin.off("data", onKeypress);
      stdin.setRawMode(rawModeWasEnabled);
      stdout.write("\n");
      resolve(result);
    };
    const cancel = () => {
      stdin.off("data", onKeypress);
      stdin.setRawMode(rawModeWasEnabled);
      stdout.write("\n");
      reject(new Error("Week selection cancelled."));
    };
    const onKeypress = (key) => {
      if (key === "\u0003" || key === "\u001b") return cancel();
      if (key === "\r" || key === "\n") return finish(selectedWeeks);
      if (key === "\u001b[A" || key === "k") selectedWeeks = Math.min(15, selectedWeeks + 1);
      if (key === "\u001b[B" || key === "j") selectedWeeks = Math.max(1, selectedWeeks - 1);
      render();
    };
    stdin.on("data", onKeypress);
  });
}

function weekLabel(weeks) {
  return weeks === 1 ? "week" : "weeks";
}

function throwIfSourceError(payload, action) {
  if (!payload || typeof payload !== "object") return;
  if (payload.success === false || payload.error || payload.errors || (typeof payload.message === "string" && /forbidden|error|failed/i.test(payload.message))) {
    throw new Error(`Could not ${action}: ${payload.message ?? payload.error ?? "source service rejected the request"}`);
  }
}

async function performSourceAction(operation, action) {
  await delay(1_000);
  for (let attempt = 0; attempt < 7; attempt += 1) {
    try {
      const payload = await operation();
      if (!isRateLimited(payload)) {
        throwIfSourceError(payload, action);
        return payload;
      }
    } catch (error) {
      if (!isRateLimited(error)) throw error;
    }

    if (attempt === 6) throw new Error(`Could not ${action}: source rate limit did not clear.`);
    const waitMs = 5_000 * 2 ** attempt + Math.floor(Math.random() * 1_000);
    console.warn(`Rate limited while trying to ${action}. Retrying in ${Math.ceil(waitMs / 1_000)} seconds…`);
    await delay(waitMs);
  }
}

function isRateLimited(value) {
  const message = value instanceof Error ? value.message : JSON.stringify(value);
  return /\b429\b|rate.?limit|too many requests/i.test(message);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function iterationProgress(iteration, initial, remaining) {
  const removed = Math.max(0, initial - remaining);
  const ratio = initial > 0 ? removed / initial : 1;
  const width = 24;
  const complete = Math.round(ratio * width);
  const bar = `${"#".repeat(complete)}${"-".repeat(width - complete)}`;
  const averageRemoved = iteration > 0 ? removed / iteration : 0;
  const estimatedRemaining = averageRemoved > 0 ? Math.ceil(remaining / averageRemoved) : null;
  const estimate = estimatedRemaining === null ? "estimate pending" : `estimated ~${estimatedRemaining} more iterations`;
  return `Iteration ${iteration} complete: ${remaining}/${initial} blockable posts remain\n[${bar}] ${(ratio * 100).toFixed(1)}% removed; ${estimate}.`;
}
