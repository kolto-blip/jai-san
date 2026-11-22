import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { config } from './config.js';
import { openRepo } from './db/index.js';
import { createStorages } from './storage/index.js';
import { createAuth, adminMode } from './auth.js';
import { FailureLimiter } from './ratelimit.js';
import { grade, nameKey } from './grade.js';
import {
  HttpError, readBody, readJson, sendJson, parseCookies, cookie, clientIp, generateCode, normalizeCode,
  validManualCode, FILE_TYPES, fileExt, cleanFileName, contentDisposition, safeHttpUrl, youtubeId, todayISO,
  validDate, baseUrl, escapeHtml,
} from './util.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const STUDENT_COOKIE_AGE = 365 * 86400;
const NEW_DAYS = 7;

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
};

const PAGE_CSP = [
  "default-src 'self'",
  "img-src 'self' data: https://i.ytimg.com",
  "frame-src https://www.youtube-nocookie.com",
  "style-src 'self'",
  "font-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

export async function createApp() {
  const repo = await openRepo();
  const storages = createStorages(repo);
  const auth = await createAuth(repo);
  const codeLimiter = new FailureLimiter(config.rateLimit.codeFailures, config.rateLimit.windowMs);
  const pinLimiter = new FailureLimiter(config.rateLimit.pinFailures, config.rateLimit.windowMs);
  // ответы учеников: не больше 120 отправок за 10 минут с одного IP (весь класс за одним школьным IP)
  // PIN ученика: 5 ошибок на одно имя и 30 ошибок с одного IP за 15 минут
  const studentPinLimiter = new FailureLimiter(5, config.rateLimit.windowMs);
  const studentIpLimiter = new FailureLimiter(30, config.rateLimit.windowMs);
  const submitLimiter = new FailureLimiter(Number(process.env.SUBMIT_MAX) || 120, 10 * 60 * 1000);

  // ---------- вспомогательное ----------
  async function studentClass(req) {
    const code = normalizeCode(parseCookies(req).cls);
    return code ? repo.getClassByCode(code) : null;
  }

  // Кто смотрит: класс (по коду), ученик (по личному входу), учитель.
  // Если у класса есть список учеников — без личного входа материалы закрыты.
  async function access(req) {
    const cls = await studentClass(req);
    if (!cls) return { cls: null, ok: false };
    const roster = Boolean((await repo.countStudents())[cls.id]?.total);
    let student = null;
    const t = auth.readStudentToken(parseCookies(req).stu);
    if (t) {
      const st = await repo.getStudent(t.id);
      if (st && st.classId === cls.id && st.pinVer === t.ver && st.registered) student = st;
    }
    const admin = auth.isAdmin(req);
    return { cls, roster, student, admin, ok: !roster || Boolean(student) || admin };
  }

  function cleanStudentName(raw) {
    return String(raw || '')
      .normalize('NFC')
      .replace(/\t/g, ' ')
      .replace(/^\s*№?\s*\d+\s*[.)]?\s+/, '') // «1. Әлия», «12) Нұрлан», «3<TAB>Айгерім»
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
  }

  function requireAdmin(req) {
    if (!auth.isAdmin(req)) {
      throw new HttpError(adminMode(req) === 'closed' ? 403 : 401, 'Мұғалім бетіне кіру қажет');
    }
    // защита от CSRF: изменения только из нашего JS (нестандартный заголовок)
    if (req.method !== 'GET' && req.headers['x-req'] !== '1') throw new HttpError(403, 'Қате сұраныс');
  }

  function tooMany(res, limiter, ip) {
    const s = limiter.retryAfter(ip);
    sendJson(res, 429, { error: `Тым көп қате әрекет. ${Math.ceil(s / 60)} минуттан кейін қайталаңыз.` }, { 'Retry-After': String(s) });
  }

  async function freeCode() {
    for (let i = 0; i < 50; i++) {
      const c = generateCode();
      if (!(await repo.getClassByCode(c))) return c;
    }
    throw new HttpError(500, 'Код жасау мүмкін болмады');
  }

  function isNew(dateStr) {
    const today = Date.parse(todayISO());
    const d = Date.parse(dateStr);
    return today - d <= NEW_DAYS * 86400_000 && d <= today + 86400_000;
  }

  function publicMaterial(m) {
    const out = { id: m.id, title: m.title, topic: m.topic, kind: m.kind, date: m.date, isNew: isNew(m.date) };
    if (m.storage) {
      const ext = fileExt(m.fileName);
      out.file = { name: m.fileName, ext, size: m.fileSize };
      out.href = `/f/${m.id}`;
      out.action = FILE_TYPES[ext]?.inline ? 'open' : 'download';
    } else if (m.kind === 'video') {
      out.youtubeId = youtubeId(m.url);
      out.url = m.url;
      out.action = 'play';
    } else {
      out.url = m.url;
      out.action = 'link';
    }
    if (m.quiz?.answers?.length) {
      // сами ответы ученикам не отдаём
      out.quiz = { count: m.quiz.answers.length, open: m.quiz.open, retry: m.quiz.retry };
    }
    return out;
  }

  function adminMaterial(m, resultCounts = {}) {
    return {
      ...publicMaterial(m), allClasses: m.allClasses, classIds: m.classIds, storage: m.storage,
      quizKey: m.quiz || null, results: resultCounts[m.id] || 0,
    };
  }

  function parseQuiz(q) {
    if (!q) return null;
    const answers = (Array.isArray(q.answers) ? q.answers : String(q.answers || '').split('\n'))
      .map((a) => String(a).trim().slice(0, 100));
    while (answers.length && !answers[answers.length - 1]) answers.pop();
    if (!answers.length) return null;
    if (answers.length > 50) throw new HttpError(400, 'Жауап кілтінде 50-ден көп жол болмауы керек');
    if (answers.some((a) => !a)) throw new HttpError(400, 'Жауап кілтінде бос жол бар');
    return { answers, open: q.open !== false, retry: Boolean(q.retry), show: Boolean(q.show) };
  }

  // Общие поля материала из формы учителя.
  async function materialFields(input, { isFile, existing }) {
    const title = String(input.title ?? existing?.title ?? '').trim().slice(0, 200);
    if (!title) throw new HttpError(400, 'Атауын жазыңыз');
    const topic = String(input.topic ?? existing?.topic ?? '').trim().slice(0, 80);
    const date = input.date === undefined ? existing?.date || todayISO() : input.date;
    if (!validDate(date)) throw new HttpError(400, 'Күні қате');
    const allClasses = Boolean(input.allClasses ?? existing?.allClasses);
    const known = new Set((await repo.listClasses()).map((c) => c.id));
    const classIds = [...new Set((input.classIds ?? existing?.classIds ?? []).map(Number))].filter((id) => known.has(id));
    if (!allClasses && !classIds.length) throw new HttpError(400, 'Кем дегенде бір сыныпты таңдаңыз');

    const fields = { title, topic, date, allClasses, classIds };
    if (input.quiz !== undefined) fields.quiz = parseQuiz(input.quiz);
    if (!isFile) {
      const type = input.type || (existing && (existing.kind === 'pres' ? 'slides' : existing.kind));
      const url = safeHttpUrl(input.url ?? existing?.url);
      if (!url) throw new HttpError(400, 'Сілтеме http:// немесе https:// деп басталуы керек');
      if (type === 'video') {
        if (!youtubeId(url)) throw new HttpError(400, 'Бұл YouTube сілтемесі емес');
        fields.kind = 'video';
      } else if (type === 'slides') fields.kind = 'pres';
      else if (type === 'link') fields.kind = 'link';
      else throw new HttpError(400, 'Материал түрі белгісіз');
      fields.url = url;
    }
    return fields;
  }

  async function storeFile(req) {
    const name = cleanFileName(decodeURIComponent(String(req.headers['x-file-name'] || '')));
    const ext = fileExt(name);
    const type = FILE_TYPES[ext];
    if (!type) throw new HttpError(400, 'Тек PDF, Word (doc, docx) және PowerPoint (ppt, pptx) файлдары');
    const buf = await readBody(req, config.maxFileBytes);
    if (!buf.length) throw new HttpError(400, 'Файл бос');
    const used = await repo.usageBytes();
    if (used + buf.length > storages.limitMb * 1024 * 1024) throw new HttpError(413, 'Қоймада орын жоқ');
    const key = crypto.randomBytes(16).toString('hex');
    await storages.active.put(key, buf);
    return {
      kind: type.kind, url: null, fileName: name, fileMime: type.mime, fileSize: buf.length,
      storage: storages.active.name, storageKey: key,
    };
  }

  async function removeFile(m) {
    if (!m?.storage) return;
    try {
      await storages.get(m.storage).del(m.storageKey);
    } catch (e) {
      console.error('Файлды жою қатесі:', e.message);
    }
  }

  function readMeta(req) {
    try {
      return JSON.parse(decodeURIComponent(String(req.headers['x-meta'] || '%7B%7D')));
    } catch {
      throw new HttpError(400, 'Қате сұраныс');
    }
  }

  async function classLink(req, cls) {
    return `${baseUrl(req)}/k/${cls.code}`;
  }

  // ---------- маршруты ----------
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

  route('GET', /^\/api\/health$/, async (req, res) => sendJson(res, 200, { ok: true }));

  // Ученик
  route('POST', /^\/api\/join$/, async (req, res) => {
    const ip = clientIp(req);
    if (codeLimiter.isBlocked(ip)) return tooMany(res, codeLimiter, ip);
    const { code } = await readJson(req);
    const norm = normalizeCode(code);
    const cls = norm.length >= 4 && norm.length <= 8 ? await repo.getClassByCode(norm) : null;
    if (!cls) {
      codeLimiter.fail(ip);
      return sendJson(res, 404, { error: 'Мұндай код жоқ. Мұғаліміңізден тексеріңіз.' });
    }
    sendJson(res, 200, { class: { name: cls.name }, code: cls.code }, {
      'Set-Cookie': cookie(req, 'cls', cls.code, { maxAge: STUDENT_COOKIE_AGE }),
    });
  });

  route('POST', /^\/api\/leave$/, async (req, res) => {
    res.setHeader('Set-Cookie', [cookie(req, 'cls', '', { maxAge: 0 }), cookie(req, 'stu', '', { maxAge: 0 })]);
    sendJson(res, 200, { ok: true });
  });

  route('GET', /^\/api\/materials$/, async (req, res) => {
    const a = await access(req);
    if (!a.cls) return sendJson(res, 401, { error: 'Сынып кодын енгізіңіз' });
    if (!a.ok) return sendJson(res, 401, { error: 'Атыңызды таңдап, PIN енгізіңіз', needLogin: true, class: { name: a.cls.name } });
    const list = (await repo.listMaterialsForClass(a.cls.id)).map(publicMaterial);
    if (a.student) {
      // последний результат ученика по каждому заданию (оценка по текущему ключу)
      const latest = {};
      for (const r of await repo.listResultsForStudent(a.student.id)) latest[r.materialId] = r;
      const byId = Object.fromEntries((await repo.listMaterialsForClass(a.cls.id)).map((m) => [m.id, m]));
      for (const m of list) {
        const r = latest[m.id];
        if (m.quiz && r) {
          const g = grade(r.answers, byId[m.id].quiz.answers);
          m.quiz.done = { score: g.score, total: g.total };
        }
      }
    }
    sendJson(res, 200, {
      class: { name: a.cls.name },
      roster: a.roster,
      student: a.student ? { name: a.student.name } : null,
      preview: a.roster && !a.student && a.admin,
      materials: list,
    });
  });

  // Список учеников класса для входа (без PIN и прочего)
  route('GET', /^\/api\/roster$/, async (req, res) => {
    const cls = await studentClass(req);
    if (!cls) return sendJson(res, 401, { error: 'Сынып кодын енгізіңіз' });
    const list = await repo.listStudents(cls.id);
    sendJson(res, 200, { class: { name: cls.name }, students: list.map((x) => ({ id: x.id, name: x.name, registered: x.registered })) });
  });

  // Вход ученика: при первом входе PIN создаётся, дальше — проверяется.
  route('POST', /^\/api\/student\/login$/, async (req, res) => {
    const ip = clientIp(req);
    if (studentIpLimiter.isBlocked(ip)) return tooMany(res, studentIpLimiter, ip);
    const cls = await studentClass(req);
    if (!cls) return sendJson(res, 401, { error: 'Сынып кодын енгізіңіз' });
    const body = await readJson(req);
    const st = await repo.getStudent(Number(body.id));
    if (!st || st.classId !== cls.id) throw new HttpError(404, 'Оқушы табылмады');
    const pin = String(body.pin ?? '');
    if (!/^\d{4}$/.test(pin)) throw new HttpError(400, 'PIN — 4 сан');
    let me = st;
    if (!st.registered) {
      me = await repo.claimStudent(st.id, auth.hashPin(pin));
      if (!me) throw new HttpError(409, 'Бұл есімге жаңа ғана PIN қойылды. Беттi жаңартып, PIN-іңізді енгізіңіз.');
    } else {
      const key = 's' + st.id;
      if (studentPinLimiter.isBlocked(key)) return tooMany(res, studentPinLimiter, key);
      if (!auth.checkStudentPin(pin, st.pinHash)) {
        studentPinLimiter.fail(key);
        studentIpLimiter.fail(ip);
        const left = 5 - studentPinLimiter.recent(key).length;
        return sendJson(res, 401, {
          error: left > 0 ? `PIN қате. Тағы ${left} әрекет қалды. Ұмытсаңыз — мұғалімге айтыңыз.` : 'PIN қате. Мұғалімге айтыңыз.',
        });
      }
    }
    sendJson(res, 200, { student: { name: me.name } }, {
      'Set-Cookie': cookie(req, 'stu', auth.studentToken(me), { maxAge: STUDENT_COOKIE_AGE }),
    });
  });

  route('POST', /^\/api\/student\/logout$/, async (req, res) => {
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, 'stu', '', { maxAge: 0 }) });
  });

  // Файл: проверка доступа при каждом скачивании.
  route('GET', /^\/f\/(\d+)$/, async (req, res, [id], url) => {
    const m = await repo.getMaterial(Number(id));
    let allowed = false;
    if (m && auth.isAdmin(req)) allowed = true;
    else if (m) {
      const a = await access(req);
      allowed = Boolean(a.ok && (m.allClasses || m.classIds.includes(a.cls.id)));
    }
    if (!m || !m.storage || !allowed) {
      res.writeHead(m ? 403 : 404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(errorPage(m ? 'Бұл материал сіздің сыныбыңызға арналмаған.' : 'Материал табылмады.'));
    }
    const buf = await storages.get(m.storage).get(m.storageKey);
    const inline = FILE_TYPES[fileExt(m.fileName)]?.inline && url.searchParams.get('dl') !== '1';
    res.writeHead(200, {
      'Content-Type': m.fileMime,
      'Content-Length': buf.length,
      'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', m.fileName),
      'Cache-Control': 'private, no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(buf);
  });

  // Ссылка из QR-кода
  route('GET', /^\/k\/([A-Za-z0-9]{4,8})$/, async (req, res, [code]) => {
    res.writeHead(302, { Location: `/?k=${encodeURIComponent(code.toUpperCase())}` });
    res.end();
  });

  // Учитель
  route('GET', /^\/api\/admin\/state$/, async (req, res) => {
    sendJson(res, 200, { mode: adminMode(req), authed: auth.isAdmin(req) });
  });

  route('POST', /^\/api\/admin\/login$/, async (req, res) => {
    if (adminMode(req) === 'closed') return sendJson(res, 403, { error: 'Мұғалім беті жабық: ADMIN_PIN орнатылмаған.' });
    const ip = clientIp(req);
    if (pinLimiter.isBlocked(ip)) return tooMany(res, pinLimiter, ip);
    const { pin } = await readJson(req);
    if (!auth.checkPin(pin)) {
      pinLimiter.fail(ip);
      return sendJson(res, 401, { error: 'PIN қате' });
    }
    const { token, maxAge } = auth.issueToken();
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, 'adm', token, { maxAge, sameSite: 'Strict' }) });
  });

  route('POST', /^\/api\/admin\/logout$/, async (req, res) => {
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, 'adm', '', { maxAge: 0, sameSite: 'Strict' }) });
  });

  route('GET', /^\/api\/admin\/overview$/, async (req, res) => {
    requireAdmin(req);
    const [classes, materials, used, resultCounts, studentCounts] = await Promise.all([
      repo.listClasses(), repo.listMaterials(), repo.usageBytes(), repo.countResults(), repo.countStudents(),
    ]);
    const counts = {};
    for (const m of materials) for (const id of m.classIds) counts[id] = (counts[id] || 0) + 1;
    sendJson(res, 200, {
      classes: classes.map((c) => ({ ...c, materials: counts[c.id] || 0, students: studentCounts[c.id] || { total: 0, registered: 0 } })),
      materials: materials.map((m) => adminMaterial(m, resultCounts)),
      usage: { usedBytes: used, limitMb: storages.limitMb, storage: storages.active.name, maxFileMb: config.maxFileBytes / 1048576 },
      baseUrl: baseUrl(req),
    });
  });

  route('POST', /^\/api\/admin\/classes$/, async (req, res) => {
    requireAdmin(req);
    const body = await readJson(req);
    const name = String(body.name || '').trim().slice(0, 30);
    if (!name) throw new HttpError(400, 'Сынып атауын жазыңыз');
    let code = normalizeCode(body.code);
    if (code && !validManualCode(code)) throw new HttpError(400, 'Код 5–6 латын әрпі немесе саннан тұрады');
    if (!code) code = await freeCode();
    sendJson(res, 201, await repo.createClass({ name, code }));
  });

  route('PUT', /^\/api\/admin\/classes\/(\d+)$/, async (req, res, [id]) => {
    requireAdmin(req);
    const body = await readJson(req);
    const patch = {};
    if (body.name !== undefined) {
      patch.name = String(body.name).trim().slice(0, 30);
      if (!patch.name) throw new HttpError(400, 'Сынып атауын жазыңыз');
    }
    if (body.regenerate) patch.code = await freeCode();
    else if (body.code !== undefined) {
      patch.code = normalizeCode(body.code);
      if (!validManualCode(patch.code)) throw new HttpError(400, 'Код 5–6 латын әрпі немесе саннан тұрады');
    }
    const c = await repo.updateClass(Number(id), patch);
    if (!c) throw new HttpError(404, 'Сынып табылмады');
    sendJson(res, 200, c);
  });

  route('DELETE', /^\/api\/admin\/classes\/(\d+)$/, async (req, res, [id]) => {
    requireAdmin(req);
    await repo.deleteClass(Number(id));
    sendJson(res, 200, { ok: true });
  });

  route('GET', /^\/api\/admin\/classes\/(\d+)\/qr\.svg$/, async (req, res, [id]) => {
    requireAdmin(req);
    const cls = await repo.getClass(Number(id));
    if (!cls) throw new HttpError(404, 'Сынып табылмады');
    const svg = await QRCode.toString(await classLink(req, cls), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
    res.end(svg);
  });

  route('GET', /^\/print\/(\d+)$/, async (req, res, [id]) => {
    if (!auth.isAdmin(req)) {
      res.writeHead(302, { Location: '/admin' });
      return res.end();
    }
    const cls = await repo.getClass(Number(id));
    if (!cls) throw new HttpError(404, 'Сынып табылмады');
    const link = await classLink(req, cls);
    const svg = await QRCode.toString(link, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PAGE_CSP, 'Cache-Control': 'no-store' });
    res.end(printPage(cls, link, svg));
  });

  route('POST', /^\/api\/admin\/materials$/, async (req, res) => {
    requireAdmin(req);
    const fields = await materialFields(await readJson(req), { isFile: false });
    sendJson(res, 201, adminMaterial(await repo.createMaterial(fields)));
  });

  route('POST', /^\/api\/admin\/materials\/upload$/, async (req, res) => {
    requireAdmin(req);
    const fields = await materialFields(readMeta(req), { isFile: true });
    const file = await storeFile(req);
    sendJson(res, 201, adminMaterial(await repo.createMaterial({ ...fields, ...file })));
  });

  route('PUT', /^\/api\/admin\/materials\/(\d+)$/, async (req, res, [id]) => {
    requireAdmin(req);
    const existing = await repo.getMaterial(Number(id));
    if (!existing) throw new HttpError(404, 'Материал табылмады');
    const fields = await materialFields(await readJson(req), { isFile: Boolean(existing.storage), existing });
    sendJson(res, 200, adminMaterial(await repo.updateMaterial(existing.id, fields)));
  });

  // Заменить файл у существующего материала (или превратить ссылку в файл)
  route('PUT', /^\/api\/admin\/materials\/(\d+)\/file$/, async (req, res, [id]) => {
    requireAdmin(req);
    const existing = await repo.getMaterial(Number(id));
    if (!existing) throw new HttpError(404, 'Материал табылмады');
    const fields = await materialFields(readMeta(req), { isFile: true, existing });
    const file = await storeFile(req);
    const updated = await repo.updateMaterial(existing.id, { ...fields, ...file });
    await removeFile(existing);
    sendJson(res, 200, adminMaterial(updated));
  });

  route('DELETE', /^\/api\/admin\/materials\/(\d+)$/, async (req, res, [id]) => {
    requireAdmin(req);
    const m = await repo.getMaterial(Number(id));
    if (m) {
      await repo.deleteMaterial(m.id);
      await removeFile(m);
    }
    sendJson(res, 200, { ok: true });
  });

  // ---------- Списки учеников (учитель) ----------
  const publicStudent = (x) => ({ id: x.id, name: x.name, registered: x.registered, registeredAt: x.registeredAt });

  route('GET', /^\/api\/admin\/classes\/(\d+)\/students$/, async (req, res, [id]) => {
    requireAdmin(req);
    sendJson(res, 200, (await repo.listStudents(Number(id))).map(publicStudent));
  });

  route('POST', /^\/api\/admin\/classes\/(\d+)\/students$/, async (req, res, [id]) => {
    requireAdmin(req);
    const cls = await repo.getClass(Number(id));
    if (!cls) throw new HttpError(404, 'Сынып табылмады');
    const body = await readJson(req);
    const lines = (Array.isArray(body.names) ? body.names : String(body.names || '').split(/\r?\n/)).map(cleanStudentName);
    const existing = await repo.listStudents(cls.id);
    const seen = new Set(existing.map((x) => nameKey(x.name)));
    const add = [];
    for (const n of lines) {
      if (n.length < 2 || /^\d+$/.test(n) || seen.has(nameKey(n))) continue;
      seen.add(nameKey(n));
      add.push(n);
    }
    if (existing.length + add.length > 60) throw new HttpError(400, 'Бір сыныпта 60-тан көп оқушы болмайды');
    await repo.addStudents(cls.id, add);
    sendJson(res, 200, { added: add.length, skipped: lines.filter(Boolean).length - add.length });
  });

  route('PUT', /^\/api\/admin\/students\/(\d+)$/, async (req, res, [id]) => {
    requireAdmin(req);
    const name = cleanStudentName((await readJson(req)).name);
    if (name.length < 2) throw new HttpError(400, 'Атын жазыңыз');
    await repo.renameStudent(Number(id), name);
    sendJson(res, 200, { ok: true });
  });

  route('POST', /^\/api\/admin\/students\/(\d+)\/reset$/, async (req, res, [id]) => {
    requireAdmin(req);
    await repo.resetStudent(Number(id));
    sendJson(res, 200, { ok: true });
  });

  route('DELETE', /^\/api\/admin\/students\/(\d+)$/, async (req, res, [id]) => {
    requireAdmin(req);
    await repo.deleteStudent(Number(id));
    sendJson(res, 200, { ok: true });
  });

  // ---------- Ответы с автопроверкой ----------
  route('POST', /^\/api\/quiz\/(\d+)$/, async (req, res, [id]) => {
    const ip = clientIp(req);
    if (submitLimiter.isBlocked(ip)) return tooMany(res, submitLimiter, ip);
    const a = await access(req);
    if (!a.cls) return sendJson(res, 401, { error: 'Сынып кодын енгізіңіз' });
    const cls = a.cls;
    if (a.roster && !a.student) {
      if (a.admin) throw new HttpError(403, 'Мұғалім ретінде қарап отырсыз — жауап жіберілмейді');
      return sendJson(res, 401, { error: 'Атыңызды таңдап, PIN енгізіңіз', needLogin: true });
    }
    const m = await repo.getMaterial(Number(id));
    if (!m || !(m.allClasses || m.classIds.includes(cls.id)) || !m.quiz) throw new HttpError(404, 'Тапсырма табылмады');
    if (!m.quiz.open) throw new HttpError(403, 'Жауап қабылдау жабылды');
    const body = await readJson(req);
    const name = a.student ? a.student.name : String(body.name || '').normalize('NFC').trim().replace(/\s+/g, ' ').slice(0, 60);
    if (name.length < 2) throw new HttpError(400, 'Аты-жөніңізді толық жазыңыз');
    const answers = m.quiz.answers.map((_, i) => String(body.answers?.[i] ?? '').trim().slice(0, 100));
    if (answers.every((x) => !x)) throw new HttpError(400, 'Кем дегенде бір жауап жазыңыз');
    const key = nameKey(name);
    const already = a.student ? await repo.hasResultByStudent(m.id, a.student.id) : await repo.hasResult(m.id, cls.id, key);
    if (!m.quiz.retry && already) {
      throw new HttpError(409, a.student
        ? 'Сіз бұл тапсырманы тапсырып қойдыңыз. Қайта тапсыруға мұғалім рұқсат бермеген.'
        : 'Бұл есіммен жауап тапсырылған. Қайта тапсыруға мұғалім рұқсат бермеген.');
    }
    submitLimiter.fail(ip); // считаем каждую отправку
    await repo.createResult({ materialId: m.id, classId: cls.id, name, nameKey: key, answers, studentId: a.student?.id ?? null });
    const g = grade(answers, m.quiz.answers);
    sendJson(res, 200, { ...g, correct: m.quiz.show ? m.quiz.answers : undefined });
  });

  async function resultsTable(materialId) {
    const m = await repo.getMaterial(materialId);
    if (!m) throw new HttpError(404, 'Материал табылмады');
    const key = m.quiz?.answers || [];
    const classes = await repo.listClasses();
    const names = Object.fromEntries(classes.map((c) => [c.id, c.name]));
    // списки учеников классов, которым адресовано задание
    const students = {};
    for (const c of classes) {
      if (!m.allClasses && !m.classIds.includes(c.id)) continue;
      for (const st of await repo.listStudents(c.id)) students[st.id] = st;
    }
    // ключ мог измениться — оцениваем заново при каждом просмотре
    const results = (await repo.listResults(m.id)).map((r) => ({
      id: r.id, name: students[r.studentId]?.name || r.name, className: names[r.classId] || '—', classId: r.classId,
      studentId: r.studentId, answers: r.answers, createdAt: r.createdAt, ...grade(r.answers, key),
    }));
    // номер попытки для одного и того же ученика
    const seen = {};
    for (const r of results) {
      const k = r.studentId ? 's' + r.studentId : r.classId + '|' + nameKey(r.name);
      r.attempt = seen[k] = (seen[k] || 0) + 1;
    }
    // кто из списка класса ещё не сдал
    const done = new Set(results.map((r) => r.studentId).filter(Boolean));
    const missing = Object.values(students)
      .filter((st) => !done.has(st.id))
      .map((st) => ({ name: st.name, classId: st.classId, className: names[st.classId] || '—', studentId: st.id, registered: st.registered }));
    return { material: { id: m.id, title: m.title }, key, results, missing };
  }

  route('GET', /^\/api\/admin\/materials\/(\d+)\/results$/, async (req, res, [id]) => {
    requireAdmin(req);
    sendJson(res, 200, await resultsTable(Number(id)));
  });

  route('GET', /^\/api\/admin\/materials\/(\d+)\/results\.csv$/, async (req, res, [id]) => {
    requireAdmin(req);
    const t = await resultsTable(Number(id));
    const cell = (v) => {
      let s = String(v ?? '');
      if (/^[=+\-@]/.test(s)) s = "'" + s; // защита от формул в Excel
      return '"' + s.replace(/"/g, '""') + '"';
    };
    const head = ['Сынып', 'Аты-жөні', 'Ұпай', 'Барлығы', 'Әрекет', 'Уақыт', ...t.key.map((_, i) => `№${i + 1}`)];
    const rows = t.results.map((r) => [
      r.className, r.name, r.score, r.total, r.attempt, new Date(r.createdAt).toLocaleString('ru-RU', { timeZone: config.timeZone }),
      ...r.answers.map((a, i) => `${r.marks[i] ? '✓' : '✗'} ${a}`),
    ]);
    for (const x of t.missing) rows.push([x.className, x.name, '', t.key.length, 0, 'тапсырмаған']);
    const csv = '\ufeff' + [head, ...rows].map((row) => row.map(cell).join(';')).join('\r\n');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': contentDisposition('attachment', `${t.material.title} — нәтижелер.csv`.replace(/[\\/:*?"<>|]/g, '_')),
      'Cache-Control': 'no-store',
    });
    res.end(csv);
  });

  route('DELETE', /^\/api\/admin\/results\/(\d+)$/, async (req, res, [id]) => {
    requireAdmin(req);
    await repo.deleteResult(Number(id));
    sendJson(res, 200, { ok: true });
  });

  route('DELETE', /^\/api\/admin\/materials\/(\d+)\/results$/, async (req, res, [id]) => {
    requireAdmin(req);
    await repo.deleteResults(Number(id));
    sendJson(res, 200, { ok: true });
  });

  // ---------- статика ----------
  async function serveStatic(req, res, pathname) {
    let file = pathname === '/' ? '/index.html' : pathname === '/admin' ? '/admin.html' : pathname;
    const full = path.normalize(path.join(PUBLIC_DIR, file));
    if (!full.startsWith(PUBLIC_DIR + path.sep)) return false;
    let data;
    try {
      data = await fs.readFile(full);
    } catch {
      return false;
    }
    const ext = path.extname(full);
    const headers = {
      'Content-Type': STATIC_TYPES[ext] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': ext === '.woff2' ? 'public, max-age=31536000, immutable' : 'no-cache',
    };
    if (ext === '.html') {
      headers['Content-Security-Policy'] = PAGE_CSP;
      headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'; // YouTube требует Referer (иначе ошибка 153)
    }
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : data);
    return true;
  }

  async function handler(req, res) {
    const url = new URL(req.url, 'http://x');
    try {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.pattern.exec(url.pathname);
        if (m) return await r.handler(req, res, m.slice(1), url);
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && (await serveStatic(req, res, url.pathname))) return;
      if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Табылмады' });
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(errorPage('Бет табылмады.'));
    } catch (e) {
      let status = e.status || 500;
      let msg = e.message;
      if (e.code === '23505') {
        status = 409;
        msg = 'Бұл код басқа сыныпта бар. Басқа код таңдаңыз.';
      }
      if (status >= 500) {
        console.error(e);
        msg = 'Сервер қатесі. Кейінірек қайталаңыз.';
      }
      if (res.headersSent) return res.destroy();
      sendJson(res, status, { error: msg });
    }
  }

  const server = http.createServer(handler);
  server.requestTimeout = 5 * 60_000;

  return {
    server,
    repo,
    storages,
    async close() {
      await new Promise((r) => {
        server.close(r);
        server.closeAllConnections();
      });
      await repo.close();
    },
  };
}

