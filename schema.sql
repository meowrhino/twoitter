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
    -- kind: 'image' | 'video' | 'audio'. TEXT libre (sin CHECK) para que añadir
    -- tipos nuevos no requiera migrar la tabla.
    kind TEXT NOT NULL,
    r2_key TEXT NOT NULL,
    thumb_key TEXT,
    width INTEGER,
    height INTEGER,
    -- transcript: solo se rellena para kind='audio' tras llamar a /transcribe.
    -- NULL = aún no transcrito; cuando hay valor, el frontend lo muestra y no
    -- vuelve a llamar al modelo.
    transcript TEXT,
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

-- Para DBs existentes, correr migraciones (idempotentes pero ALTER falla si
-- ya está aplicada — seguro ignorar el error):
--   npm run db:migrate:001         (local)   -- añade posts.deleted_at
--   npm run db:migrate:001:remote  (prod)
--   npm run db:migrate:002         (local)   -- añade media.transcript
--   npm run db:migrate:002:remote  (prod)
