import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Local SQL source of truth for fixed-window captures.
 * The database file is deliberately kept outside source control.
 */
export class AnalyticsDatabase {
  constructor(filePath) {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filePath);
    chmodSync(filePath, 0o600);
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.#migrate();
  }

  close() {
    this.db.close();
  }

  saveAuthToken(token) {
    this.db
      .prepare(
        `INSERT INTO auth_session (id, bearer_token, updated_at)
         VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET bearer_token = excluded.bearer_token, updated_at = excluded.updated_at`,
      )
      .run(token, now());
  }

  getAuthToken() {
    return this.db.prepare("SELECT bearer_token FROM auth_session WHERE id = 1").get()?.bearer_token ?? null;
  }

  saveGroup(group) {
    this.db
      .prepare(
        `INSERT INTO groups (id, name, metadata_json, collected_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, metadata_json = excluded.metadata_json, collected_at = excluded.collected_at`,
      )
      .run(group.id, typeof group.name === "string" ? group.name : null, JSON.stringify(group), now());
  }

  createSnapshot(groupId, windowStart, windowEnd, { runType = "baseline", parentSnapshotId = null, blockedPostId = null } = {}) {
    const id = crypto.randomUUID();
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO snapshot_runs (id, group_id, window_start, window_end, run_type, parent_snapshot_id, blocked_post_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'collecting', ?, ?)`,
      )
      .run(id, groupId, windowStart, windowEnd, runType, parentSnapshotId, blockedPostId, timestamp, timestamp);
    return id;
  }

  getResumableSnapshot(groupId, runType = "baseline", parentSnapshotId = null) {
    return this.db
      .prepare(
        `SELECT id, window_start, window_end, cursor, pages_fetched, posts_seen, posts_stored
         FROM snapshot_runs
         WHERE group_id = ? AND run_type = ? AND parent_snapshot_id IS ? AND status IN ('collecting', 'failed')
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(groupId, runType, parentSnapshotId) ?? null;
  }

  getCompletedSnapshot(groupId, runType = "baseline") {
    return this.db
      .prepare(
        `SELECT id, window_start, window_end, pages_fetched, posts_seen, posts_stored, completed_at
         FROM snapshot_runs
         WHERE group_id = ? AND run_type = ? AND status = 'complete'
         ORDER BY completed_at DESC
         LIMIT 1`,
      )
      .get(groupId, runType) ?? null;
  }

  getSnapshot(snapshotId) {
    return this.db
      .prepare(
        `SELECT id, group_id, window_start, window_end, run_type, parent_snapshot_id, blocked_post_id,
                status, cursor, pages_fetched, posts_seen, posts_stored, completed_at
         FROM snapshot_runs
         WHERE id = ?`,
      )
      .get(snapshotId) ?? null;
  }

  getNextBlockablePost(snapshotId) {
    return this.#getBlockablePosts(snapshotId)[0] ?? null;
  }

  countBlockablePosts(snapshotId) {
    return this.#getBlockablePosts(snapshotId).length;
  }

  #getBlockablePosts(snapshotId) {
    const candidates = this.db
      .prepare(
        `SELECT posts.id, posts.group_id, posts.created_at, posts.metadata_json
         FROM snapshot_posts
         JOIN posts ON posts.id = snapshot_posts.post_id
         WHERE snapshot_posts.snapshot_id = ?
         ORDER BY posts.created_at DESC, posts.id DESC`,
      )
      .all(snapshotId);
    return candidates.filter((post) => !isAuthoredByCurrentUser(post.metadata_json));
  }

  countSnapshotPosts(snapshotId) {
    return this.db
      .prepare("SELECT COUNT(*) AS count FROM snapshot_posts WHERE snapshot_id = ?")
      .get(snapshotId).count;
  }

  snapshotHasPost(snapshotId, postId) {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM snapshot_posts WHERE snapshot_id = ? AND post_id = ?")
        .get(snapshotId, postId),
    );
  }

  clearCaptures(groupId) {
    this.db.exec("BEGIN");
    try {
      this.db.prepare(
        `DELETE FROM raw_api_responses
         WHERE snapshot_id IN (SELECT id FROM snapshot_runs WHERE group_id = ?)`,
      ).run(groupId);
      this.db.prepare(
        `DELETE FROM snapshot_posts
         WHERE snapshot_id IN (SELECT id FROM snapshot_runs WHERE group_id = ?)`,
      ).run(groupId);
      this.db.prepare("DELETE FROM snapshot_runs WHERE group_id = ?").run(groupId);
      this.db.prepare(
        `DELETE FROM posts
         WHERE group_id = ?
           AND NOT EXISTS (SELECT 1 FROM snapshot_posts WHERE snapshot_posts.post_id = posts.id)`,
      ).run(groupId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  saveRawResponse(snapshotId, endpoint, page, payload) {
    this.db
      .prepare(
        `INSERT INTO raw_api_responses (snapshot_id, endpoint, page, collected_at, payload_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(snapshotId, endpoint, page, now(), JSON.stringify(payload));
  }

  savePost(snapshotId, post) {
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO posts (id, group_id, created_at, text, alias, vote_total, comment_count, metadata_json, collected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET vote_total = excluded.vote_total, comment_count = excluded.comment_count, metadata_json = excluded.metadata_json, collected_at = excluded.collected_at`,
      )
      .run(post.id, post.group_id, post.created_at, stringOrEmpty(post.text), stringOrNull(post.alias), numberOrNull(post.vote_total), numberOrNull(post.comment_count), JSON.stringify(post), timestamp);
    this.db
      .prepare("INSERT OR IGNORE INTO snapshot_posts (snapshot_id, post_id) VALUES (?, ?)")
      .run(snapshotId, post.id);
  }

  updateSnapshot(snapshotId, details) {
    this.db
      .prepare(
        `UPDATE snapshot_runs
         SET cursor = ?, pages_fetched = ?, posts_seen = ?, posts_stored = ?, status = ?, last_error = ?, completed_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(details.cursor, details.pagesFetched, details.postsSeen, details.postsStored, details.status, details.lastError ?? null, details.completedAt ?? null, now(), snapshotId);
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS auth_session (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        bearer_token TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        name TEXT,
        metadata_json TEXT NOT NULL,
        collected_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshot_runs (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        window_start TEXT NOT NULL,
        window_end TEXT NOT NULL,
        run_type TEXT NOT NULL DEFAULT 'baseline',
        parent_snapshot_id TEXT,
        blocked_post_id TEXT,
        status TEXT NOT NULL,
        cursor TEXT,
        pages_fetched INTEGER NOT NULL DEFAULT 0,
        posts_seen INTEGER NOT NULL DEFAULT 0,
        posts_stored INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS raw_api_responses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_id TEXT NOT NULL REFERENCES snapshot_runs(id),
        endpoint TEXT NOT NULL,
        page INTEGER NOT NULL,
        collected_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS posts (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        text TEXT NOT NULL,
        alias TEXT,
        vote_total INTEGER,
        comment_count INTEGER,
        metadata_json TEXT NOT NULL,
        collected_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshot_posts (
        snapshot_id TEXT NOT NULL REFERENCES snapshot_runs(id),
        post_id TEXT NOT NULL REFERENCES posts(id),
        PRIMARY KEY (snapshot_id, post_id)
      );
    `);
    this.#ensureColumn("snapshot_runs", "run_type", "TEXT NOT NULL DEFAULT 'baseline'");
    this.#ensureColumn("snapshot_runs", "parent_snapshot_id", "TEXT");
    this.#ensureColumn("snapshot_runs", "blocked_post_id", "TEXT");
  }

  #ensureColumn(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (columns.some((entry) => entry.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function now() {
  return new Date().toISOString();
}

function stringOrEmpty(value) {
  return typeof value === "string" ? value : "";
}

function stringOrNull(value) {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isAuthoredByCurrentUser(metadataJson) {
  try {
    return JSON.parse(metadataJson)?.authored_by_user === true;
  } catch {
    return false;
  }
}
