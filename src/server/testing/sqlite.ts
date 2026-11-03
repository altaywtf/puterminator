import { DatabaseSync } from "node:sqlite";
import type { Row, Sql } from "../store";

export const memorySql = (): Sql => {
  const db = new DatabaseSync(":memory:");

  return {
    // SAFETY: readBigInts is off, so node:sqlite returns integers as numbers and every column value fits Row.
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
