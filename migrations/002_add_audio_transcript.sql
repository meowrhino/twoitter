-- Audio notes + transcripción.
-- - media.kind ahora admite 'audio' (es TEXT libre, no necesita cambio de schema).
-- - transcript: si el media es audio, guardamos aquí el texto transcrito por
--   Workers AI (Whisper) la primera vez. NULL = aún no transcrito.
-- ALTER TABLE no soporta IF NOT EXISTS: si ya corriste esta migration, te dará
-- error de "duplicate column" — es seguro ignorarlo (la columna ya existe).

ALTER TABLE media ADD COLUMN transcript TEXT;
