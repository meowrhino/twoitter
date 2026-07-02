-- Edición de posts. edited_at: NULL = nunca editado; ISO timestamp = sellado
-- al guardar una edición (mismo formato que created_at). El frontend lo usa
-- para mostrar el sello "editado el ...".

ALTER TABLE posts ADD COLUMN edited_at TEXT;
