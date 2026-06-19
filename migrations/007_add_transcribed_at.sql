-- Hora de transcripción por audio.
-- media.transcribed_at: ISO UTC en que se llamó a Whisper y se guardó el texto.
-- El frontend lo pinta como "transcrito a las HH:MM" bajo la transcripción.
-- ALTER TABLE no soporta IF NOT EXISTS: si ya corriste esta migration, dará
-- "duplicate column" — es seguro ignorarlo.
ALTER TABLE media ADD COLUMN transcribed_at TEXT;
