-- Dueño de cada sitio guardado. Hoy hay un solo usuario → todos 'me'. Pensado
-- para multi-usuario futuro: solo el dueño podrá editar/eliminar su sitio.
-- ALTER no soporta IF NOT EXISTS: si ya corriste esta migración dará "duplicate
-- column", seguro ignorarlo. NOT NULL DEFAULT da valor a las filas existentes.

ALTER TABLE places ADD COLUMN owner TEXT NOT NULL DEFAULT 'me';
