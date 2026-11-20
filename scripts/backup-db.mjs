#!/usr/bin/env node
/**
 * Sao lưu TOÀN BỘ dữ liệu production ATL2026 xuống máy — CHỈ ĐỌC.
 *
 *   node scripts/backup-db.mjs [thư-mục-đích]
 *
 * DATABASE_URL lấy từ biến môi trường, nếu không có thì đọc .env.local của repo.
 * Script không in mật khẩu ra màn hình và không ghi gì vào database: toàn bộ chạy
 * trong MỘT transaction `repeatable read read only`, nên mọi bảng là cùng một
 * khoảnh khắc.
 *
 * Mặc định ghi ra ../ATL2026-backups/<ngày_giờ>/ — NGOÀI repo, vì file chứa họ
 * tên, email, số điện thoại của sinh viên. Đừng commit, đừng để thư mục dùng chung.
 *
 * Kết quả:
 *   data/<bảng>.ndjson   bản gốc không mất mát (mỗi dòng = to_jsonb(row)::text)
 *   data/<bảng>.csv      bản mở bằng Excel (UTF-8 có BOM)
 *   schema/*             hàm, view, trigger, index, ràng buộc, enum, sequence
 *   manifest.json        số dòng + sha256 từng file, commit git, phiên bản Postgres
 */
import postgres from 'postgres';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROD_REF = 'qllxeocjtbgtsrzpolqr';

function loadUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL.trim();
  for (const f of ['.env.local', 'apps/web/.env.local', 'apps/pg/.env.local']) {
    const p = join(ROOT, f);
    if (!existsSync(p)) continue;
    const m = readFileSync(p, 'utf8').match(/^\s*DATABASE_URL\s*=\s*["']?([^"'\r\n]+)["']?/m);
    if (m) return m[1].trim();
  }
  return null;
}

const url = loadUrl();
if (!url) {
  console.error('DỪNG: không thấy DATABASE_URL (biến môi trường hoặc .env.local).');
  process.exit(1);
}
const parsed = new URL(url);
const target = `${decodeURIComponent(parsed.username)}@${parsed.hostname}:${parsed.port || 5432}`;
if (!url.includes(PROD_REF) && !process.argv.includes('--any')) {
  console.error(`DỪNG: DATABASE_URL trỏ tới ${target}, không phải project production ${PROD_REF}.`);
  console.error('Nếu đúng là muốn sao lưu database này, chạy lại với --any.');
  process.exit(1);
}

const stamp = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date()).replace(' ', '_').replace(':', '');
const outArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const OUT = resolve(outArg ?? join(ROOT, '..', 'ATL2026-backups', stamp));
mkdirSync(join(OUT, 'data'), { recursive: true });
mkdirSync(join(OUT, 'schema'), { recursive: true });

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const files = [];
function save(rel, content) {
  const buf = Buffer.from(content, 'utf8');
  writeFileSync(join(OUT, rel), buf);
  files.push({ file: rel, bytes: buf.length, sha256: sha(buf) });
}
const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

console.log(`Sao lưu ${target} → ${OUT}`);
const sql = postgres(url, { max: 1, prepare: false, ssl: 'require', connect_timeout: 15, idle_timeout: 5 });

