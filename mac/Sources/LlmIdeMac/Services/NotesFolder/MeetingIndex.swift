import Foundation
import SQLite3

final class MeetingIndex {
    struct Row: Equatable {
        let id: String
        let path: String
        let title: String?
        let startedAt: Int64
        let endedAt: Int64?
        let durationSec: Int?
        let gist: String?
        let tldrJSON: String?
        let actionsCount: Int
        let decisionsCount: Int
        let blockersCount: Int
        let fileMtime: Int64
        let fileSize: Int64
        let indexedAt: Int64
    }

    private var db: OpaquePointer?
    // sqlite3_bind_text needs a destructor pointer; SQLITE_TRANSIENT
    // tells sqlite to copy the buffer.  The macro is C-only, so we
    // re-create the (-1)-cast value once at module load.
    //
    // INVARIANT — DO NOT CHANGE TO SQLITE_STATIC:
    // `bindOpt` below passes Swift `String` directly into a
    // `UnsafePointer<CChar>` parameter via implicit bridging. That
    // creates a temporary C string whose lifetime ends at the end of
    // the call expression. Because the destructor is TRANSIENT,
    // sqlite copies the bytes before returning — safe. Swapping this
    // for SQLITE_STATIC (a tempting micro-opt) would have sqlite
    // record the dangling pointer and crash nondeterministically on
    // statement execution. If you need STATIC for some other call,
    // route it through `s.withCString { ... }` so the lifetime is
    // explicitly bound to the closure.
    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    init(url: URL) throws {
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard sqlite3_open_v2(url.path, &db,
                              SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX,
                              nil) == SQLITE_OK else {
            throw NSError(domain: "MeetingIndex", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "Cannot open sqlite at \(url.path)"])
        }
        try exec("PRAGMA journal_mode=WAL;")
        try exec("PRAGMA foreign_keys=ON;")
        // Wait (instead of failing immediately) when another connection holds the
        // write lock — two connections open this DB (folder indexer + auto-code
        // run); without this a concurrent write throws SQLITE_BUSY and aborts the
        // in-progress scan, leaving the index diverged from disk.
        try exec("PRAGMA busy_timeout=5000;")
        try migrate()
    }
    deinit { sqlite3_close(db) }

    /// Bump when the on-disk schema changes; add a matching `if current < N`
    /// migration step below. `PRAGMA user_version` gives us a real migration
    /// seam so a future schema change can `ALTER TABLE` instead of silently
    /// diverging from an old database.
    private static let schemaVersion = 1

    private func migrate() throws {
        let current = try userVersion()

        if current < 1 {
            try exec("""
            CREATE TABLE IF NOT EXISTS meetings_index (
              id              TEXT PRIMARY KEY,
              path            TEXT NOT NULL,
              title           TEXT,
              started_at      INTEGER NOT NULL,
              ended_at        INTEGER,
              duration_sec    INTEGER,
              gist            TEXT,
              tldr_json       TEXT,
              actions_count   INTEGER NOT NULL DEFAULT 0,
              decisions_count INTEGER NOT NULL DEFAULT 0,
              blockers_count  INTEGER NOT NULL DEFAULT 0,
              file_mtime      INTEGER NOT NULL,
              file_size       INTEGER NOT NULL,
              indexed_at      INTEGER NOT NULL
            );
            """)
            try exec("CREATE INDEX IF NOT EXISTS meetings_index_started_at ON meetings_index(started_at DESC);")
        }

        // Future migrations go here, e.g.:
        //   if current < 2 { try exec("ALTER TABLE meetings_index ADD COLUMN …;") }

        if current < Self.schemaVersion {
            try exec("PRAGMA user_version=\(Self.schemaVersion);")
        }
    }

    /// Read `PRAGMA user_version` (0 on a fresh database).
    private func userVersion() throws -> Int {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "PRAGMA user_version;", -1, &stmt, nil) == SQLITE_OK else {
            throw NSError(domain: "MeetingIndex", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "Failed to read schema version"])
        }
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_step(stmt) == SQLITE_ROW else { return 0 }
        return Int(sqlite3_column_int(stmt, 0))
    }

    func upsert(_ r: Row) throws {
        let sql = """
        INSERT INTO meetings_index (id,path,title,started_at,ended_at,duration_sec,
          gist,tldr_json,actions_count,decisions_count,blockers_count,
          file_mtime,file_size,indexed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          path=excluded.path, title=excluded.title,
          started_at=excluded.started_at, ended_at=excluded.ended_at,
          duration_sec=excluded.duration_sec, gist=excluded.gist,
          tldr_json=excluded.tldr_json, actions_count=excluded.actions_count,
          decisions_count=excluded.decisions_count, blockers_count=excluded.blockers_count,
          file_mtime=excluded.file_mtime, file_size=excluded.file_size,
          indexed_at=excluded.indexed_at;
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { throw err("prepare upsert") }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_text(stmt, 1, r.id, -1, Self.transient)
        sqlite3_bind_text(stmt, 2, r.path, -1, Self.transient)
        bindOpt(stmt, 3, r.title)
        sqlite3_bind_int64(stmt, 4, r.startedAt)
        if let e = r.endedAt { sqlite3_bind_int64(stmt, 5, e) } else { sqlite3_bind_null(stmt, 5) }
        if let d = r.durationSec { sqlite3_bind_int(stmt, 6, Int32(d)) } else { sqlite3_bind_null(stmt, 6) }
        bindOpt(stmt, 7, r.gist)
        bindOpt(stmt, 8, r.tldrJSON)
        sqlite3_bind_int(stmt, 9, Int32(r.actionsCount))
        sqlite3_bind_int(stmt, 10, Int32(r.decisionsCount))
        sqlite3_bind_int(stmt, 11, Int32(r.blockersCount))
        sqlite3_bind_int64(stmt, 12, r.fileMtime)
        sqlite3_bind_int64(stmt, 13, r.fileSize)
        sqlite3_bind_int64(stmt, 14, r.indexedAt)
        guard sqlite3_step(stmt) == SQLITE_DONE else { throw err("step upsert") }
    }

    func delete(id: String) throws {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "DELETE FROM meetings_index WHERE id = ?", -1, &stmt, nil) == SQLITE_OK
        else { throw err("prepare delete") }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_text(stmt, 1, id, -1, Self.transient)
        guard sqlite3_step(stmt) == SQLITE_DONE else { throw err("step delete") }
    }

    /// Runs `body` in a single transaction: commits on success, rolls back on
    /// throw. Makes a multi-row update (e.g. a full folder scan + reap) atomic,
    /// so a crash or error mid-scan can't leave the index half-updated.
    func transaction<T>(_ body: () throws -> T) throws -> T {
        try exec("BEGIN IMMEDIATE;")
        do {
            let result = try body()
            try exec("COMMIT;")
            return result
        } catch {
            try? exec("ROLLBACK;")
            throw error
        }
    }

    func list() throws -> [Row] {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, """
            SELECT id,path,title,started_at,ended_at,duration_sec,gist,tldr_json,
                   actions_count,decisions_count,blockers_count,
                   file_mtime,file_size,indexed_at
            FROM meetings_index ORDER BY started_at DESC;
            """, -1, &stmt, nil) == SQLITE_OK else { throw err("prepare list") }
        defer { sqlite3_finalize(stmt) }
        var out: [Row] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            out.append(rowFromStatement(stmt))
        }
        return out
    }

    func count() throws -> Int {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT COUNT(*) FROM meetings_index", -1, &stmt, nil) == SQLITE_OK
        else { throw err("prepare count") }
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_step(stmt) == SQLITE_ROW else { return 0 }
        return Int(sqlite3_column_int(stmt, 0))
    }

    func get(id: String) throws -> Row? {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, """
            SELECT id,path,title,started_at,ended_at,duration_sec,gist,tldr_json,
                   actions_count,decisions_count,blockers_count,
                   file_mtime,file_size,indexed_at
            FROM meetings_index WHERE id = ?
            """, -1, &stmt, nil) == SQLITE_OK else { throw err("prepare get") }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_text(stmt, 1, id, -1, Self.transient)
        guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }
        return rowFromStatement(stmt)
    }

    // MARK: helpers
    private func rowFromStatement(_ stmt: OpaquePointer?) -> Row {
        Row(
            id: textCol(stmt, 0) ?? "",
            path: textCol(stmt, 1) ?? "",
            title: textCol(stmt, 2),
            startedAt: sqlite3_column_int64(stmt, 3),
            endedAt: sqlite3_column_type(stmt, 4) == SQLITE_NULL ? nil : sqlite3_column_int64(stmt, 4),
            durationSec: sqlite3_column_type(stmt, 5) == SQLITE_NULL ? nil : Int(sqlite3_column_int(stmt, 5)),
            gist: textCol(stmt, 6),
            tldrJSON: textCol(stmt, 7),
            actionsCount: Int(sqlite3_column_int(stmt, 8)),
            decisionsCount: Int(sqlite3_column_int(stmt, 9)),
            blockersCount: Int(sqlite3_column_int(stmt, 10)),
            fileMtime: sqlite3_column_int64(stmt, 11),
            fileSize: sqlite3_column_int64(stmt, 12),
            indexedAt: sqlite3_column_int64(stmt, 13)
        )
    }

    private func exec(_ sql: String) throws {
        var errPtr: UnsafeMutablePointer<CChar>?
        if sqlite3_exec(db, sql, nil, nil, &errPtr) != SQLITE_OK {
            let msg = errPtr.flatMap { String(cString: $0) } ?? "?"
            sqlite3_free(errPtr)
            throw NSError(domain: "MeetingIndex", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: msg])
        }
    }
    private func err(_ what: String) -> Error {
        let msg = String(cString: sqlite3_errmsg(db))
        return NSError(domain: "MeetingIndex", code: 3,
                       userInfo: [NSLocalizedDescriptionKey: "\(what): \(msg)"])
    }
    private func textCol(_ stmt: OpaquePointer?, _ i: Int32) -> String? {
        guard let c = sqlite3_column_text(stmt, i) else { return nil }
        return String(cString: c)
    }
    private func bindOpt(_ stmt: OpaquePointer?, _ i: Int32, _ s: String?) {
        if let s = s { sqlite3_bind_text(stmt, i, s, -1, Self.transient) }
        else { sqlite3_bind_null(stmt, i) }
    }
}
