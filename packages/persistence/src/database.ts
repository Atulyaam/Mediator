/**
 * @mediator/persistence — SQLite Database Connection & Lifecycle (S10)
 *
 * Requirements:
 * - Uses native node:sqlite DatabaseSync for zero external native build dependencies.
 * - Stores the database in a fixed Mediator-managed application-data location, not an AI-selected path.
 * - Enforces PRAGMA foreign_keys = ON, PRAGMA journal_mode = WAL, PRAGMA busy_timeout = 5000.
 * - Enforces atomic transaction semantics (with savepoints for nested transactions).
 * - Never silently falls back to volatile in-memory persistence when durable persistence is requested.
 * - Encapsulates raw SQL behind typed repository interfaces; raw arbitrary SQL is not exposed to UI or AI.
 */

import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType, StatementSync } from 'node:sqlite';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { PersistenceError, PersistenceErrorCode } from './errors.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

export interface DatabaseOptions {
  /**
   * File path to the SQLite database, or ':memory:' for tests.
   * If omitted, defaults to the canonical Mediator application-data location.
   */
  readonly path?: string | undefined;
  /**
   * If true, disables WAL pragma (useful for in-memory databases).
   */
  readonly isMemory?: boolean | undefined;
}

export function getDefaultDatabasePath(): string {
  // Fixed application data location
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Mediator', 'data', 'mediator.db');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Mediator', 'data', 'mediator.db');
  }
  const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(xdgData, 'mediator', 'mediator.db');
}

export class DatabaseConnection {
  private db: DatabaseSyncType | null = null;
  private readonly dbPath: string;
  private readonly isMem: boolean;
  private transactionDepth = 0;

  constructor(options: DatabaseOptions = {}) {
    if (options.path === ':memory:' || options.isMemory === true) {
      this.dbPath = ':memory:';
      this.isMem = true;
    } else if (options.path) {
      this.dbPath = path.resolve(options.path);
      this.isMem = false;
    } else {
      this.dbPath = getDefaultDatabasePath();
      this.isMem = false;
    }
  }

  public open(): void {
    if (this.db) {
      return; // Already open
    }

    try {
      if (!this.isMem) {
        const dir = path.dirname(this.dbPath);
        if (!fs.existsSync(dir)) {
          // User-only permissions where practical (0o700)
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        }
      }

      this.db = new DatabaseSync(this.dbPath);

      // Configure safe connection PRAGMAs
      this.db.exec('PRAGMA foreign_keys = ON;');
      this.db.exec('PRAGMA busy_timeout = 5000;');

      if (!this.isMem) {
        this.db.exec('PRAGMA journal_mode = WAL;');
        this.db.exec('PRAGMA synchronous = NORMAL;');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.db = null;
      throw new PersistenceError(
        PersistenceErrorCode.DATABASE_UNAVAILABLE,
        `Failed to open SQLite database at '${this.dbPath}': ${msg}`,
        { path: this.dbPath, error: msg },
      );
    }
  }

  public close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new PersistenceError(
          PersistenceErrorCode.DATABASE_CORRUPT,
          `Error closing SQLite database: ${msg}`,
          { error: msg },
        );
      } finally {
        this.db = null;
        this.transactionDepth = 0;
      }
    }
  }

  public isOpen(): boolean {
    return this.db !== null;
  }

  public isMemory(): boolean {
    return this.isMem;
  }

  public getPath(): string {
    return this.dbPath;
  }

  private ensureOpen(): DatabaseSyncType {
    if (!this.db) {
      throw new PersistenceError(
        PersistenceErrorCode.DATABASE_UNAVAILABLE,
        'Database connection is closed. Call open() first.',
      );
    }
    return this.db;
  }

  public exec(sql: string): void {
    const db = this.ensureOpen();
    try {
      db.exec(sql);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('FOREIGN KEY constraint failed')) {
        throw new PersistenceError(PersistenceErrorCode.CONSTRAINT_VIOLATION, msg, { sql });
      }
      if (msg.includes('UNIQUE constraint failed')) {
        throw new PersistenceError(PersistenceErrorCode.CONSTRAINT_VIOLATION, msg, { sql });
      }
      throw new PersistenceError(PersistenceErrorCode.DATABASE_CORRUPT, msg, { sql });
    }
  }

  public prepare(sql: string): StatementSync {
    const db = this.ensureOpen();
    try {
      return db.prepare(sql);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new PersistenceError(PersistenceErrorCode.DATABASE_CORRUPT, msg, { sql });
    }
  }

  public inTransaction(): boolean {
    return this.transactionDepth > 0;
  }

  /**
   * Executes callback inside an atomic transaction.
   * If already inside a transaction, uses savepoints to allow nested transactions.
   */
  public transaction<T>(fn: () => T): T {
    const db = this.ensureOpen();
    const isRoot = this.transactionDepth === 0;
    const savepointName = `sp_${this.transactionDepth}`;

    if (isRoot) {
      db.exec('BEGIN IMMEDIATE;');
    } else {
      db.exec(`SAVEPOINT ${savepointName};`);
    }

    this.transactionDepth++;

    try {
      const result = fn();
      if (isRoot) {
        db.exec('COMMIT;');
      } else {
        db.exec(`RELEASE SAVEPOINT ${savepointName};`);
      }
      return result;
    } catch (err: unknown) {
      try {
        if (isRoot) {
          db.exec('ROLLBACK;');
        } else {
          db.exec(`ROLLBACK TO SAVEPOINT ${savepointName};`);
        }
      } catch {
        // Ignore rollback failure if already rolled back
      }

      if (err instanceof PersistenceError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('FOREIGN KEY constraint failed') || msg.includes('UNIQUE constraint failed')) {
        throw new PersistenceError(PersistenceErrorCode.CONSTRAINT_VIOLATION, msg, { error: msg });
      }
      throw new PersistenceError(PersistenceErrorCode.TRANSACTION_FAILED, `Transaction failed: ${msg}`, { error: msg });
    } finally {
      this.transactionDepth--;
    }
  }
}
