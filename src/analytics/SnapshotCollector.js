/**
 * Captures one immutable three-calendar-month window.
 * Newer source records are ignored by timestamp; the window never moves.
 */
export class SnapshotCollector {
  constructor(api, database) {
    this.api = api;
    this.database = database;
    this.pacer = new RequestPacer(REQUESTS_PER_SECOND);
  }

  async capture(groupId, capturedAt = new Date(), options = {}) {
    const { forceNew = false, runType = "baseline", parentSnapshotId = null, blockedPostId = null, window = null } = options;
    const completed = !forceNew && this.database.getCompletedSnapshot(groupId, runType);
    if (completed) {
      return {
        snapshotId: completed.id,
        windowStart: completed.window_start,
        windowEnd: completed.window_end,
        pagesFetched: completed.pages_fetched,
        postsSeen: completed.posts_seen,
        postsStored: completed.posts_stored,
        completedAt: completed.completed_at,
        alreadyComplete: true,
      };
    }

    const requestedWindow = window ?? threeMonthWindow(capturedAt);
    validateWindow(requestedWindow);
    const resumable = this.database.getResumableSnapshot(groupId, runType, parentSnapshotId);
    const snapshotId = resumable?.id ?? this.database.createSnapshot(
      groupId,
      requestedWindow.windowStart,
      requestedWindow.windowEnd,
      { runType, parentSnapshotId, blockedPostId },
    );
    const windowStart = resumable?.window_start ?? requestedWindow.windowStart;
    const windowEnd = resumable?.window_end ?? requestedWindow.windowEnd;
    const state = {
      cursor: resumable?.cursor ?? null,
      pagesFetched: resumable?.pages_fetched ?? 0,
      postsSeen: resumable?.posts_seen ?? 0,
      postsStored: resumable?.posts_stored ?? 0,
      status: "collecting",
    };

    try {
      const group = await withRateLimitRetry(
        () => this.api.getGroupMetadata(groupId),
        "fetch school metadata",
        this.pacer,
      );
      if (group?.id) this.database.saveGroup(group);

      do {
        const page = await withRateLimitRetry(
          () => this.api.getGroupPosts(groupId, "recent", state.cursor || undefined),
          "fetch posts",
          this.pacer,
        );
        throwIfSourceError(page, "fetch posts");
        const posts = Array.isArray(page.posts) ? page.posts : [];
        state.pagesFetched += 1;
        state.postsSeen += posts.length;
        this.database.saveRawResponse(snapshotId, "/v1/posts", state.pagesFetched, page);

        let reachedWindowStart = false;
        for (const post of posts) {
          if (isBefore(post.created_at, windowStart)) reachedWindowStart = true;
          if (!isInWindow(post.created_at, windowStart, windowEnd)) continue;

          this.database.savePost(snapshotId, post);
          state.postsStored += 1;
        }

        state.cursor = typeof page.cursor === "string" && page.cursor ? page.cursor : null;
        if (!state.cursor || reachedWindowStart) break;
        this.database.updateSnapshot(snapshotId, state);
      } while (state.cursor);

      state.status = "complete";
      state.completedAt = new Date().toISOString();
      this.database.updateSnapshot(snapshotId, state);
      return { snapshotId, windowStart, windowEnd, ...state };
    } catch (error) {
      state.status = "failed";
      state.lastError = error instanceof Error ? error.message : "Unknown collection error";
      this.database.updateSnapshot(snapshotId, state);
      throw error;
    }
  }

}

const REQUESTS_PER_SECOND = positiveNumber(process.env.YIKSTEIN_REQUESTS_PER_SECOND, 10);
const MAX_RATE_LIMIT_RETRIES = 6;

async function withRateLimitRetry(operation, description, pacer) {
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
    try {
      await pacer.waitTurn();
      return await operation();
    } catch (error) {
      if (!isRateLimit(error) || attempt === MAX_RATE_LIMIT_RETRIES) throw error;
      const delayMs = 5_000 * 2 ** attempt + Math.floor(Math.random() * 1_000);
      console.warn(`Rate limited while trying to ${description}. Retrying in ${Math.ceil(delayMs / 1_000)} seconds…`);
      pacer.coolDown(delayMs);
      await delay(delayMs);
    }
  }
  throw new Error(`Unable to ${description}.`);
}

class RequestPacer {
  constructor(requestsPerSecond) {
    this.minimumInterval = 1_000 / requestsPerSecond;
    this.nextStart = 0;
  }

  async waitTurn() {
    const startAt = Math.max(Date.now(), this.nextStart);
    this.nextStart = startAt + this.minimumInterval;
    await delay(startAt - Date.now());
  }

  coolDown(milliseconds) {
    this.nextStart = Math.max(this.nextStart, Date.now() + milliseconds);
  }
}

function isRateLimit(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /\b429\b|rate.?limit|too many requests/i.test(message);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : 0));
}

function positiveNumber(value, fallback) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function threeMonthWindow(capturedAt) {
  const windowEnd = new Date(capturedAt);
  const rawMonth = windowEnd.getUTCMonth() - 3;
  const targetYear = windowEnd.getUTCFullYear() + Math.floor(rawMonth / 12);
  const targetMonth = (rawMonth + 12) % 12;
  const finalDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const windowStart = new Date(Date.UTC(
    targetYear,
    targetMonth,
    Math.min(windowEnd.getUTCDate(), finalDay),
    windowEnd.getUTCHours(),
    windowEnd.getUTCMinutes(),
    windowEnd.getUTCSeconds(),
    windowEnd.getUTCMilliseconds(),
  ));
  return { windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString() };
}

function validateWindow(window) {
  if (!window || !Number.isFinite(Date.parse(window.windowStart)) || !Number.isFinite(Date.parse(window.windowEnd))) {
    throw new Error("Capture window must contain valid windowStart and windowEnd timestamps.");
  }
}

function isInWindow(value, start, end) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp >= Date.parse(start) && timestamp <= Date.parse(end);
}

function isBefore(value, boundary) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp < Date.parse(boundary);
}

function throwIfSourceError(payload, action) {
  if (payload?.message && !payload?.posts) throw new Error(`Could not ${action}: ${payload.message}`);
}
