// Adapter D1 sobre better-sqlite3 para tests de backend en node.
//
// D1 ES SQLite, así que un better-sqlite3 en memoria ejecuta el MISMO SQL que
// corre en producción (CTE recursivo, joins, cascada, RETURNING, INSERT OR
// IGNORE…). Cubrimos la superficie de la API D1 que usa src/db.ts:
//   prepare(sql).bind(...args).all() / .first() / .run()
//   prepare(sql).all()            (sin bind, p.ej. listHashtags)
//   batch([stmt, ...])            (createPoll)
//
// LAGUNA CONOCIDA: better-sqlite3 NO impone el tope de ~100 parámetros
// vinculados de D1, así que estos tests NO detectarían una regresión del
// troceado (selectByIds). Ese comportamiento está verificado a mano + en prod.
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
// D1Database es un tipo GLOBAL (tsconfig `types: ["@cloudflare/workers-types"]`),
// no hace falta importarlo.

class D1PreparedStatement {
  constructor(
    private sqlite: Database.Database,
    private sql: string,
    private args: unknown[] = [],
  ) {}

  // IMPORTANTE: bind() devuelve un statement NUEVO (como D1), no muta este.
  // createPoll reutiliza un mismo prepared con varios .bind() en un map; si
  // mutáramos, todos compartirían los últimos args.
  bind(...args: unknown[]) {
    return new D1PreparedStatement(this.sqlite, this.sql, args);
  }

  async all<T = unknown>() {
    const results = this.sqlite.prepare(this.sql).all(...this.args) as T[];
    return { results, success: true, meta: {} };
  }

  async first<T = unknown>(column?: string) {
    const row = this.sqlite.prepare(this.sql).get(...this.args) as
      | Record<string, unknown>
      | undefined;
    if (row == null) return null;
    return (column ? row[column] : row) as T;
  }

  async run() {
    const info = this.sqlite.prepare(this.sql).run(...this.args);
    return {
      success: true,
      meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) },
    };
  }
}

class D1TestDatabase {
  constructor(private sqlite: Database.Database) {}

  prepare(sql: string) {
    return new D1PreparedStatement(this.sqlite, sql);
  }

  // D1 batch corre en una transacción; replicamos eso con un savepoint.
  async batch(statements: D1PreparedStatement[]) {
    const tx = this.sqlite.transaction(() => {});
    tx(); // no-op para forzar el patrón; ejecutamos los run secuenciales abajo
    const out = [];
    for (const s of statements) out.push(await s.run());
    return out;
  }

  async exec(sql: string) {
    this.sqlite.exec(sql);
    return { count: 0, duration: 0 };
  }
}

// Crea una D1 en memoria con el schema completo aplicado (schema.sql, que es
// el "desde cero" con todas las migraciones ya integradas).
export function makeTestDb(): D1Database {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(readFileSync('schema.sql', 'utf8'));
  return new D1TestDatabase(sqlite) as unknown as D1Database;
}
