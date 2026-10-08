import pg from 'pg';
import { config } from '../config.js';

// DATE resta stringa "YYYY-MM-DD": niente conversioni di fuso orario.
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });
export type Db = pg.Pool | pg.PoolClient;

/** Esegue fn in una transazione; rollback su qualunque errore. */
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