function errorPage(text) {
  return `<!doctype html><html lang="kk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Қате</title><link rel="stylesheet" href="/style.css"></head><body class="center-page">
<div class="card msg-card"><div class="big-emoji">🔒</div><p>${escapeHtml(text)}</p><a class="btn btn-green" href="/">Басты бетке</a></div></body></html>`;
}

function printPage(cls, link, svg) {
  const card = `<div class="pcard">
  <div class="pcard-top"><span class="pcard-sym">+ − × ÷</span><span class="pcard-cls">${escapeHtml(cls.name)}</span></div>
  <div class="pcard-body">
    <div class="pcard-qr">${svg}</div>
    <div class="pcard-info">
      <div class="pcard-label">Сынып коды</div>
      <div class="pcard-code">${escapeHtml(cls.code)}</div>
      <div class="pcard-hint">Телефон камерасымен QR-кодты сканерлеңіз немесе сайтқа кіріп, кодты енгізіңіз:</div>
      <div class="pcard-url">${escapeHtml(link.replace(/^https?:\/\//, '').replace(/\/k\/.*$/, ''))}</div>
    </div>
  </div></div>`;
  return `<!doctype html><html lang="kk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(cls.name)} — QR карточка</title><link rel="stylesheet" href="/print.css"></head><body>
<div class="toolbar no-print"><button class="btn" id="print">🖨 Басып шығару</button><a class="btn ghost" href="/admin">← Артқа</a>
<span>${escapeHtml(link)}</span></div>
<main class="sheet">${card.repeat(8)}</main>
<script src="/print.js"></script></body></html>`;
}
