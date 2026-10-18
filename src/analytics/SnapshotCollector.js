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
    const { windowStart, windowEnd } = threeMonthWindow(capturedAt);
    const snapshotId = this.database.createSnapshot(groupId, windowStart, windowEnd);
    const state = {
      cursor: null,
      pagesFetched: 0,
      postsSeen: 0,
      postsStored: 0,
      commentsStored: 0,
      status: "collecting",
    };

    try {
      const group = await this.api.getGroupMetadata(groupId);
      if (group?.id) this.database.saveGroup(group);

      do {
        const page = await this.api.getGroupPosts(groupId, "recent", state.cursor || undefined);
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
          const comments = await this.#getComments(post.id);
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
