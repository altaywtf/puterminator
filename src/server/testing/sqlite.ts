import { DatabaseSync } from "node:sqlite";
import type { Row, Sql } from "../store";

/** Real SQLite in memory, in place of Durable Object storage. */
export const memorySql = (): Sql & { db: DatabaseSync } => {
  const db = new DatabaseSync(":memory:");
  return {
    db,
    exec: (query, ...bindings) => db.prepare(query).all(...bindings) as Array<Row>,
    transaction: (body) => {
      db.exec("BEGIN");
      try {
        const result = body();
        db.exec("COMMIT");
        return result;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
};
