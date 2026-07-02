-- Letras (lyrics). Un post puede llevar uno o más bloques de texto con
-- etiqueta libre (p.ej. "Original", "Romaji", "English") para citar letras de
-- canciones en varios idiomas/versiones, más una fuente opcional para dejar
-- siempre citado de dónde sale. Mismo patrón que polls: `lyrics` es 1:1 con
-- el post (post_id como PK), `lyrics_blocks` cuelga de ella por posición.
--
-- CREATE TABLE IF NOT EXISTS hace esta migración idempotente.

CREATE TABLE IF NOT EXISTS lyrics (
    post_id INTEGER PRIMARY KEY,
    source TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS lyrics_blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    label TEXT NOT NULL,
    text TEXT NOT NULL,
    FOREIGN KEY (post_id) REFERENCES lyrics(post_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_lyrics_blocks_post ON lyrics_blocks(post_id, position);
