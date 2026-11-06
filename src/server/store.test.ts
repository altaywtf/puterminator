import { describe, expect, it } from "vitest";
import { makeStore } from "./store";
import { memorySql } from "./testing/sqlite";

describe("store", () => {
  it("keeps the v1 files table writable by an earlier release while snapshots carry MIME types", () => {
    const sql = memorySql();
    sql.exec(`CREATE TABLE files (
    id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT NOT NULL, path TEXT NOT NULL, depth INTEGER NOT NULL,
    size INTEGER NOT NULL, file_type TEXT NOT NULL, extension TEXT, crc32 TEXT, created_at TEXT NOT NULL, first_accessed_at TEXT)`);
    sql.exec("INSERT INTO files VALUES (4, 0, 'Alien.mkv', '/Alien.mkv', 1, 1, 'VIDEO', 'mkv', NULL, '2026-01-01', NULL)");

    const store = makeStore(sql);
    expect(store.snapshot()).toMatchObject([{ id: 4, path: "/Alien.mkv", content_type: null }]);

    store.saveSnapshot([{ ...store.snapshot()[0]!, content_type: "video/x-matroska" }], 0);
    expect(makeStore(sql).snapshot()).toMatchObject([{ id: 4, content_type: "video/x-matroska" }]);

    sql.exec("DELETE FROM files");
    sql.exec("INSERT INTO files VALUES (5, 0, 'Heat.mkv', '/Heat.mkv', 1, 1, 'VIDEO', 'mkv', NULL, '2026-01-01', NULL)");
    expect(store.snapshot()).toMatchObject([{ id: 5, content_type: null }]);
  });
});
