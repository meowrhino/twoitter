CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT,
    parent_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    -- Soft delete: NULL = visible; ISO timestamp = en papelera. Los assets
    -- de R2 se conservan para poder restaurar. Filtramos en listPosts/getPost.
    deleted_at TEXT,
    FOREIGN KEY (parent_id) REFERENCES posts(id)
);

CREATE TABLE IF NOT EXISTS media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    r2_key TEXT NOT NULL,
    thumb_key TEXT,
    width INTEGER,
    height INTEGER,
    position INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS hashtags (
    post_id INTEGER NOT NULL,
    tag TEXT NOT NULL,
    PRIMARY KEY (post_id, tag),
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_posts_parent_created ON posts(parent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_posts_deleted ON posts(deleted_at);
CREATE INDEX IF NOT EXISTS idx_media_post ON media(post_id, position);
CREATE INDEX IF NOT EXISTS idx_hashtags_tag ON hashtags(tag);

-- Para DBs existentes pre-deleted_at, correr una vez:
--   npm run db:migrate:001         (local)
--   npm run db:migrate:001:remote  (producción)
