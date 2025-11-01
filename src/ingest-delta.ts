#!/usr/bin/env node
// src/ingest-delta.ts
//
// Read NDJSON deltas (with RELATIVE paths) from stdin and mirror them into a
// local files/dirs/links tables.
//
// Usage:
//   node dist/ingest-delta.js --db alpha.db
//
// Example over SSH:
//   ssh -C user@alpha 'node /path/dist/scan.js --root /alpha/root --emit-delta' \
//     | node dist/ingest-delta.js --db alpha.db
//
// NOTE: Deltas must contain relative paths now. No --root filtering is needed.

import readline from "node:readline";
import { getDb } from "./db.js";
import { Command } from "commander";
import { cliEntrypoint } from "./cli-util.js";
import { CLI_NAME } from "./constants.js";
import { ConsoleLogger, type Logger, type LogLevel } from "./logger.js";

// SAFETY_MS, FUTURE_SLACK_MS and CAP_BACKOFF_MS are for skew/future handling.
// See comments in the original version for rationale.
const SAFETY_MS = Number(process.env.REFLECT_CLOCK_SKEW_SAFETY_MS ?? 100);
const FUTURE_SLACK_MS = Number(process.env.REFLECT_FUTURE_SLACK_MS ?? 400);
const CAP_BACKOFF_MS = Number(process.env.REFLECT_FUTURE_CAP_BACKOFF_MS ?? 1);

function buildProgram(): Command {
  const program = new Command()
    .name(`${CLI_NAME}-ingest-delta`)
    .description("Ingest NDJSON deltas from stdin into a local sqlite db");

  program.requiredOption("--db <path>", "sqlite db file");

  return program;
}

export interface IngestDeltaOptions {
  db: string;
  logger?: Logger;
  logLevel?: LogLevel;
  input?: NodeJS.ReadableStream;
  abortSignal?: AbortSignal;
}

