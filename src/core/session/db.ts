import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';

const log = createLogger('db');

export interface Row {
  id: string;
  parent?: string;
  updatedAt: string;
  data: Record<string, unknown>;
}

export interface Database {
  readonly backend: 'sqlite' | 'json';
  upsert(table: string, row: Row): void;
  get(table: string, id: string): Row | undefined;
  all(table: string, parent?: string): Row[];
  remove(table: string, id: string): void;
  close(): void;
}

export const TABLES = [
  'projects',
  'sessions',
  'messages',
  'tasks',
  'task_steps',
  'checkpoints',
  'permissions',
  'settings',
  'logs',
  'project_memory',
  'agent_state'
] as const;

/**
 * SQLite backend using Node's built-in `node:sqlite` (Node >= 22.5 / Electron >= 33).
 * Falls back to a durable JSON backend when the module is unavailable, so the
 * application never fails to start because of a native-module problem.
 */
export async function openDatabase(file: string): Promise<Database> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const { DatabaseSync } = (await import('node:sqlite')) as typeof import('node:sqlite');
    return new SqliteDatabase(new DatabaseSync(file));
  } catch (err) {
    log.warn('node:sqlite unavailable, using JSON persistence', { reason: (err as Error).message });
    return new JsonDatabase(file.replace(/\.db$/, '.json'));
  }
}

class SqliteDatabase implements Database {
  readonly backend = 'sqlite' as const;

  constructor(private db: import('node:sqlite').DatabaseSync) {
    this.db.exec('PRAGMA journal_mode = WAL;');
    for (const table of TABLES) {
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS ${table} (
           id TEXT PRIMARY KEY,
           parent TEXT,
           updated_at TEXT NOT NULL,
           data TEXT NOT NULL
         );`
      );
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_parent ON ${table}(parent);`);
    }
  }

  private assertTable(table: string): void {
    if (!(TABLES as readonly string[]).includes(table)) throw new Error(`Unknown table "${table}".`);
  }

  upsert(table: string, row: Row): void {
    this.assertTable(table);
    this.db
      .prepare(
        `INSERT INTO ${table} (id, parent, updated_at, data) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET parent = excluded.parent, updated_at = excluded.updated_at, data = excluded.data;`
      )
      .run(row.id, row.parent ?? null, row.updatedAt, JSON.stringify(row.data));
  }

  get(table: string, id: string): Row | undefined {
    this.assertTable(table);
    const r = this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as any;
    return r ? { id: r.id, parent: r.parent ?? undefined, updatedAt: r.updated_at, data: JSON.parse(r.data) } : undefined;
  }

  all(table: string, parent?: string): Row[] {
    this.assertTable(table);
    const rows = (
      parent === undefined
        ? this.db.prepare(`SELECT * FROM ${table} ORDER BY updated_at DESC`).all()
        : this.db.prepare(`SELECT * FROM ${table} WHERE parent = ? ORDER BY updated_at ASC`).all(parent)
    ) as any[];
    return rows.map((r) => ({ id: r.id, parent: r.parent ?? undefined, updatedAt: r.updated_at, data: JSON.parse(r.data) }));
  }

  remove(table: string, id: string): void {
    this.assertTable(table);
    this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

class JsonDatabase implements Database {
  readonly backend = 'json' as const;
  private state: Record<string, Row[]> = {};
  private writeTimer: NodeJS.Timeout | null = null;

  constructor(private file: string) {
    try {
      if (fs.existsSync(file)) this.state = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      this.state = {};
    }
    for (const table of TABLES) this.state[table] ??= [];
  }

  private persist(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      const tmp = `${this.file}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(this.state));
        fs.renameSync(tmp, this.file);
      } catch (err) {
        log.error('Failed to persist JSON database', { reason: (err as Error).message });
      }
    }, 50);
    this.writeTimer.unref?.();
  }

  upsert(table: string, row: Row): void {
    const list = (this.state[table] ??= []);
    const index = list.findIndex((r) => r.id === row.id);
    if (index >= 0) list[index] = row;
    else list.push(row);
    this.persist();
  }

  get(table: string, id: string): Row | undefined {
    return (this.state[table] ?? []).find((r) => r.id === id);
  }

  all(table: string, parent?: string): Row[] {
    const list = this.state[table] ?? [];
    const filtered = parent === undefined ? [...list] : list.filter((r) => r.parent === parent);
    return parent === undefined ? filtered.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) : filtered;
  }

  remove(table: string, id: string): void {
    this.state[table] = (this.state[table] ?? []).filter((r) => r.id !== id);
    this.persist();
  }

  close(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.state));
    } catch {
      /* ignore */
    }
  }
}
