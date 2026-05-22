-- Soft delete: añade deleted_at a posts existentes.
-- Idempotente vía CREATE INDEX IF NOT EXISTS, pero ALTER TABLE no soporta
-- IF NOT EXISTS: si ya corriste esta migration, te dará error. Es seguro
-- ignorarlo (la columna ya existe).

ALTER TABLE posts ADD COLUMN deleted_at TEXT;
CREATE INDEX IF NOT EXISTS idx_posts_deleted ON posts(deleted_at);
