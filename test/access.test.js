// Проверки доступа. Запуск: npm test
// Postgres тоже проверяется, если задан TEST_DATABASE_URL.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PIN = '4321';

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startServer(env) {
  const port = await freePort();
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('сервер не запустился:\n' + log)), 15000);
    const onData = (d) => {
      log += d;
      if (log.includes('іске қосылды')) {
        clearTimeout(t);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (c) => reject(new Error(`сервер завершился (${c}):\n${log}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  return { base, child, stop: () => child.kill() };
}

// маленький клиент с «банкой» для куки
function client(base, extraHeaders = {}) {
  let jar = {};
  return {
    jar: () => jar,
    async req(p, { method = 'GET', json, body, headers = {} } = {}) {
      const h = { ...extraHeaders, ...headers };
      if (Object.keys(jar).length) h.cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      if (json !== undefined) {
        h['content-type'] = 'application/json';
        body = JSON.stringify(json);
      }
      const res = await fetch(base + p, { method, headers: h, body, redirect: 'manual' });
      for (const c of res.headers.getSetCookie()) {
        const [kv] = c.split(';');
        const i = kv.indexOf('=');
        const v = kv.slice(i + 1);
        if (/Max-Age=0/.test(c)) delete jar[kv.slice(0, i)];
        else jar[kv.slice(0, i)] = v;
      }
      return res;
    },
  };
}

function dispositionName(res) {
  const cd = res.headers.get('content-disposition') || '';
  const m = /filename\*=UTF-8''([^;]+)/.exec(cd);
  return { type: cd.split(';')[0], name: m ? decodeURIComponent(m[1]) : null };
}

function suite(label, makeEnv) {
  describe(label, () => {
    let srv, env, codes, mats;
    const admin = () => client(srv.base, { 'x-req': '1' });

    before(async () => {
      env = await makeEnv();
      execFileSync(process.execPath, ['scripts/seed.js'], { cwd: ROOT, env: { PATH: process.env.PATH, ...env } });
      srv = await startServer({ ADMIN_PIN: PIN, CODE_MAX_FAILS: '6', PIN_MAX_FAILS: '4', ...env });
      const a = admin();
      assert.equal((await a.req('/api/admin/login', { method: 'POST', json: { pin: PIN } })).status, 200);
      const ov = await (await a.req('/api/admin/overview')).json();
      codes = Object.fromEntries(ov.classes.map((c) => [c.name, c.code]));
      mats = Object.fromEntries(ov.materials.map((m) => [m.title, m]));
    });
    after(() => srv?.stop());

    const PDF_8G = 'Дәреже қасиеттері — конспект';
    const DOCX_7A = 'Сызықтық теңдеулер — үй тапсырмасы №3';

    test('ученик 7Ә видит только свои и общие материалы', async () => {
      const s = client(srv.base);
      const j = await s.req('/api/join', { method: 'POST', json: { code: codes['7Ә'].toLowerCase() } });
      assert.equal(j.status, 200);
      const data = await (await s.req('/api/materials')).json();
      assert.equal(data.class.name, '7Ә');
      const titles = data.materials.map((m) => m.title);
      assert.ok(titles.includes(DOCX_7A), 'своё задание видно');
      assert.ok(titles.includes('Дәрежеге кіріспе (Khan Academy)'), 'общее видео видно');
      assert.ok(!titles.includes(PDF_8G), 'PDF класса 8Ғ не виден');
      assert.ok(!titles.some((t) => t.startsWith('Desmos')), 'ссылка 8Ғ/9А не видна');
      assert.ok(!JSON.stringify(data).includes('storage'), 'служебные поля не утекают');
    });

    test('ученик 7Ә не скачивает файл 8Ғ по прямой ссылке', async () => {
      const s = client(srv.base);
      await s.req('/api/join', { method: 'POST', json: { code: codes['7Ә'] } });
      const id = mats[PDF_8G].id;
      assert.equal((await s.req(`/f/${id}`)).status, 403);
      assert.equal((await s.req(`/f/${id}?dl=1`)).status, 403);
      // без кода вообще
      assert.equal((await fetch(`${srv.base}/f/${id}`)).status, 403);
      // подделанная кука
      assert.equal((await fetch(`${srv.base}/f/${id}`, { headers: { cookie: 'cls=ZZZ99' } })).status, 403);
    });

    test('ученик 8Ғ открывает свой PDF в браузере, имя файла на казахском', async () => {
      const s = client(srv.base);
      await s.req('/api/join', { method: 'POST', json: { code: codes['8Ғ'] } });
      const res = await s.req(`/f/${mats[PDF_8G].id}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/pdf');
      const d = dispositionName(res);
      assert.equal(d.type, 'inline');
      assert.equal(d.name, 'Дәреже_қасиеттері_конспект.pdf');
      const buf = Buffer.from(await res.arrayBuffer());
      assert.deepEqual(buf, fs.readFileSync(path.join(ROOT, 'seed', 'Дәреже_қасиеттері_конспект.pdf')));
      assert.equal(dispositionName(await s.req(`/f/${mats[PDF_8G].id}?dl=1`)).type, 'attachment');
    });

    test('Word скачивается с правильным казахским именем', async () => {
      const s = client(srv.base);
      await s.req('/api/join', { method: 'POST', json: { code: codes['7Ә'] } });
      const res = await s.req(`/f/${mats[DOCX_7A].id}`);
      assert.equal(res.status, 200);
      const d = dispositionName(res);
      assert.equal(d.type, 'attachment');
      assert.equal(d.name, 'Теңдеулер_үй_тапсырмасы_№3.docx');
    });

    test('неверный PIN не пускает учителя', async () => {
      const a = admin();
      const r = await a.req('/api/admin/login', { method: 'POST', json: { pin: '0000' } });
      assert.equal(r.status, 401);
      assert.equal((await a.req('/api/admin/overview')).status, 401);
      assert.equal((await a.req('/api/admin/classes', { method: 'POST', json: { name: 'X' } })).status, 401);
      // поддельный токен
      const f = await fetch(`${srv.base}/api/admin/overview`, { headers: { cookie: `adm=${Date.now() + 1e9}.AAAA` } });
      assert.equal(f.status, 401);
      // карточку печати без входа не отдаём
      assert.equal((await fetch(`${srv.base}/print/1`, { redirect: 'manual' })).status, 302);
    });

    test('учитель загружает файл с казахским именем, лимит 20 МБ, защита от CSRF', async () => {
      const a = admin();
      await a.req('/api/admin/login', { method: 'POST', json: { pin: PIN } });
      const name = 'Бақылау жұмысы №2 (Ғ, Қ, Ң, Ө, Ұ, Ү, Һ, І).docx';
      const meta = { title: 'Бақылау жұмысы', topic: 'Теңдеулер', classIds: [], allClasses: true };
      const body = Buffer.from('PK test');
      const up = await a.req('/api/admin/materials/upload', {
        method: 'POST', body,
        headers: { 'x-file-name': encodeURIComponent(name), 'x-meta': encodeURIComponent(JSON.stringify(meta)) },
      });
      assert.equal(up.status, 201, await up.clone().text());
      const m = await up.json();
      assert.equal(m.file.name, name);
      const dl = await fetch(`${srv.base}/f/${m.id}`, { headers: { cookie: `cls=${codes['9А']}` } });
      assert.equal(dispositionName(dl).name, name);
      assert.deepEqual(Buffer.from(await dl.arrayBuffer()), body);

      const big = await a.req('/api/admin/materials/upload', {
        method: 'POST', body: Buffer.alloc(20 * 1024 * 1024 + 1),
        headers: { 'x-file-name': 'big.pdf', 'x-meta': encodeURIComponent(JSON.stringify(meta)) },
      }).catch((e) => ({ status: 'reset:' + e.message }));
      assert.ok(big.status === 413 || String(big.status).startsWith('reset'), 'больше 20 МБ не принимаем: ' + big.status);

      const exe = await a.req('/api/admin/materials/upload', {
        method: 'POST', body, headers: { 'x-file-name': 'virus.exe', 'x-meta': encodeURIComponent(JSON.stringify(meta)) },
      });
      assert.equal(exe.status, 400);

      const bad = await a.req('/api/admin/materials', {
        method: 'POST', json: { ...meta, type: 'link', url: 'javascript:alert(1)' },
      });
      assert.equal(bad.status, 400);

      // без заголовка X-Req (запрос с чужого сайта) — отказ
      const csrf = await fetch(`${srv.base}/api/admin/materials/${m.id}`, {
        method: 'DELETE', headers: { cookie: `adm=${a.jar().adm}` },
      });
      assert.equal(csrf.status, 403);

      assert.equal((await a.req(`/api/admin/materials/${m.id}`, { method: 'DELETE' })).status, 200);
      assert.equal((await fetch(`${srv.base}/f/${m.id}`, { headers: { cookie: `cls=${codes['9А']}` } })).status, 404);
    });

    test('после смены кода класса старый код не работает', async () => {
      const a = admin();
      await a.req('/api/admin/login', { method: 'POST', json: { pin: PIN } });
      const ov = await (await a.req('/api/admin/overview')).json();
      const c9 = ov.classes.find((c) => c.name === '9А');
      const s = client(srv.base);
      await s.req('/api/join', { method: 'POST', json: { code: c9.code } });
      const r = await a.req(`/api/admin/classes/${c9.id}`, { method: 'PUT', json: { code: 'MAT909' } });
      assert.equal(r.status, 200);
      assert.equal((await s.req('/api/materials')).status, 401);
      const dup = await a.req(`/api/admin/classes/${c9.id}`, { method: 'PUT', json: { code: codes['7Ә'] } });
      assert.equal(dup.status, 409);
      const qr = await a.req(`/api/admin/classes/${c9.id}/qr.svg`);
      assert.match(await qr.text(), /<svg/);
    });

    test('ответы с автопроверкой: проверка на сервере, ключ не утекает', async () => {
      const id = mats[DOCX_7A].id; // ключ: 5, 3, 9, 5, 150
      const s = client(srv.base);
      await s.req('/api/join', { method: 'POST', json: { code: codes['7Ә'] } });
      const list = await (await s.req('/api/materials')).json();
      const pub = list.materials.find((m) => m.id === id);
      assert.deepEqual(pub.quiz, { count: 5, open: true, retry: false });
      assert.ok(!JSON.stringify(list).includes('150'), 'правильные ответы не отдаются ученику');

      const r = await s.req(`/api/quiz/${id}`, { method: 'POST', json: { name: ' Әлия  Серікқызы ', answers: ['5', '3,0', 'x = 9', '4', '150'] } });
      assert.equal(r.status, 200);
      const g = await r.json();
      assert.equal(g.score, 4);
      assert.deepEqual(g.marks, [true, true, true, false, true]);
      assert.equal(g.correct, undefined, 'без разрешения учителя правильные ответы не показываются');

      const again = await s.req(`/api/quiz/${id}`, { method: 'POST', json: { name: 'әлия серікқызы', answers: ['5'] } });
      assert.equal(again.status, 409, 'пересдача под тем же именем запрещена');

      // другой класс не может отвечать на задание 7Ә
      const s8 = client(srv.base);
      await s8.req('/api/join', { method: 'POST', json: { code: codes['8Ғ'] } });
      assert.equal((await s8.req(`/api/quiz/${id}`, { method: 'POST', json: { name: 'Чужой ученик', answers: ['5'] } })).status, 404);
      assert.equal((await fetch(`${srv.base}/api/quiz/${id}`, { method: 'POST', body: '{}' })).status, 401);

      // учитель видит результат; исправленный ключ пересчитывает оценку
      const a = admin();
      await a.req('/api/admin/login', { method: 'POST', json: { pin: PIN } });
      let t = await (await a.req(`/api/admin/materials/${id}/results`)).json();
      assert.equal(t.results.length, 1);
      assert.equal(t.results[0].name, 'Әлия Серікқызы');
      assert.equal(t.results[0].score, 4);
      const upd = await a.req(`/api/admin/materials/${id}`, {
        method: 'PUT', json: { quiz: { answers: ['5', '3', '9', '4 | 5', '150'], open: true, retry: true, show: true } },
      });
      assert.equal(upd.status, 200);
      t = await (await a.req(`/api/admin/materials/${id}/results`)).json();
      assert.equal(t.results[0].score, 5);

      const csv = await a.req(`/api/admin/materials/${id}/results.csv`);
      const bytes = Buffer.from(await csv.arrayBuffer());
      assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM для Excel');
      const text = bytes.toString('utf8');
      assert.match(text, /Әлия Серікқызы/);

      // пересдача разрешена, правильные ответы показываются; закрытое задание не принимает ответы
      const r2 = await (await s.req(`/api/quiz/${id}`, { method: 'POST', json: { name: 'Әлия Серікқызы', answers: ['1'] } })).json();
      assert.deepEqual(r2.correct, ['5', '3', '9', '4 | 5', '150']);
      await a.req(`/api/admin/materials/${id}`, { method: 'PUT', json: { quiz: { answers: ['5'], open: false } } });
      assert.equal((await s.req(`/api/quiz/${id}`, { method: 'POST', json: { name: 'Әлия Серікқызы', answers: ['5'] } })).status, 403);
      assert.equal((await a.req(`/api/admin/materials/${id}/results`, { method: 'DELETE' })).status, 200);
    });

    test('вход учеников по списку класса и PIN', async () => {
      const a = admin();
      await a.req('/api/admin/login', { method: 'POST', json: { pin: PIN } });
      const ov = await (await a.req('/api/admin/overview')).json();
      const c8 = ov.classes.find((c) => c.name === '8Ғ');
      const add = await (await a.req(`/api/admin/classes/${c8.id}/students`, {
        method: 'POST', json: { names: '1. Әлия Серікқызы\n2) Нұрлан Б.\n\nәлия  серікқызы\n3\tАйгерім Т.' },
      })).json();
      assert.deepEqual(add, { added: 3, skipped: 1 });

      // ученик с кодом класса, но без личного входа — ничего не видит и не скачивает
      const s = client(srv.base);
      await s.req('/api/join', { method: 'POST', json: { code: codes['8Ғ'] } });
      const m401 = await s.req('/api/materials');
      assert.equal(m401.status, 401);
      assert.equal((await m401.json()).needLogin, true);
      assert.equal((await s.req(`/f/${mats[PDF_8G].id}`)).status, 403);
      const roster = (await (await s.req('/api/roster')).json()).students;
      assert.deepEqual(roster.map((x) => x.name), ['Айгерім Т.', 'Әлия Серікқызы', 'Нұрлан Б.'].sort((x, y) => x.localeCompare(y, 'kk')));
      assert.ok(!JSON.stringify(roster).includes('pin'), 'хеши PIN не отдаются');
      const alia = roster.find((x) => x.name === 'Әлия Серікқызы');
      const nurlan = roster.find((x) => x.name === 'Нұрлан Б.');

      // первый вход — PIN создаётся
      assert.equal((await s.req('/api/student/login', { method: 'POST', json: { id: alia.id, pin: '12a4' } })).status, 400);
      assert.equal((await s.req('/api/student/login', { method: 'POST', json: { id: alia.id, pin: '1234' } })).status, 200);
      const me = await (await s.req('/api/materials')).json();
      assert.equal(me.student.name, 'Әлия Серікқызы');
      assert.equal((await s.req(`/f/${mats[PDF_8G].id}`)).status, 200);

      // на чужом телефоне занять имя Әлии нельзя; подбор PIN блокируется
      const thief = client(srv.base);
      await thief.req('/api/join', { method: 'POST', json: { code: codes['8Ғ'] } });
      for (let i = 0; i < 5; i++) {
        assert.equal((await thief.req('/api/student/login', { method: 'POST', json: { id: alia.id, pin: String(5000 + i) } })).status, 401);
      }
      assert.equal((await thief.req('/api/student/login', { method: 'POST', json: { id: alia.id, pin: '1234' } })).status, 429);
      // ученик из другого класса не может войти под именем из 8Ғ
      const other = client(srv.base);
      await other.req('/api/join', { method: 'POST', json: { code: codes['7Ә'] } });
      assert.equal((await other.req('/api/student/login', { method: 'POST', json: { id: nurlan.id, pin: '1111' } })).status, 404);

      // ответы записываются на ученика, имя вписывать не нужно
      const n = client(srv.base);
      await n.req('/api/join', { method: 'POST', json: { code: codes['8Ғ'] } });
      await n.req('/api/student/login', { method: 'POST', json: { id: nurlan.id, pin: '5555' } });
      const quizMat = await (await a.req('/api/admin/materials', {
        method: 'POST',
        json: { title: 'Өзіндік жұмыс', topic: 'Дәреже', type: 'link', url: 'https://example.com/', classIds: [c8.id], quiz: { answers: ['8', '1/2'] } },
      })).json();
      const r = await (await n.req(`/api/quiz/${quizMat.id}`, { method: 'POST', json: { name: 'Басқа есім', answers: ['8', '0,5'] } })).json();
      assert.equal(r.score, 2);
      assert.equal((await n.req(`/api/quiz/${quizMat.id}`, { method: 'POST', json: { answers: ['8', '1'] } })).status, 409);
      const mats8 = await (await n.req('/api/materials')).json();
      assert.deepEqual(mats8.materials.find((m) => m.id === quizMat.id).quiz.done, { score: 2, total: 2 });
      const t = await (await a.req(`/api/admin/materials/${quizMat.id}/results`)).json();
      assert.equal(t.results[0].name, 'Нұрлан Б.');
      assert.deepEqual(t.missing.map((x) => x.name).sort(), ['Айгерім Т.', 'Әлия Серікқызы'].sort());

      // учитель видит класс без личного входа, но ответить за ученика не может
      const view = client(srv.base, { 'x-req': '1' });
      await view.req('/api/admin/login', { method: 'POST', json: { pin: PIN } });
      await view.req('/api/join', { method: 'POST', json: { code: codes['8Ғ'] } });
      assert.equal((await (await view.req('/api/materials')).json()).preview, true);
      assert.equal((await view.req(`/api/quiz/${quizMat.id}`, { method: 'POST', json: { answers: ['8'] } })).status, 403);

      // сброс PIN завершает сессию; имя снова свободно для первого входа
      const st = await (await a.req(`/api/admin/classes/${c8.id}/students`)).json();
      assert.equal(st.find((x) => x.id === alia.id).registered, true);
      assert.equal((await a.req(`/api/admin/students/${alia.id}/reset`, { method: 'POST' })).status, 200);
      assert.equal((await s.req('/api/materials')).status, 401);
      assert.equal((await s.req('/api/student/login', { method: 'POST', json: { id: alia.id, pin: '4321' } })).status, 200);
      assert.equal((await s.req('/api/materials')).status, 200);

      // список удаляется — класс снова открыт по одному коду
      for (const x of st) await a.req(`/api/admin/students/${x.id}`, { method: 'DELETE' });
      const plain = client(srv.base);
      await plain.req('/api/join', { method: 'POST', json: { code: codes['8Ғ'] } });
      assert.equal((await plain.req('/api/materials')).status, 200);
    });

    test('подбор кода класса блокируется по IP', async () => {
      const s = client(srv.base);
      let last;
      for (let i = 0; i < 6; i++) last = await s.req('/api/join', { method: 'POST', json: { code: `QQQ${20 + i}` } });
      assert.equal(last.status, 404);
      const blocked = await s.req('/api/join', { method: 'POST', json: { code: codes['7Ә'] } });
      assert.equal(blocked.status, 429, 'даже верный код после блокировки отклоняется');
      assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    });

    test('подбор PIN блокируется по IP', async () => {
      const a = admin();
      for (let i = 0; i < 4; i++) await a.req('/api/admin/login', { method: 'POST', json: { pin: String(1000 + i) } });
      const r = await a.req('/api/admin/login', { method: 'POST', json: { pin: PIN } });
      assert.equal(r.status, 429);
    });
  });
}

suite('локальный режим (папка data/)', async () => ({
  DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'mat-')),
}));

if (process.env.TEST_DATABASE_URL) {
  suite('Postgres', async () => {
    const c = new pg.Client(process.env.TEST_DATABASE_URL);
    await c.connect();
    try {
      await c.query('DROP TABLE IF EXISTS results, students, classes, materials, files, settings CASCADE');
    } finally {
      await c.end();
    }
    return { DATABASE_URL: process.env.TEST_DATABASE_URL, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'mat-')) };
  });
}

describe('сайт в интернете без ADMIN_PIN', () => {
  let srv;
  before(async () => {
    srv = await startServer({ RENDER: 'true', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'mat-')) });
  });
  after(() => srv?.stop());

  test('страница учителя закрыта', async () => {
    const st = await (await fetch(`${srv.base}/api/admin/state`)).json();
    assert.equal(st.mode, 'closed');
    const r = await fetch(`${srv.base}/api/admin/login`, { method: 'POST', body: JSON.stringify({ pin: '' }), headers: { 'x-req': '1' } });
    assert.equal(r.status, 403);
    assert.equal((await fetch(`${srv.base}/api/admin/overview`)).status, 403);
  });
});
