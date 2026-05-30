import { Pool } from 'pg';
import { getSecrets } from './secrets';

let poolPromise: Promise<Pool> | null = null;

async function getPool(): Promise<Pool> {
  if (!poolPromise) {
    poolPromise = (async () => {
      const { DB_PASSWORD } = await getSecrets();
      return new Pool({
        host: process.env.DB_HOST,
        port: parseInt(process.env.DB_PORT || '5432', 10),
        database: process.env.DB_NAME || 'wisprnote',
        user: process.env.DB_USER,
        password: DB_PASSWORD,
        ssl: { rejectUnauthorized: false },
        max: 5,
        idleTimeoutMillis: 60000,
        connectionTimeoutMillis: 10000,
      });
    })();
  }
  return poolPromise;
}

export async function query<T = any>(text: string, values?: any[]): Promise<T[]> {
  const pool = await getPool();
  const result = await pool.query(text, values);
  return result.rows as T[];
}

export async function queryOne<T = any>(text: string, values?: any[]): Promise<T | null> {
  const rows = await query<T>(text, values);
  return rows[0] ?? null;
}

export async function queryCount(text: string, values?: any[]): Promise<number> {
  const rows = await query<{ count: string }>(text, values);
  return parseInt(rows[0]?.count || '0', 10);
}
