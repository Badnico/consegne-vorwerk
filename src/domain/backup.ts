import { gzipSync, gunzipSync } from 'node:zlib';
import type pg from 'pg';
import { pool } from '../lib/db.js';

/**
 * Backup completo del database: tutte le tabelle dello schema "public"
 * (ambienti, consegne, clienti, slot, impostazioni, messaggi, report, utenti…)
 * in un unico file JSON compresso. La coda dei lavori (schema pgboss) non serve:
 * si ricrea da sola all'avvio.
 */
export interface BackupFile {
  format: 'consegne-backup';
  version: 1;
  createdAt: string;
  tables: Record<string, unknown[]>;
}

async function tablesInOrder(c: pg.Pool | pg.PoolClient): Promise<string[]> {
  const { rows } = await c.query<{ name: string }>(
    `SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`);
  const names = rows.map((r) => r.name);
  const { rows: fks } = await c.query<{ child: string; parent: string }>(
    `SELECT cl.relname AS child, pr.relname AS parent
       FROM pg_constraint k
       JOIN pg_class cl ON cl.oid = k.conrelid
       JOIN pg_class pr ON pr.oid = k.confrelid
       JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE k.contype = 'f' AND n.nspname = 'public' AND cl.relname <> pr.relname`);
  // ordine in cui i "genitori" vengono prima dei "figli" (serve per il ripristino)
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (t: string, stack = new Set<string>()) => {
    if (seen.has(t) || stack.has(t)) return;
    stack.add(t);
    for (const f of fks) if (f.child === t) visit(f.parent, stack);
    seen.add(t);
    out.push(t);
  };
  names.forEach((n) => visit(n));
  return out;
}

export async function createBackup(): Promise<{ file: Buffer; name: string; counts: Record<string, number> }> {
  const client = await pool.connect();
  try {
    // istantanea coerente di tutte le tabelle
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tables: Record<string, unknown[]> = {};
    const counts: Record<string, number> = {};
    for (const t of await tablesInOrder(client)) {
      const { rows } = await client.query(`SELECT coalesce(json_agg(x), '[]'::json) AS data FROM "${t}" x`);
      tables[t] = rows[0].data;
      counts[t] = tables[t].length;
    }
    await client.query('COMMIT');
    const body: BackupFile = { format: 'consegne-backup', version: 1, createdAt: new Date().toISOString(), tables };
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
    return { file: gzipSync(JSON.stringify(body)), name: `backup-consegne-${stamp}.json.gz`, counts };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export function readBackup(buf: Buffer): BackupFile {
  const raw = buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf;
  const data = JSON.parse(raw.toString('utf8')) as BackupFile;
  if (data?.format !== 'consegne-backup' || typeof data.tables !== 'object') throw new Error('Il file non è un backup valido');
  return data;
}

/**
 * Ripristino su un database (le tabelle devono esistere: avvia prima il sito una volta
 * così crea la struttura). Svuota le tabelle presenti nel backup e le riempie.
 */
export async function restoreBackup(c: pg.PoolClient, data: BackupFile): Promise<Record<string, number>> {
  const order = (await tablesInOrder(c)).filter((t) => t in data.tables);
  const counts: Record<string, number> = {};
  await c.query('BEGIN');
  try {
    if (order.length) await c.query(`TRUNCATE ${order.map((t) => `"${t}"`).join(', ')} CASCADE`);
    for (const t of order) {
      const rows = data.tables[t] as unknown[];
      for (let i = 0; i < rows.length; i += 500) {
        await c.query(`INSERT INTO "${t}" SELECT * FROM json_populate_recordset(null::"${t}", $1::json)`,
          [JSON.stringify(rows.slice(i, i + 500))]);
      }
      counts[t] = rows.length;
    }
    // i contatori automatici (id progressivi) ripartono dopo l'ultimo valore ripristinato
    const { rows: seqs } = await c.query<{ t: string; col: string; seq: string }>(
      `SELECT c.table_name AS t, c.column_name AS col, pg_get_serial_sequence(format('%I', c.table_name), c.column_name) AS seq
         FROM information_schema.columns c
        WHERE c.table_schema = 'public' AND c.column_default LIKE 'nextval(%'`);
    for (const s of seqs) {
      if (!s.seq || !(s.t in data.tables)) continue;
      await c.query(`SELECT setval($1, coalesce((SELECT max("${s.col}") FROM "${s.t}"), 0) + 1, false)`, [s.seq]);
    }
    await c.query('COMMIT');
    return counts;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  }
}
