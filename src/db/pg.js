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
ALTER TABLE materials ADD COLUMN IF NOT EXISTS quiz jsonb;
CREATE TABLE IF NOT EXISTS results (
  id serial PRIMARY KEY,
  material_id integer NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  class_id integer NOT NULL,
  name text NOT NULL,
  name_key text NOT NULL,
  answers jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS results_material ON results(material_id);
CREATE TABLE IF NOT EXISTS students (
  id serial PRIMARY KEY,
  class_id integer NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  name text NOT NULL,
  pin_hash text,
  pin_ver integer NOT NULL DEFAULT 0,
  registered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS students_class ON students(class_id);
ALTER TABLE results ADD COLUMN IF NOT EXISTS student_id integer REFERENCES students(id) ON DELETE SET NULL;
ALTER TABLE materials ADD COLUMN IF NOT EXISTS hw jsonb;
CREATE TABLE IF NOT EXISTS submissions (
  id serial PRIMARY KEY,
  material_id integer NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  class_id integer NOT NULL,
  student_id integer REFERENCES students(id) ON DELETE SET NULL,
  name text NOT NULL,
  comment text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'new',
  grade text NOT NULL DEFAULT '',
  feedback text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz
);
CREATE INDEX IF NOT EXISTS submissions_material ON submissions(material_id);
CREATE INDEX IF NOT EXISTS submissions_student ON submissions(student_id);
CREATE TABLE IF NOT EXISTS submission_files (
  id serial PRIMARY KEY,
  submission_id integer NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  storage text NOT NULL,
  storage_key text NOT NULL,
  size integer NOT NULL,
  mime text NOT NULL
);
CREATE INDEX IF NOT EXISTS submission_files_sub ON submission_files(submission_id);
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS ai jsonb;
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
    quiz: r.quiz || null,
    hw: r.hw || null,
    createdAt: r.created_at,
  };
const toStudent = (r) => r && {
  id: r.id, classId: r.class_id, name: r.name, pinHash: r.pin_hash, pinVer: r.pin_ver,
  registered: Boolean(r.pin_hash), registeredAt: r.registered_at,
};
const toSubmission = (r) => ({
  id: r.id, materialId: r.material_id, classId: r.class_id, studentId: r.student_id, name: r.name,
  comment: r.comment, status: r.status, grade: r.grade, feedback: r.feedback, createdAt: r.created_at, checkedAt: r.checked_at,
  ai: r.ai || null,
});
const toSubFile = (r) => ({ id: r.id, submissionId: r.submission_id, storage: r.storage, storageKey: r.storage_key, size: r.size, mime: r.mime });
const toResult = (r) => ({
  id: r.id, materialId: r.material_id, classId: r.class_id, name: r.name, nameKey: r.name_key,
  answers: r.answers, studentId: r.student_id ?? null, createdAt: r.created_at,
});

const COLS = {
  title: 'title', topic: 'topic', kind: 'kind', url: 'url', fileName: 'file_name', fileMime: 'file_mime',
  fileSize: 'file_size', storage: 'storage', storageKey: 'storage_key', allClasses: 'all_classes',
  classIds: 'class_ids', date: 'mdate', quiz: 'quiz', hw: 'hw',
};

// по казахскому алфавиту (Ә после А, а не после Я), независимо от настроек базы
const byName = (a, b) => a.name.localeCompare(b.name, 'kk', { numeric: true }) || a.id - b.id;
const val = (k, v) => ((k === 'quiz' || k === 'hw') && v ? JSON.stringify(v) : v);

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
      const { rows } = await q('SELECT * FROM classes');
      return rows.map(toClass).sort(byName);
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
        keys.map((k) => val(k, m[k])),
      );
      return toMaterial(rows[0]);
    },
    async updateMaterial(id, patch) {
      const keys = Object.keys(COLS).filter((k) => patch[k] !== undefined);
      if (!keys.length) return this.getMaterial(id);
      const { rows } = await q(
        `UPDATE materials SET ${keys.map((k, i) => `${COLS[k]}=$${i + 2}`).join(',')} WHERE id=$1 RETURNING *`,
        [id, ...keys.map((k) => val(k, patch[k]))],
      );
      return toMaterial(rows[0]) || null;
    },
    async deleteMaterial(id) {
      await q('DELETE FROM materials WHERE id=$1', [id]);
    },
    async listResults(materialId) {
      const { rows } = await q('SELECT * FROM results WHERE material_id=$1 ORDER BY created_at', [materialId]);
      return rows.map(toResult);
    },
    async countResults() {
      const { rows } = await q('SELECT material_id, COUNT(*)::int AS n FROM results GROUP BY material_id');
      return Object.fromEntries(rows.map((r) => [r.material_id, r.n]));
    },
    async hasResult(materialId, classId, nameKey) {
      const { rows } = await q('SELECT 1 FROM results WHERE material_id=$1 AND class_id=$2 AND name_key=$3 LIMIT 1', [materialId, classId, nameKey]);
      return rows.length > 0;
    },
    async createResult(r) {
      const { rows } = await q(
        'INSERT INTO results(material_id,class_id,name,name_key,answers,student_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
        [r.materialId, r.classId, r.name, r.nameKey, JSON.stringify(r.answers), r.studentId ?? null],
      );
      return toResult(rows[0]);
    },
    async deleteResult(id) {
      await q('DELETE FROM results WHERE id=$1', [id]);
    },
    async deleteResults(materialId) {
      await q('DELETE FROM results WHERE material_id=$1', [materialId]);
    },
    async hasResultByStudent(materialId, studentId) {
      const { rows } = await q('SELECT 1 FROM results WHERE material_id=$1 AND student_id=$2 LIMIT 1', [materialId, studentId]);
      return rows.length > 0;
    },
    async listResultsForStudent(studentId) {
      const { rows } = await q('SELECT * FROM results WHERE student_id=$1 ORDER BY created_at', [studentId]);
      return rows.map(toResult);
    },

    // ---------- ученики ----------
    async listStudents(classId) {
      const { rows } = await q('SELECT * FROM students WHERE class_id=$1', [classId]);
      return rows.map(toStudent).sort(byName);
    },
    async countStudents() {
      const { rows } = await q('SELECT class_id, COUNT(*)::int AS total, COUNT(pin_hash)::int AS registered FROM students GROUP BY class_id');
      return Object.fromEntries(rows.map((r) => [r.class_id, { total: r.total, registered: r.registered }]));
    },
    async getStudent(id) {
      const { rows } = await q('SELECT * FROM students WHERE id=$1', [id]);
      return toStudent(rows[0]) || null;
    },
    async addStudents(classId, names) {
      for (const name of names) await q('INSERT INTO students(class_id,name) VALUES($1,$2)', [classId, name]);
    },
    async renameStudent(id, name) {
      await q('UPDATE students SET name=$2 WHERE id=$1', [id, name]);
    },
    // первый вход: PIN ставится, только если его ещё нет (защита от гонки)
    async claimStudent(id, pinHash) {
      const { rows } = await q(
        'UPDATE students SET pin_hash=$2, registered_at=now() WHERE id=$1 AND pin_hash IS NULL RETURNING *',
        [id, pinHash],
      );
      return toStudent(rows[0]) || null;
    },
    async resetStudent(id) {
      await q('UPDATE students SET pin_hash=NULL, registered_at=NULL, pin_ver=pin_ver+1 WHERE id=$1', [id]);
    },
    async deleteStudent(id) {
      await q('DELETE FROM students WHERE id=$1', [id]);
    },
    // ---------- фото домашних работ ----------
    async createSubmission(sub, files) {
      const { rows } = await q(
        'INSERT INTO submissions(material_id,class_id,student_id,name,comment) VALUES($1,$2,$3,$4,$5) RETURNING *',
        [sub.materialId, sub.classId, sub.studentId ?? null, sub.name, sub.comment || ''],
      );
      const out = toSubmission(rows[0]);
      out.files = [];
      for (const f of files) {
        const r = await q(
          'INSERT INTO submission_files(submission_id,storage,storage_key,size,mime) VALUES($1,$2,$3,$4,$5) RETURNING *',
          [out.id, f.storage, f.storageKey, f.size, f.mime],
        );
        out.files.push(toSubFile(r.rows[0]));
      }
      return out;
    },
    async listSubmissions(where, params) {
      const { rows } = await q(`SELECT * FROM submissions WHERE ${where} ORDER BY created_at`, params);
      const subs = rows.map(toSubmission);
      if (!subs.length) return subs;
      const f = await q('SELECT * FROM submission_files WHERE submission_id = ANY($1) ORDER BY id', [subs.map((x) => x.id)]);
      const by = {};
      for (const r of f.rows) (by[r.submission_id] ||= []).push(toSubFile(r));
      for (const x of subs) x.files = by[x.id] || [];
      return subs;
    },
    async listSubmissionsForMaterial(materialId) {
      return this.listSubmissions('material_id=$1', [materialId]);
    },
    async listSubmissionsForStudent(studentId) {
      return this.listSubmissions('student_id=$1', [studentId]);
    },
    async getSubmission(id) {
      return (await this.listSubmissions('id=$1', [id]))[0] || null;
    },
    async getSubmissionFile(id) {
      const { rows } = await q(
        'SELECT f.*, s.student_id, s.material_id FROM submission_files f JOIN submissions s ON s.id=f.submission_id WHERE f.id=$1', [id],
      );
      return rows[0] ? { ...toSubFile(rows[0]), studentId: rows[0].student_id, materialId: rows[0].material_id } : null;
    },
    async updateSubmission(id, { status, grade, feedback }) {
      await q(
        `UPDATE submissions SET status=$2, grade=$3, feedback=$4, checked_at=CASE WHEN $2='checked' THEN now() ELSE NULL END WHERE id=$1`,
        [id, status, grade, feedback],
      );
    },
    async setSubmissionAi(id, ai) {
      await q('UPDATE submissions SET ai=$2 WHERE id=$1', [id, JSON.stringify(ai)]);
    },
    async deleteSubmission(id) {
      const { rows } = await q('DELETE FROM submission_files WHERE submission_id=$1 RETURNING *', [id]);
      await q('DELETE FROM submissions WHERE id=$1', [id]);
      return rows.map(toSubFile);
    },
    async deleteSubmissionsForMaterial(materialId) {
      const { rows } = await q(
        'DELETE FROM submission_files WHERE submission_id IN (SELECT id FROM submissions WHERE material_id=$1) RETURNING *', [materialId],
      );
      await q('DELETE FROM submissions WHERE material_id=$1', [materialId]);
      return rows.map(toSubFile);
    },
    async countSubmissions() {
      const { rows } = await q(
        "SELECT material_id, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status<>'checked')::int AS unchecked FROM submissions GROUP BY material_id",
      );
      return Object.fromEntries(rows.map((r) => [r.material_id, { total: r.total, unchecked: r.unchecked }]));
    },
    async listAllSubmissionFiles() {
      const { rows } = await q('SELECT * FROM submission_files ORDER BY id');
      return rows.map(toSubFile);
    },
    async setSubmissionFileStorage(id, storage) {
      await q('UPDATE submission_files SET storage=$2 WHERE id=$1', [id, storage]);
    },
    async usageBytes() {
      const { rows } = await q(`SELECT
        (SELECT COALESCE(SUM(file_size),0) FROM materials WHERE storage IS NOT NULL) +
        (SELECT COALESCE(SUM(size),0) FROM submission_files) AS s`);
      return Number(rows[0].s);
    },
    async photoBytes() {
      const { rows } = await q('SELECT COALESCE(SUM(size),0)::bigint AS s FROM submission_files');
      return Number(rows[0].s);
    },
    async close() {
      await pool.end();
    },
  };
}
