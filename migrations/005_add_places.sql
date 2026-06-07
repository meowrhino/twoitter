-- Sitios guardados (geofence): cuando publicas con una ubicación CON NOMBRE +
-- coords y no hay ya un sitio guardado dentro de su radio, se guarda aquí. La
-- próxima vez que captures GPS cerca, el composer autorrellena el nombre.
-- Idempotente vía IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS places (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    radius REAL NOT NULL DEFAULT 150,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
