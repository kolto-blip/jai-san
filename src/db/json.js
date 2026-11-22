import fs from 'node:fs/promises';
import path from 'node:path';

// Хранилище без интернета: один JSON-файл в папке data/.
export async function createJsonRepo(dataDir) {
  await fs.mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, 'db.json');
  let state = { seq: { classes: 0, materials: 0, results: 0, students: 0, submissions: 0, subfiles: 0 }, classes: [], materials: [], results: [], students: [], submissions: [], subfiles: [], settings: {} };
  try {
    const loaded = JSON.parse(await fs.readFile(file, 'utf8'));
    state = { ...state, ...loaded, seq: { ...state.seq, ...loaded.seq } };
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  let writing = Promise.resolve();
  const save = () => {
    const snapshot = JSON.stringify(state, null, 1);
    writing = writing.then(async () => {
      const tmp = file + '.tmp';
      await fs.writeFile(tmp, snapshot);
      await fs.rename(tmp, file);
    });
    return writing;
  };
  const clone = (x) => (x ? structuredClone(x) : null);
  const byDate = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id);

  return {
    kind: 'json',

    async getSetting(key) {
      return state.settings[key] ?? null;
    },
    async setSetting(key, value) {
      state.settings[key] = value;
      await save();
    },

    async listClasses() {
      return clone([...state.classes].sort((a, b) => a.name.localeCompare(b.name, 'kk', { numeric: true }) || a.id - b.id));
    },
    async getClass(id) {
      return clone(state.classes.find((c) => c.id === id));
    },
    async getClassByCode(code) {
      return clone(state.classes.find((c) => c.code === code));
    },
    async createClass({ name, code }) {
      if (state.classes.some((c) => c.code === code)) throw Object.assign(new Error('dup'), { code: '23505' });
      const c = { id: ++state.seq.classes, name, code, createdAt: new Date().toISOString() };
      state.classes.push(c);
      await save();
      return clone(c);
    },
    async updateClass(id, { name, code }) {
      const c = state.classes.find((x) => x.id === id);
      if (!c) return null;
      if (code && state.classes.some((x) => x.code === code && x.id !== id)) {
        throw Object.assign(new Error('dup'), { code: '23505' });
      }
      if (name) c.name = name;
      if (code) c.code = code;
      await save();
      return clone(c);
    },
    async deleteClass(id) {
      state.classes = state.classes.filter((c) => c.id !== id);
      const gone = new Set(state.students.filter((x) => x.classId === id).map((x) => x.id));
      state.students = state.students.filter((x) => x.classId !== id);
      for (const r of state.results) if (gone.has(r.studentId)) r.studentId = null;
      for (const m of state.materials) m.classIds = m.classIds.filter((x) => x !== id);
      await save();
    },

    async listMaterials() {
      return clone([...state.materials].sort(byDate));
    },
    async listMaterialsForClass(classId) {
      return clone(state.materials.filter((m) => m.allClasses || m.classIds.includes(classId)).sort(byDate));
    },
    async getMaterial(id) {
      return clone(state.materials.find((m) => m.id === id));
    },
    async createMaterial(m) {
      const rec = {
        id: ++state.seq.materials,
        title: m.title, topic: m.topic || '', kind: m.kind, url: m.url ?? null,
        fileName: m.fileName ?? null, fileMime: m.fileMime ?? null, fileSize: m.fileSize || 0,
        storage: m.storage ?? null, storageKey: m.storageKey ?? null,
        allClasses: Boolean(m.allClasses), classIds: m.classIds || [],
        date: m.date, quiz: m.quiz ?? null, hw: m.hw ?? null, createdAt: new Date().toISOString(),
      };
      state.materials.push(rec);
      await save();
      return clone(rec);
    },
    async updateMaterial(id, patch) {
      const m = state.materials.find((x) => x.id === id);
      if (!m) return null;
      for (const [k, v] of Object.entries(patch)) if (v !== undefined && k !== 'id') m[k] = v;
      await save();
      return clone(m);
    },
    async deleteMaterial(id) {
      state.materials = state.materials.filter((m) => m.id !== id);
      state.results = state.results.filter((r) => r.materialId !== id);
      const subs = new Set(state.submissions.filter((x) => x.materialId === id).map((x) => x.id));
      state.submissions = state.submissions.filter((x) => !subs.has(x.id));
      state.subfiles = state.subfiles.filter((f) => !subs.has(f.submissionId));
      await save();
    },
    async listResults(materialId) {
      return clone(state.results.filter((r) => r.materialId === materialId));
    },
    async countResults() {
      const out = {};
      for (const r of state.results) out[r.materialId] = (out[r.materialId] || 0) + 1;
      return out;
    },
    async hasResult(materialId, classId, nameKey) {
      return state.results.some((r) => r.materialId === materialId && r.classId === classId && r.nameKey === nameKey);
    },
    async createResult(r) {
      const rec = { id: ++state.seq.results, ...r, studentId: r.studentId ?? null, createdAt: new Date().toISOString() };
      state.results.push(rec);
      await save();
      return clone(rec);
    },
    async deleteResult(id) {
      state.results = state.results.filter((r) => r.id !== id);
      await save();
    },
    async deleteResults(materialId) {
      state.results = state.results.filter((r) => r.materialId !== materialId);
      await save();
    },
    async hasResultByStudent(materialId, studentId) {
      return state.results.some((r) => r.materialId === materialId && r.studentId === studentId);
    },
    async listResultsForStudent(studentId) {
      return clone(state.results.filter((r) => r.studentId === studentId));
    },

    // ---------- ученики ----------
    async listStudents(classId) {
      return clone(state.students.filter((x) => x.classId === classId)
        .sort((a, b) => a.name.localeCompare(b.name, 'kk', { numeric: true }) || a.id - b.id))
        .map((x) => ({ ...x, registered: Boolean(x.pinHash) }));
    },
    async countStudents() {
      const out = {};
      for (const x of state.students) {
        const c = (out[x.classId] ||= { total: 0, registered: 0 });
        c.total++;
        if (x.pinHash) c.registered++;
      }
      return out;
    },
    async getStudent(id) {
      const x = state.students.find((s) => s.id === id);
      return x ? { ...clone(x), registered: Boolean(x.pinHash) } : null;
    },
    async addStudents(classId, names) {
      for (const name of names) {
        state.students.push({ id: ++state.seq.students, classId, name, pinHash: null, pinVer: 0, registeredAt: null, createdAt: new Date().toISOString() });
      }
      await save();
    },
    async renameStudent(id, name) {
      const x = state.students.find((s) => s.id === id);
      if (x) x.name = name;
      await save();
    },
    async claimStudent(id, pinHash) {
      const x = state.students.find((s) => s.id === id);
      if (!x || x.pinHash) return null;
      x.pinHash = pinHash;
      x.registeredAt = new Date().toISOString();
      await save();
      return { ...clone(x), registered: true };
    },
    async resetStudent(id) {
      const x = state.students.find((s) => s.id === id);
      if (x) Object.assign(x, { pinHash: null, registeredAt: null, pinVer: x.pinVer + 1 });
      await save();
    },
    async deleteStudent(id) {
      state.students = state.students.filter((s) => s.id !== id);
      for (const r of state.results) if (r.studentId === id) r.studentId = null;
      for (const r of state.submissions) if (r.studentId === id) r.studentId = null;
      await save();
    },

    // ---------- фото домашних работ ----------
    async createSubmission(sub, files) {
      const rec = {
        id: ++state.seq.submissions, materialId: sub.materialId, classId: sub.classId, studentId: sub.studentId ?? null,
        name: sub.name, comment: sub.comment || '', status: 'new', grade: '', feedback: '',
        createdAt: new Date().toISOString(), checkedAt: null,
      };
      state.submissions.push(rec);
      const fl = files.map((f) => ({ id: ++state.seq.subfiles, submissionId: rec.id, storage: f.storage, storageKey: f.storageKey, size: f.size, mime: f.mime }));
      state.subfiles.push(...fl);
      await save();
      return { ...clone(rec), files: clone(fl) };
    },
    withFiles(list) {
      return clone(list).map((x) => ({ ...x, files: clone(state.subfiles.filter((f) => f.submissionId === x.id)) }));
    },
    async listSubmissionsForMaterial(materialId) {
      return this.withFiles(state.submissions.filter((x) => x.materialId === materialId));
    },
    async listSubmissionsForStudent(studentId) {
      return this.withFiles(state.submissions.filter((x) => x.studentId === studentId));
    },
    async getSubmission(id) {
      return this.withFiles(state.submissions.filter((x) => x.id === id))[0] || null;
    },
    async getSubmissionFile(id) {
      const f = state.subfiles.find((x) => x.id === id);
      const sub = f && state.submissions.find((x) => x.id === f.submissionId);
      return f && sub ? { ...clone(f), studentId: sub.studentId, materialId: sub.materialId } : null;
    },
    async updateSubmission(id, { status, grade, feedback }) {
      const x = state.submissions.find((s) => s.id === id);
      if (x) Object.assign(x, { status, grade, feedback, checkedAt: status === 'checked' ? new Date().toISOString() : null });
      await save();
    },
    async deleteSubmission(id) {
      const files = state.subfiles.filter((f) => f.submissionId === id);
      state.subfiles = state.subfiles.filter((f) => f.submissionId !== id);
      state.submissions = state.submissions.filter((x) => x.id !== id);
      await save();
      return clone(files);
    },
    async deleteSubmissionsForMaterial(materialId) {
      const subs = new Set(state.submissions.filter((x) => x.materialId === materialId).map((x) => x.id));
      const files = state.subfiles.filter((f) => subs.has(f.submissionId));
      state.subfiles = state.subfiles.filter((f) => !subs.has(f.submissionId));
      state.submissions = state.submissions.filter((x) => !subs.has(x.id));
      await save();
      return clone(files);
    },
    async countSubmissions() {
      const out = {};
      for (const x of state.submissions) {
        const c = (out[x.materialId] ||= { total: 0, unchecked: 0 });
        c.total++;
        if (x.status !== 'checked') c.unchecked++;
      }
      return out;
    },
    async listAllSubmissionFiles() {
      return clone(state.subfiles);
    },
    async setSubmissionFileStorage(id, storage) {
      const f = state.subfiles.find((x) => x.id === id);
      if (f) f.storage = storage;
      await save();
    },
    async usageBytes() {
      return state.materials.reduce((s, m) => s + (m.storage ? m.fileSize : 0), 0) + state.subfiles.reduce((s, f) => s + f.size, 0);
    },
    async photoBytes() {
      return state.subfiles.reduce((s, f) => s + f.size, 0);
    },
    async close() {
      await writing;
    },
  };
}
