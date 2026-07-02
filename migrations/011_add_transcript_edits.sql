-- Corrección manual de transcripciones. transcript_original preserva SIEMPRE
-- el texto que salió de Whisper (se copia ahí en la 1ª corrección y ya no se
-- vuelve a tocar); transcript_edited_at sella la última corrección (mismo
-- formato que created_at). El frontend ofrece un toggle "ver original" que
-- alterna entre ambos sin volver a pedir nada al servidor.

ALTER TABLE media ADD COLUMN transcript_original TEXT;
ALTER TABLE media ADD COLUMN transcript_edited_at TEXT;
