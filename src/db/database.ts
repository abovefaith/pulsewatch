import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrations } from './migrations.ts';

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): number {
  const { user_version: current } = db.prepare('PRAGMA user_version').get() as {
    user_version: number;
  };

  for (const [index, sql] of migrations.entries()) {
    const version = index + 1;
    if (version <= current) continue;
    transaction(db, () => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${version}`);
    });
  }
  return migrations.length;
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
