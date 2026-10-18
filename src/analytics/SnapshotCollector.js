/**
 * Captures one immutable three-calendar-month window.
 * Newer source records are ignored by timestamp; the window never moves.
 */
export class SnapshotCollector {
  constructor(api, database) {
    this.api = api;
    this.database = database;
  }

  async capture(groupId, capturedAt = new Date()) {
    const requestedWindow = threeMonthWindow(capturedAt);
    const resumable = this.database.getResumableSnapshot(groupId);
    const snapshotId = resumable?.id ?? this.database.createSnapshot(groupId, requestedWindow.windowStart, requestedWindow.windowEnd);
    const windowStart = resumable?.window_start ?? requestedWindow.windowStart;
    const windowEnd = resumable?.window_end ?? requestedWindow.windowEnd;
    const state = {
      cursor: resumable?.cursor ?? null,
      pagesFetched: resumable?.pages_fetched ?? 0,
      postsSeen: resumable?.posts_seen ?? 0,
      postsStored: resumable?.posts_stored ?? 0,
      commentsStored: resumable?.comments_stored ?? 0,
      status: "collecting",
    };

    try {
      const group = await withRateLimitRetry(
        () => this.api.getGroupMetadata(groupId),
        "fetch school metadata",
      );
      if (group?.id) this.database.saveGroup(group);

      do {
        const page = await withRateLimitRetry(
          () => this.api.getGroupPosts(groupId, "recent", state.cursor || undefined),
          "fetch posts",
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
          await delay(COMMENT_DELAY_MS);
          const comments = await withRateLimitRetry(
            () => this.#getComments(post.id),
            "fetch comments",
          );
          this.database.saveRawResponse(snapshotId, `/v1/posts/comments/?post_id=${encodeURIComponent(post.id)}`, state.pagesFetched, comments);
          for (const comment of comments.posts ?? []) {
            if (!isInWindow(comment.created_at, windowStart, windowEnd)) continue;
            this.database.saveComment(snapshotId, comment);
            state.commentsStored += 1;
          }
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

  async #getComments(postId) {
    const response = await this.api.sendRequest(
      `/v1/posts/comments/?post_id=${encodeURIComponent(postId)}&cacheBust=${Date.now()}`,
    );
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.message || `Failed to fetch comments (${response.status}).`);
    return payload;
  }
}

const COMMENT_DELAY_MS = Number.parseInt(process.env.YIKSTEIN_COMMENT_DELAY_MS ?? "700", 10);
const MAX_RATE_LIMIT_RETRIES = 6;

async function withRateLimitRetry(operation, description) {
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isRateLimit(error) || attempt === MAX_RATE_LIMIT_RETRIES) throw error;
      const delayMs = 5_000 * 2 ** attempt + Math.floor(Math.random() * 1_000);
      console.warn(`Rate limited while trying to ${description}. Retrying in ${Math.ceil(delayMs / 1_000)} seconds…`);
      await delay(delayMs);
    }
  }
  throw new Error(`Unable to ${description}.`);
}

function isRateLimit(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /\b429\b|rate.?limit|too many requests/i.test(message);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, Number.isFinite(milliseconds) ? milliseconds : 700));
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
