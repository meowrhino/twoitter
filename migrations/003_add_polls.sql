-- Encuestas (polls). Una encuesta "pertenece" a un post: el texto del post
-- hace de pregunta y las opciones cuelgan aparte. Decisiones tomadas
-- (ver SESSION-RECAP / hilo de diseño):
--   - 2..N opciones, una sola elección por votante.
--   - resultados siempre visibles (públicos).
--   - sin caducidad (no closes_at): mientras el post viva, se puede votar.
--   - voto inmutable: la PK (post_id, voter_id) en poll_votes garantiza
--     un solo voto por persona; un segundo POST devuelve "ya votaste".
--   - votante anónimo: cookie firmada tv_id (HMAC con AUTH_SECRET).
--
-- CREATE TABLE IF NOT EXISTS hace esta migración idempotente — a
-- diferencia de las 001/002 que usaban ALTER TABLE.

CREATE TABLE IF NOT EXISTS polls (
    post_id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS poll_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    label TEXT NOT NULL,
    FOREIGN KEY (post_id) REFERENCES polls(post_id) ON DELETE CASCADE
);

-- voter_id = uuid v4 guardado en cookie firmada `tv_id`. Lo emite el
-- servidor la primera vez que alguien intenta votar.
CREATE TABLE IF NOT EXISTS poll_votes (
    post_id INTEGER NOT NULL,
    voter_id TEXT NOT NULL,
    option_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (post_id, voter_id),
    FOREIGN KEY (post_id) REFERENCES polls(post_id) ON DELETE CASCADE,
    FOREIGN KEY (option_id) REFERENCES poll_options(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_poll_options_post ON poll_options(post_id, position);
CREATE INDEX IF NOT EXISTS idx_poll_votes_option ON poll_votes(option_id);