export async function runIngestDelta(opts: IngestDeltaOptions): Promise<void> {
  const {
    db: dbPath,
    logger: providedLogger,
    logLevel = "info",
    input = process.stdin,
    abortSignal,
  } = opts;
  const logger = providedLogger ?? new ConsoleLogger(logLevel);

  let skew: number | null = null; // local time = remote time + skew
  const nowLocal = () => Date.now();

  // Per-path monotonic timestamp (prevents going backwards when lines reorder)
  const lastByPath = new Map<string, number>();
  function monotonicFor(path: string, t: number) {
    const last = lastByPath.get(path) ?? -Infinity;
    const next = t <= last ? last + 1 : t;
    lastByPath.set(path, next);
    return next;
  }

  const adjustRemoteTime = (ts: number | undefined) => {
    const n = nowLocal();
    const base = Number.isFinite(ts as any) ? Number(ts) : n;
    let t = base + (skew ?? 0);
    // Cap far-future timestamps (allow a little slack)
    if (t > n + FUTURE_SLACK_MS) {
      t = n - CAP_BACKOFF_MS;
    }
    return t;
  };

  // ---------- db ----------
  const db = getDb(dbPath);
  let processedRows = 0;
  let closed = false;
  logger.info("ingest start", { db: dbPath });

  // Files: upsert minimal metadata; only overwrite hash/hashed_ctime when provided
  const upsertFile = db.prepare(`
INSERT INTO files(path, size, ctime, mtime, op_ts, hash, deleted, last_seen, hashed_ctime)
VALUES (@path, @size, @ctime, @mtime, @op_ts, @hash, @deleted, @now, @hashed_ctime)
ON CONFLICT(path) DO UPDATE SET
  -- apply only if the incoming event is as new or newer:
  size         = CASE WHEN excluded.op_ts >= files.op_ts
                      THEN COALESCE(excluded.size, files.size) ELSE files.size END,
  ctime        = CASE WHEN excluded.op_ts >= files.op_ts
                      THEN COALESCE(excluded.ctime, files.ctime) ELSE files.ctime END,
  mtime        = CASE WHEN excluded.op_ts >= files.op_ts
                      THEN COALESCE(excluded.mtime, files.mtime) ELSE files.mtime END,
  op_ts        = CASE WHEN excluded.op_ts >= files.op_ts
                      THEN excluded.op_ts ELSE files.op_ts END,
  hash         = CASE WHEN excluded.op_ts >= files.op_ts
                      THEN COALESCE(excluded.hash, files.hash) ELSE files.hash END,
  hashed_ctime = CASE WHEN excluded.op_ts >= files.op_ts
                      THEN COALESCE(excluded.hashed_ctime, files.hashed_ctime)
                      ELSE files.hashed_ctime END,
  deleted      = CASE WHEN excluded.op_ts >= files.op_ts
                      THEN excluded.deleted ELSE files.deleted END,
  -- always keep the freshest sighting time:
  last_seen    = CASE WHEN excluded.last_seen > files.last_seen
                      THEN excluded.last_seen ELSE files.last_seen END
`);

  // Directories: presence/meta only (hash typically carries mode bits etc.)
  const upsertDir = db.prepare(`
INSERT INTO dirs(path, ctime, mtime, op_ts, hash, deleted, last_seen)
VALUES (@path, @ctime, @mtime, @op_ts, @hash, @deleted, @now)
ON CONFLICT(path) DO UPDATE SET
  ctime     = CASE WHEN excluded.op_ts >= dirs.op_ts
                   THEN COALESCE(excluded.ctime, dirs.ctime) ELSE dirs.ctime END,
  mtime     = CASE WHEN excluded.op_ts >= dirs.op_ts
                   THEN COALESCE(excluded.mtime, dirs.mtime) ELSE dirs.mtime END,
  op_ts     = CASE WHEN excluded.op_ts >= dirs.op_ts
                   THEN excluded.op_ts ELSE dirs.op_ts END,
  hash      = CASE WHEN excluded.op_ts >= dirs.op_ts
                   THEN excluded.hash ELSE dirs.hash END,
  deleted   = CASE WHEN excluded.op_ts >= dirs.op_ts
                   THEN excluded.deleted ELSE dirs.deleted END,
  last_seen = CASE WHEN excluded.last_seen > dirs.last_seen
                   THEN excluded.last_seen ELSE dirs.last_seen END
`);

  // Symlinks: store target + hash of target string for change detection
  const upsertLink = db.prepare(`
INSERT INTO links(path, target, ctime, mtime, op_ts, hash, deleted, last_seen)
VALUES (@path, @target, @ctime, @mtime, @op_ts, @hash, @deleted, @now)
ON CONFLICT(path) DO UPDATE SET
  target    = CASE WHEN excluded.op_ts >= links.op_ts
                   THEN COALESCE(excluded.target, links.target) ELSE links.target END,
  ctime     = CASE WHEN excluded.op_ts >= links.op_ts
                   THEN COALESCE(excluded.ctime, links.ctime) ELSE links.ctime END,
  mtime     = CASE WHEN excluded.op_ts >= links.op_ts
                   THEN COALESCE(excluded.mtime, links.mtime) ELSE links.mtime END,
  op_ts     = CASE WHEN excluded.op_ts >= links.op_ts
                   THEN excluded.op_ts ELSE links.op_ts END,
  hash      = CASE WHEN excluded.op_ts >= links.op_ts
                   THEN COALESCE(excluded.hash, links.hash) ELSE links.hash END,
  deleted   = CASE WHEN excluded.op_ts >= links.op_ts
                   THEN excluded.deleted ELSE links.deleted END,
  last_seen = CASE WHEN excluded.last_seen > links.last_seen
                   THEN excluded.last_seen ELSE links.last_seen END
`);

  const insTouch = db.prepare(
    `INSERT OR REPLACE INTO recent_touch(path, ts) VALUES (?, ?)`,
  );

  const tx = db.transaction((rows: any[]) => {
    if (!rows.length) return;
    processedRows += rows.length;
    logger.debug("ingest batch", { rows: rows.length });
    const now = Date.now();
    for (const r of rows) {
      if (r.kind === "time") {
        // special event conveying the remote "now" for skew calc
        const remoteNow = Number(r.remote_now_ms);
        if (Number.isFinite(remoteNow)) {
          // Upper-bound skew (includes network delay), minus safety if remote is behind
          let s = nowLocal() - remoteNow;
          if (s > 0) {
            s = Math.max(0, s - SAFETY_MS);
          }
          skew = s;
        }
        continue;
      }

      // All paths are RELATIVE now; just ingest.
      const isDelete = r.deleted === 1;
      const op_ts = monotonicFor(r.path, adjustRemoteTime(r.op_ts));
      if (r.path == null) {
        throw Error(`invalid data -- ${JSON.stringify(r)}`);
      }

      if (r.kind === "dir") {
        upsertDir.run({
          path: r.path,
          ctime: isDelete ? null : (r.ctime ?? null),
          mtime: isDelete ? null : (r.mtime ?? null),
          hash: r.hash ?? null,
          op_ts,
          deleted: isDelete ? 1 : 0,
          now,
        });
      } else if (r.kind === "link") {
        upsertLink.run({
          path: r.path,
          target: isDelete ? null : (r.target ?? null),
          ctime: isDelete ? null : (r.ctime ?? null),
          mtime: isDelete ? null : (r.mtime ?? null),
          op_ts,
          hash: isDelete ? null : (r.hash ?? null),
          deleted: isDelete ? 1 : 0,
          now,
        });
      } else {
        // default: file row
        if (isDelete) {
          // always apply deletes
          upsertFile.run({
            path: r.path,
            size: null,
            ctime: null,
            mtime: null,
            op_ts,
            hash: null,
            deleted: 1,
            now,
            hashed_ctime: null,
          });
          insTouch.run(r.path, now);
        } else if (r.hash == null) {
          // came from watch without a hash: don't poison the DB with NULL hashes
          // still mark as touched so hot watching favors this area
          insTouch.run(r.path, now);
          // (intentionally skip upsertFile)
        } else {
          // proper hashed file delta (from scan, or hashed watch)
          upsertFile.run({
            path: r.path,
            size: r.size ?? null,
            ctime: r.ctime ?? null,
            mtime: r.mtime ?? r.op_ts ?? null,
            op_ts,
            hash: r.hash,
            deleted: 0,
            now,
            hashed_ctime: r.ctime ?? null,
          });
          insTouch.run(r.path, now);
        }
      }
    }
  });

  let buf: any[] = [];
  const BATCH = 5000;
  function flush() {
    if (!buf.length) return;
    tx(buf);
    buf.length = 0;
  }

  const finalize = () => {
    if (closed) return;
    closed = true;
    logger.info("ingest complete", { rows: processedRows, db: dbPath });
    db.close();
  };

  await new Promise<void>((resolve, reject) => {
    const rl = readline.createInterface({ input });

    function handleLine(line: string) {
      if (!line) return;
      try {
        const r = JSON.parse(line);
        buf.push(r);
        if (buf.length >= BATCH) {
          flush();
        }
      } catch (err) {
        logger.warn("ingest skipped malformed line", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    function handleError(err: unknown) {
      rl.removeListener("line", handleLine);
      rl.removeAllListeners();
      cleanup();
      finalize();
      reject(err instanceof Error ? err : new Error(String(err)));
    }

    function handleClose() {
      rl.removeListener("line", handleLine);
      rl.removeAllListeners();
      cleanup();
      try {
        flush();
        finalize();
        resolve();
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    }

    function handleSigint() {
      cleanup();
      flush();
      finalize();
      process.exit(0);
    }

    function onAbort() {
      cleanup();
      rl.close();
      reject(new Error("ingest aborted"));
    }

    function cleanup() {
      input.off("error", handleError);
      rl.off("close", handleClose);
      if (input === process.stdin) {
        process.off("SIGINT", handleSigint);
      }
      if (abortSignal) {
        abortSignal.removeEventListener("abort", onAbort);
      }
    }

    rl.on("line", handleLine);
    rl.once("close", handleClose);
    input.once("error", handleError);

    if (input === process.stdin) {
      process.on("SIGINT", handleSigint);
    }

    if (abortSignal) {
      if (abortSignal.aborted) {
        onAbort();
      } else {
        abortSignal.addEventListener("abort", onAbort);
      }
    }
  });
}

cliEntrypoint<IngestDeltaOptions>(
  import.meta.url,
  buildProgram,
  runIngestDelta,
  { label: "ingest" },
);
