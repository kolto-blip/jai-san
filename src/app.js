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
import { grade, nameKey, entLetters } from './grade.js';
import { aiConfig, checkHomework, AiError } from './ai.js';
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
  "img-src 'self' data: blob: https://i.ytimg.com",
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
    if (m.hw) out.hw = { open: m.hw.open, due: m.hw.due || null };
    if (m.quiz?.answers?.length) {
      // сами ответы ученикам не отдаём
      out.quiz = { count: m.quiz.answers.length, open: m.quiz.open, retry: m.quiz.retry };
      if (m.quiz.ent) {
        // какие вопросы с несколькими ответами — это написано и в самом варианте; сами буквы не отдаём
        out.quiz.ent = { ...m.quiz.ent, multi: m.quiz.answers.map((a) => entLetters(a).length > 1) };
        if (m.quiz.ent.questions) {
          out.quiz.ent.questions = m.quiz.ent.questions.map((x) => ({
            text: x.text, options: x.options, img: x.img ? `/qimg/${x.img.key}` : null,
          }));
        }
      }
    }
    return out;
  }

  function adminMaterial(m, resultCounts = {}, subCounts = {}) {
    return {
      ...publicMaterial(m), allClasses: m.allClasses, classIds: m.classIds, storage: m.storage,
      quizKey: m.quiz || null, results: resultCounts[m.id] || 0,
      submissions: subCounts[m.id] || { total: 0, unchecked: 0 },
    };
  }

  function parseHw(h) {
    if (!h) return null;
    const due = h.due ? String(h.due) : null;
    if (due && !validDate(due)) throw new HttpError(400, 'Мерзімі қате');
    return { open: h.open !== false, due, aiNote: String(h.aiNote || '').trim().slice(0, 500) };
  }

  // сдано после конца дня срока (по времени школы)
  function isLate(createdAt, due) {
    if (!due) return false;
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: config.timeZone }).format(new Date(createdAt));
    return day > due;
  }

  async function removeStored(files) {
    for (const f of files) {
      try {
        await storages.get(f.storage).del(f.storageKey);
      } catch (e) {
        console.error('Фото жою қатесі:', e.message);
      }
    }
  }

  function parseQuiz(q) {
    if (!q) return null;
    const answers = (Array.isArray(q.answers) ? q.answers : String(q.answers || '').split('\n'))
      .map((a) => String(a).trim().slice(0, 100));
    while (answers.length && !answers[answers.length - 1]) answers.pop();
    if (!answers.length) return null;
    if (answers.length > 50) throw new HttpError(400, 'Жауап кілтінде 50-ден көп жол болмауы керек');
    if (answers.some((a) => !a)) throw new HttpError(400, 'Жауап кілтінде бос жол бар');
    const out = { answers, open: q.open !== false, retry: Boolean(q.retry), show: Boolean(q.show) };
    if (q.ent) {
      const letters = Math.min(8, Math.max(4, Number(q.ent.letters) || 5));
      const allowed = 'ABCDEFGH'.slice(0, letters);
      out.answers = answers.map((a, i) => {
        const l = entLetters(a);
        if (!l || [...l].some((c) => !allowed.includes(c))) {
          throw new HttpError(400, `ЕНТ кілтінің ${i + 1}-жолы: тек ${allowed[0]}–${allowed[letters - 1]} әріптері (мысалы: B немесе ACE)`);
        }
        return l;
      });
      out.ent = {
        letters,
        minutes: Math.min(300, Math.max(0, Math.round(Number(q.ent.minutes) || 0))), // 0 — без таймера
        subject: String(q.ent.subject || 'Математика').trim().slice(0, 60),
      };
      // Вопросы для показа по одному на экране (необязательно; без них — PDF + бланк)
      if (Array.isArray(q.ent.questions) && q.ent.questions.length) {
        if (q.ent.questions.length !== out.answers.length) throw new HttpError(400, 'Сұрақтар саны мен кілт саны сәйкес емес');
        out.ent.questions = q.ent.questions.map((x, i) => {
          const img = x?.img && /^qi-[0-9a-f]{32}$/.test(x.img.key) && ['db', 'local', 'b2'].includes(x.img.storage)
            ? { key: x.img.key, storage: x.img.storage } : null;
          const text = String(x?.text || '').trim().slice(0, 3000);
          if (!text && !img) throw new HttpError(400, `${i + 1}-сұрақ бос: мәтін жазыңыз немесе сурет қойыңыз`);
          const options = Array.from({ length: letters }, (_, j) => String(x?.options?.[j] || '').trim().slice(0, 400));
          return { text, img, options };
        });
      }
    }
    return out;
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
    if (input.hw !== undefined) fields.hw = parseHw(input.hw);
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
          const g = grade(r.answers, byId[m.id].quiz);
          m.quiz.done = { score: g.score, total: g.total };
        }
      }
    }
    if (a.student) {
      const subs = {};
      for (const x of await repo.listSubmissionsForStudent(a.student.id)) (subs[x.materialId] ||= []).push(x);
      for (const m of list) {
        const mine = subs[m.id];
        if (!m.hw || !mine) continue;
        const last = mine[mine.length - 1];
        const checked = [...mine].reverse().find((x) => x.status === 'checked');
        m.hw.sent = {
          at: last.createdAt, photos: last.files.length, count: mine.length,
          files: last.files.map((f) => `/hw/photo/${f.id}`),
          checked: checked ? { grade: checked.grade, feedback: checked.feedback } : null,
          late: isLate(last.createdAt, m.hw.due),
        };
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
    const [classes, materials, used, resultCounts, studentCounts, subCounts, photoBytes] = await Promise.all([
      repo.listClasses(), repo.listMaterials(), repo.usageBytes(), repo.countResults(), repo.countStudents(),
      repo.countSubmissions(), repo.photoBytes(),
    ]);
    const counts = {};
    for (const m of materials) for (const id of m.classIds) counts[id] = (counts[id] || 0) + 1;
    sendJson(res, 200, {
      classes: classes.map((c) => ({ ...c, materials: counts[c.id] || 0, students: studentCounts[c.id] || { total: 0, registered: 0 } })),
      materials: materials.map((m) => adminMaterial(m, resultCounts, subCounts)),
      usage: { usedBytes: used, photoBytes, limitMb: storages.limitMb, storage: storages.active.name, maxFileMb: config.maxFileBytes / 1048576 },
      baseUrl: baseUrl(req),
      ai: { enabled: aiConfig.enabled, model: aiConfig.model },
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
    const fields = await materialFields(await readJson(req, 2 * 1024 * 1024), { isFile: false });
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
    const fields = await materialFields(await readJson(req, 2 * 1024 * 1024), { isFile: Boolean(existing.storage), existing });
    const updated = await repo.updateMaterial(existing.id, fields);
    await dropUnusedQuizImages(existing.quiz, updated.quiz);
    sendJson(res, 200, adminMaterial(updated));
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
      const photos = await repo.deleteSubmissionsForMaterial(m.id);
      await repo.deleteMaterial(m.id);
      await removeFile(m);
      await removeStored(photos);
      await dropUnusedQuizImages(m.quiz, null);
    }
    sendJson(res, 200, { ok: true });
  });

  // ---------- Фото домашних работ ----------
  const MAX_PHOTOS = 6;
  const MAX_PHOTO_BYTES = 6 * 1024 * 1024;

  // ---------- Картинки вопросов ЕНТ ----------
  const quizImages = (quiz) => (quiz?.ent?.questions || []).map((x) => x.img).filter(Boolean);

  async function dropUnusedQuizImages(oldQuiz, newQuiz) {
    const keep = new Set(quizImages(newQuiz).map((x) => x.key));
    await removeStored(quizImages(oldQuiz).filter((x) => !keep.has(x.key)).map((x) => ({ storage: x.storage, storageKey: x.key })));
  }

  // Учитель загружает картинку вопроса (скриншот); ссылка на неё попадёт в ключ при сохранении материала
  route('POST', /^\/api\/admin\/qimages$/, async (req, res) => {
    requireAdmin(req);
    const buf = await readBody(req, 3 * 1024 * 1024);
    const mime = imageMime(buf);
    if (!mime) throw new HttpError(400, 'Тек сурет (JPEG, PNG, WebP)');
    const key = 'qi-' + crypto.randomBytes(16).toString('hex');
    await storages.active.put(key, buf);
    sendJson(res, 201, { img: { key, storage: storages.active.name }, url: `/qimg/${key}` });
  });

  // Картинку вопроса видит учитель и ученики классов, которым доступен этот вариант
  route('GET', /^\/qimg\/(qi-[0-9a-f]{32})$/, async (req, res, [key]) => {
    let img = null;
    const find = (list) => {
      for (const m of list) for (const x of quizImages(m.quiz)) if (x.key === key) return x;
      return null;
    };
    if (auth.isAdmin(req)) img = find(await repo.listMaterials());
    else {
      const a = await access(req);
      if (a.ok) img = find(await repo.listMaterialsForClass(a.cls.id));
    }
    if (!img) {
      // только что загруженная, ещё не сохранённая в материале картинка — видна учителю
      if (auth.isAdmin(req)) img = { key, storage: storages.active.name };
      else throw new HttpError(404, 'Сурет табылмады');
    }
    let buf;
    try {
      buf = await storages.get(img.storage).get(img.key);
    } catch {
      throw new HttpError(404, 'Сурет табылмады');
    }
    res.writeHead(200, {
      'Content-Type': imageMime(buf) || 'application/octet-stream', 'Content-Length': buf.length,
      'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff',
    });
    res.end(buf);
  });

  function imageMime(buf) {
    if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return 'image/png';
    if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    return null;
  }

  // Тело запроса — фото подряд, их размеры в заголовке X-Parts («123,456»).
  route('POST', /^\/api\/hw\/(\d+)$/, async (req, res, [id]) => {
    const ip = clientIp(req);
    if (submitLimiter.isBlocked(ip)) return tooMany(res, submitLimiter, ip);
    const a = await access(req);
    if (!a.cls) return sendJson(res, 401, { error: 'Сынып кодын енгізіңіз' });
    if (a.roster && !a.student) {
      if (a.admin) throw new HttpError(403, 'Мұғалім ретінде қарап отырсыз — жұмыс жіберілмейді');
      return sendJson(res, 401, { error: 'Атыңызды таңдап, PIN енгізіңіз', needLogin: true });
    }
    const m = await repo.getMaterial(Number(id));
    if (!m || !m.hw || !(m.allClasses || m.classIds.includes(a.cls.id))) throw new HttpError(404, 'Тапсырма табылмады');
    if (!m.hw.open) throw new HttpError(403, 'Жұмыс қабылдау жабылды');
    const meta = readMeta(req);
    const name = a.student ? a.student.name : String(meta.name || '').normalize('NFC').trim().replace(/\s+/g, ' ').slice(0, 60);
    if (name.length < 2) throw new HttpError(400, 'Аты-жөніңізді жазыңыз');
    const sizes = String(req.headers['x-parts'] || '').split(',').map(Number);
    if (!sizes.length || sizes.length > MAX_PHOTOS || sizes.some((n) => !Number.isInteger(n) || n <= 0 || n > MAX_PHOTO_BYTES)) {
      throw new HttpError(400, `1–${MAX_PHOTOS} фото, әрқайсысы ${MAX_PHOTO_BYTES / 1048576} МБ-тан аспауы керек`);
    }
    const total = sizes.reduce((x, y) => x + y, 0);
    const body = await readBody(req, total);
    if (body.length !== total) throw new HttpError(400, 'Фото толық жүктелмеді, қайталаңыз');
    if ((await repo.usageBytes()) + total > storages.limitMb * 1024 * 1024) throw new HttpError(413, 'Қоймада орын жоқ. Мұғалімге айтыңыз.');
    const parts = [];
    let off = 0;
    for (const n of sizes) {
      const buf = body.subarray(off, off + n);
      off += n;
      const mime = imageMime(buf);
      if (!mime) throw new HttpError(400, 'Тек сурет (JPEG, PNG) жіберуге болады');
      parts.push({ buf, mime });
    }
    submitLimiter.fail(ip);
    const files = [];
    try {
      for (const p of parts) {
        const key = 'hw-' + crypto.randomBytes(16).toString('hex');
        await storages.active.put(key, p.buf);
        files.push({ storage: storages.active.name, storageKey: key, size: p.buf.length, mime: p.mime });
      }
    } catch (e) {
      await removeStored(files);
      throw e;
    }
    const comment = String(meta.comment || '').trim().slice(0, 300);
    const sub = await repo.createSubmission({ materialId: m.id, classId: a.cls.id, studentId: a.student?.id ?? null, name, comment }, files);
    sendJson(res, 200, { ok: true, at: sub.createdAt, photos: files.length, late: isLate(sub.createdAt, m.hw.due) });
  });

  // Фото видит только учитель и сам ученик
  route('GET', /^\/hw\/photo\/(\d+)$/, async (req, res, [id]) => {
    const f = await repo.getSubmissionFile(Number(id));
    let allowed = Boolean(f && auth.isAdmin(req));
    if (f && !allowed && f.studentId) {
      const a = await access(req);
      allowed = a.student?.id === f.studentId;
    }
    if (!allowed) {
      res.writeHead(f ? 403 : 404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(errorPage(f ? 'Бұл фотоны тек мұғалім мен оның иесі көре алады.' : 'Фото табылмады.'));
    }
    const buf = await storages.get(f.storage).get(f.storageKey);
    res.writeHead(200, {
      'Content-Type': f.mime, 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `inline; filename="photo-${f.id}.jpg"`,
    });
    res.end(buf);
  });

  route('GET', /^\/api\/admin\/materials\/(\d+)\/submissions$/, async (req, res, [id]) => {
    requireAdmin(req);
    const m = await repo.getMaterial(Number(id));
    if (!m) throw new HttpError(404, 'Материал табылмады');
    const classes = await repo.listClasses();
    const names = Object.fromEntries(classes.map((c) => [c.id, c.name]));
    const students = {};
    for (const c of classes) {
      if (!m.allClasses && !m.classIds.includes(c.id)) continue;
      for (const st of await repo.listStudents(c.id)) students[st.id] = st;
    }
    const subs = (await repo.listSubmissionsForMaterial(m.id)).map((x) => ({
      id: x.id, name: students[x.studentId]?.name || x.name, classId: x.classId, className: names[x.classId] || '—',
      studentId: x.studentId, comment: x.comment, status: x.status, grade: x.grade, feedback: x.feedback,
      createdAt: x.createdAt, late: isLate(x.createdAt, m.hw?.due), ai: x.ai || null,
      files: x.files.map((f) => ({ id: f.id, size: f.size, url: `/hw/photo/${f.id}` })),
    }));
    const done = new Set(subs.map((x) => x.studentId).filter(Boolean));
    const missing = Object.values(students).filter((st) => !done.has(st.id))
      .map((st) => ({ name: st.name, classId: st.classId, className: names[st.classId] || '—', registered: st.registered }));
    sendJson(res, 200, { material: { id: m.id, title: m.title, due: m.hw?.due || null }, submissions: subs, missing });
  });

  route('PUT', /^\/api\/admin\/submissions\/(\d+)$/, async (req, res, [id]) => {
    requireAdmin(req);
    const b = await readJson(req);
    await repo.updateSubmission(Number(id), {
      status: b.status === 'checked' ? 'checked' : 'new',
      grade: String(b.grade || '').trim().slice(0, 20),
      feedback: String(b.feedback || '').trim().slice(0, 300),
    });
    sendJson(res, 200, { ok: true });
  });

  // Проверка работы ИИ: результат — только подсказка учителю, ученику не показывается
  route('POST', /^\/api\/admin\/submissions\/(\d+)\/ai$/, async (req, res, [id]) => {
    requireAdmin(req);
    if (!aiConfig.enabled) throw new HttpError(503, 'AI қосылмаған: Render баптауларында ANTHROPIC_API_KEY қосыңыз.');
    const sub = await repo.getSubmission(Number(id));
    if (!sub) throw new HttpError(404, 'Жұмыс табылмады');
    const m = await repo.getMaterial(sub.materialId);
    const photos = [];
    for (const f of sub.files) photos.push({ buf: await storages.get(f.storage).get(f.storageKey), mime: f.mime });
    const taskPdf = m.storage && fileExt(m.fileName) === 'pdf' ? await storages.get(m.storage).get(m.storageKey) : null;
    let ai;
    try {
      ai = await checkHomework({
        title: m.title, taskPdf, answerKey: m.quiz?.answers || null,
        teacherNote: m.hw?.aiNote || '', studentComment: sub.comment, photos,
      });
    } catch (e) {
      if (e instanceof AiError) throw new HttpError(502, e.message);
      throw e;
    }
    await repo.setSubmissionAi(sub.id, ai);
    sendJson(res, 200, ai);
  });

  route('DELETE', /^\/api\/admin\/submissions\/(\d+)$/, async (req, res, [id]) => {
    requireAdmin(req);
    await removeStored(await repo.deleteSubmission(Number(id)));
    sendJson(res, 200, { ok: true });
  });

  route('DELETE', /^\/api\/admin\/materials\/(\d+)\/submissions$/, async (req, res, [id]) => {
    requireAdmin(req);
    const files = await repo.deleteSubmissionsForMaterial(Number(id));
    await removeStored(files);
    sendJson(res, 200, { ok: true, freedBytes: files.reduce((x, f) => x + f.size, 0) });
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
    const g = grade(answers, m.quiz);
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
      studentId: r.studentId, answers: r.answers, createdAt: r.createdAt, ...grade(r.answers, m.quiz || key),
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