const tables = [];
try {
  await sql.begin('isolation level repeatable read read only', async (tx) => {
    const [{ version }] = await tx`select version()`;
    const list = await tx`
      select c.relname as name,
             (select array_agg(a.attname::text order by k.ord)
                from pg_index i
                cross join lateral unnest(i.indkey::int2[]) with ordinality as k(attnum, ord)
                join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
               where i.indrelid = c.oid and i.indisprimary) as pk
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
       order by c.relname`;

    for (const { name, pk } of list) {
      const order = pk?.length ? `order by ${pk.map((c) => `t."${c}"`).join(', ')}` : '';
      const rows = await tx.unsafe(`select to_jsonb(t)::text as r from public."${name}" t ${order}`);
      const [{ n }] = await tx.unsafe(`select count(*)::int as n from public."${name}"`);
      if (rows.length !== n) throw new Error(`${name}: đọc ${rows.length} dòng nhưng count(*) = ${n}`);

      save(`data/${name}.ndjson`, rows.map((x) => x.r).join('\n') + (rows.length ? '\n' : ''));
      const cols = (await tx`
        select column_name from information_schema.columns
         where table_schema = 'public' and table_name = ${name} order by ordinal_position`).map((c) => c.column_name);
      const lines = [cols.map(csvCell).join(',')];
      for (const { r } of rows) {
        const o = JSON.parse(r);
        lines.push(cols.map((c) => csvCell(o[c])).join(','));
      }
      save(`data/${name}.csv`, '﻿' + lines.join('\r\n') + '\r\n');
      tables.push({ table: name, rows: n, primary_key: pk ?? [] });
      console.log(`  ${name.padEnd(28)} ${String(n).padStart(6)} dòng`);
    }

    const q = (text) => tx.unsafe(text);
    const fn = await q(`select p.proname, pg_get_functiondef(p.oid) as def
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prokind in ('f', 'p')
         and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
       order by 1, 2`);
    save('schema/functions.sql', fn.map((f) => `-- ${f.proname}\n${f.def};\n`).join('\n'));
    const views = await q(`select viewname, definition from pg_views where schemaname = 'public' order by 1`);
    save('schema/views.sql', views.map((v) => `create or replace view public."${v.viewname}" as\n${v.definition}\n`).join('\n'));
    const trg = await q(`select pg_get_triggerdef(t.oid) as def from pg_trigger t
        join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and not t.tgisinternal order by 1`);
    save('schema/triggers.sql', trg.map((t) => `${t.def};`).join('\n') + '\n');
    const idx = await q(`select indexdef from pg_indexes where schemaname = 'public' order by tablename, indexname`);
    save('schema/indexes.sql', idx.map((i) => `${i.indexdef};`).join('\n') + '\n');
    const con = await q(`select c.conrelid::regclass::text as tbl, c.conname, pg_get_constraintdef(c.oid) as def
        from pg_constraint c join pg_namespace n on n.oid = c.connamespace
       where n.nspname = 'public' and c.contype in ('p', 'u', 'f', 'c') and c.conrelid <> 0 order by 1, 2`);
    save('schema/constraints.sql', con.map((c) => `alter table ${c.tbl} add constraint "${c.conname}" ${c.def};`).join('\n') + '\n');
    const enums = await q(`select t.typname, e.enumlabel, e.enumsortorder from pg_type t
        join pg_enum e on e.enumtypid = t.oid join pg_namespace n on n.oid = t.typnamespace
       where n.nspname = 'public' order by 1, 3`);
    save('schema/enums.csv', 'type,label,order\n' + enums.map((e) => [e.typname, e.enumlabel, e.enumsortorder].map(csvCell).join(',')).join('\n') + '\n');
    const seq = await q(`select sequencename, last_value from pg_sequences where schemaname = 'public' order by 1`);
    save('schema/sequences.csv', 'sequence,last_value\n' + seq.map((s) => `${s.sequencename},${s.last_value ?? ''}`).join('\n') + '\n');
    const colsAll = await q(`select table_name, ordinal_position, column_name, data_type, udt_name, is_nullable, column_default
        from information_schema.columns where table_schema = 'public' order by 1, 2`);
    save('schema/columns.csv', 'table,position,column,data_type,udt_name,nullable,default\n'
      + colsAll.map((c) => [c.table_name, c.ordinal_position, c.column_name, c.data_type, c.udt_name, c.is_nullable, c.column_default].map(csvCell).join(',')).join('\n') + '\n');
    const ext = await q(`select extname, extversion from pg_extension order by 1`);
    save('schema/extensions.csv', 'extension,version\n' + ext.map((e) => `${e.extname},${e.extversion}`).join('\n') + '\n');

    let commit = null;
    try { commit = execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim(); } catch {}
    const manifest = {
      created_at: new Date().toISOString(),
      created_at_vn: stamp,
      source: { target, project_ref: PROD_REF, postgres: version },
      repo_commit: commit,
      snapshot: 'một transaction repeatable read read only — mọi bảng cùng một thời điểm',
      total_rows: tables.reduce((s, t) => s + t.rows, 0),
      tables,
      files,
    };
    writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  });

  writeFileSync(join(OUT, 'README.txt'), [
    'ATL2026 — bản sao lưu database production (chỉ đọc)',
    '',
    'CHỨA DỮ LIỆU CÁ NHÂN của sinh viên (họ tên, email, SĐT). Giữ ở nơi riêng tư, không gửi qua kênh chung.',
    '',
    'data/*.ndjson : bản gốc không mất mát — mỗi dòng là to_jsonb(row). Dùng file này để khôi phục.',
    'data/*.csv    : cùng dữ liệu, để mở bằng Excel.',
    'schema/       : hàm, view, trigger, index, ràng buộc, enum, sequence tại thời điểm sao lưu.',
    'manifest.json : số dòng và sha256 từng file, commit git của code lúc sao lưu.',
    '',
    'Khôi phục vào một database trống: chạy lần lượt mọi file supabase/migrations/ ở đúng commit ghi trong',
    'manifest, rồi nạp từng bảng bằng jsonb_populate_record(null::public.<bảng>, <dòng ndjson>), cuối cùng',
    'đặt lại sequence theo schema/sequences.csv.',
    '',
  ].join('\r\n'));

  const total = tables.reduce((s, t) => s + t.rows, 0);
  console.log(`\nXONG: ${tables.length} bảng · ${total} dòng · ${files.length} file → ${OUT}`);
} catch (err) {
  console.error('\nLỖI — bản sao lưu KHÔNG hoàn chỉnh:', err.message);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
