-- Ubicación opcional por post: una etiqueta de texto (la que se muestra) +
-- coords opcionales (lat/lng) capturadas por el botón "ubicación" del composer
-- para enlazar a un mapa.
-- ALTER TABLE no soporta IF NOT EXISTS: si ya corriste esta migración te dará
-- "duplicate column". Es seguro ignorarlo (las columnas ya existen). Si falla
-- a mitad (una columna sí, otra no), re-aplica solo el ALTER que falta.

ALTER TABLE posts ADD COLUMN location TEXT;
ALTER TABLE posts ADD COLUMN lat REAL;
ALTER TABLE posts ADD COLUMN lng REAL;
