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
    await c.query('DROP TABLE IF EXISTS classes, materials, files, settings');
    await c.end();
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
