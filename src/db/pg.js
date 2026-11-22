import pg from 'pg';

// Даты (тип date) отдаём строкой YYYY-MM-DD, без сдвига часового пояса.
pg.types.setTypeParser(1082, (v) => v);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS classes (
  id serial PRIMARY KEY,
  name text NOT NULL,
  code text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS materials (
  id serial PRIMARY KEY,
  title text NOT NULL,
  topic text NOT NULL DEFAULT '',
  kind text NOT NULL,
  url text,
  file_name text,
  file_mime text,
  file_size integer NOT NULL DEFAULT 0,
  storage text,
  storage_key text,
  all_classes boolean NOT NULL DEFAULT false,
  class_ids integer[] NOT NULL DEFAULT '{}',
  mdate date NOT NULL DEFAULT current_date,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS files (
  key text PRIMARY KEY,
  data bytea NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key text PRIMARY KEY,
  value text NOT NULL
);
`;

const toClass = (r) => r && { id: r.id, name: r.name, code: r.code, createdAt: r.created_at };
const toMaterial = (r) =>
  r && {
    id: r.id,
    title: r.title,
    topic: r.topic,
    kind: r.kind,
    url: r.url,
    fileName: r.file_name,
    fileMime: r.file_mime,
    fileSize: r.file_size,
    storage: r.storage,
    storageKey: r.storage_key,
    allClasses: r.all_classes,
    classIds: r.class_ids,
    date: r.mdate,
    createdAt: r.created_at,
  };

const COLS = {
  title: 'title', topic: 'topic', kind: 'kind', url: 'url', fileName: 'file_name', fileMime: 'file_mime',
  fileSize: 'file_size', storage: 'storage', storageKey: 'storage_key', allClasses: 'all_classes',
  classIds: 'class_ids', date: 'mdate',
};

export async function createPgRepo(connectionString) {
  // Neon даёт sslmode=require; pg и так проверяет сертификат полностью — пишем это явно, без предупреждения в логах.
  connectionString = connectionString.replace(/([?&]sslmode=)(require|prefer|verify-ca)\b/, '$1verify-full');
  const pool = new pg.Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 30_000,
    ssl: /localhost|127\.0\.0\.1/.test(connectionString) ? undefined : { rejectUnauthorized: true },
  });
  pool.on('error', (e) => console.error('Postgres:', e.message));
  await pool.query(SCHEMA);
  const q = (text, params) => pool.query(text, params);

  return {
    kind: 'postgres',
    pool,

    async getSetting(key) {
      const { rows } = await q('SELECT value FROM settings WHERE key=$1', [key]);
      return rows[0]?.value ?? null;
    },
    async setSetting(key, value) {
      await q('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', [key, value]);
    },

    async listClasses() {
      const { rows } = await q('SELECT * FROM classes ORDER BY name, id');
      return rows.map(toClass);
    },
    async getClass(id) {
      const { rows } = await q('SELECT * FROM classes WHERE id=$1', [id]);
      return toClass(rows[0]) || null;
    },
    async getClassByCode(code) {
      const { rows } = await q('SELECT * FROM classes WHERE code=$1', [code]);
      return toClass(rows[0]) || null;
    },
    async createClass({ name, code }) {
      const { rows } = await q('INSERT INTO classes(name,code) VALUES($1,$2) RETURNING *', [name, code]);
      return toClass(rows[0]);
    },
    async updateClass(id, { name, code }) {
      const { rows } = await q(
        'UPDATE classes SET name=COALESCE($2,name), code=COALESCE($3,code) WHERE id=$1 RETURNING *',
        [id, name ?? null, code ?? null],
      );
      return toClass(rows[0]) || null;
    },
    async deleteClass(id) {
      await q('UPDATE materials SET class_ids=array_remove(class_ids,$1) WHERE $1=ANY(class_ids)', [id]);
      await q('DELETE FROM classes WHERE id=$1', [id]);
    },

    async listMaterials() {
      const { rows } = await q('SELECT * FROM materials ORDER BY mdate DESC, id DESC');
      return rows.map(toMaterial);
    },
    async listMaterialsForClass(classId) {
      const { rows } = await q(
        'SELECT * FROM materials WHERE all_classes OR $1=ANY(class_ids) ORDER BY mdate DESC, id DESC',
        [classId],
      );
      return rows.map(toMaterial);
    },
    async getMaterial(id) {
      const { rows } = await q('SELECT * FROM materials WHERE id=$1', [id]);
      return toMaterial(rows[0]) || null;
    },
    async createMaterial(m) {
      const keys = Object.keys(COLS).filter((k) => m[k] !== undefined);
      const { rows } = await q(
        `INSERT INTO materials(${keys.map((k) => COLS[k]).join(',')}) VALUES(${keys.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`,
        keys.map((k) => m[k]),
      );
      return toMaterial(rows[0]);
    },
    async updateMaterial(id, patch) {
      const keys = Object.keys(COLS).filter((k) => patch[k] !== undefined);
      if (!keys.length) return this.getMaterial(id);
      const { rows } = await q(
        `UPDATE materials SET ${keys.map((k, i) => `${COLS[k]}=$${i + 2}`).join(',')} WHERE id=$1 RETURNING *`,
        [id, ...keys.map((k) => patch[k])],
      );
      return toMaterial(rows[0]) || null;
    },
    async deleteMaterial(id) {
      await q('DELETE FROM materials WHERE id=$1', [id]);
    },
    async usageBytes() {
      const { rows } = await q('SELECT COALESCE(SUM(file_size),0)::bigint AS s FROM materials WHERE storage IS NOT NULL');
      return Number(rows[0].s);
    },
    async close() {
      await pool.end();
    },
  };
}
