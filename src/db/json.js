import fs from 'node:fs/promises';
import path from 'node:path';

// Хранилище без интернета: один JSON-файл в папке data/.
export async function createJsonRepo(dataDir) {
  await fs.mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, 'db.json');
  let state = { seq: { classes: 0, materials: 0, results: 0, students: 0 }, classes: [], materials: [], results: [], students: [], settings: {} };
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
        date: m.date, quiz: m.quiz ?? null, createdAt: new Date().toISOString(),
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
      await save();
    },
    async usageBytes() {
      return state.materials.reduce((s, m) => s + (m.storage ? m.fileSize : 0), 0);
    },
    async close() {
      await writing;
    },
  };
}
