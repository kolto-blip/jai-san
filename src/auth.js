import crypto from 'node:crypto';
import { config } from './config.js';
import { parseCookies, isLoopback } from './util.js';

const SESSION_DAYS = 30;

// Режим страницы учителя:
//  pin    — ADMIN_PIN задан, вход по PIN;
//  local  — PIN не задан, сайт запущен локально: пускаем только с этого же компьютера;
//  closed — PIN не задан, сайт в интернете: страница учителя закрыта.
export function adminMode(req) {
  if (config.adminPin) return 'pin';
  if (!config.isPublic && isLoopback(req)) return 'local';
  return 'closed';
}

export async function createAuth(repo) {
  let secret = await repo.getSetting('session_secret');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    await repo.setSetting('session_secret', secret);
  }
  // Смена PIN автоматически делает старые сессии недействительными.
  const key = crypto.createHmac('sha256', secret).update('admin:' + config.adminPin).digest();
  const sign = (s) => crypto.createHmac('sha256', key).update(s).digest('base64url');

  const studentKey = crypto.createHmac('sha256', secret).update('student').digest();
  const signStudent = (s) => crypto.createHmac('sha256', studentKey).update(s).digest('base64url');

  return {
    // ---------- ученики ----------
    studentToken(student) {
      const body = `${student.id}.${student.pinVer}`;
      return `${body}.${signStudent(body)}`;
    },
    // → { id, ver } или null; версия PIN проверяется по базе (сброс PIN завершает сессии)
    readStudentToken(token) {
      const [id, ver, sig] = String(token || '').split('.');
      if (!id || !ver || !sig) return null;
      const good = Buffer.from(signStudent(`${id}.${ver}`));
      const got = Buffer.from(sig);
      if (good.length !== got.length || !crypto.timingSafeEqual(good, got)) return null;
      return { id: Number(id), ver: Number(ver) };
    },
    hashPin(pin) {
      const salt = crypto.randomBytes(16).toString('hex');
      return `${salt}:${crypto.scryptSync(String(pin), salt, 32).toString('hex')}`;
    },
    checkStudentPin(pin, stored) {
      const [salt, hash] = String(stored || '').split(':');
      if (!salt || !hash) return false;
      const a = crypto.scryptSync(String(pin), salt, 32);
      const b = Buffer.from(hash, 'hex');
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    },

    issueToken() {
      const exp = String(Date.now() + SESSION_DAYS * 86400_000);
      return { token: `${exp}.${sign(exp)}`, maxAge: SESSION_DAYS * 86400 };
    },
    checkPin(pin) {
      const a = crypto.createHash('sha256').update(String(pin ?? '')).digest();
      const b = crypto.createHash('sha256').update(config.adminPin).digest();
      return config.adminPin !== '' && crypto.timingSafeEqual(a, b);
    },
    isAdmin(req) {
      const mode = adminMode(req);
      if (mode === 'local') return true;
      if (mode === 'closed') return false;
      const t = parseCookies(req).adm || '';
      const [exp, sig] = t.split('.');
      if (!exp || !sig || Number(exp) < Date.now()) return false;
      const good = Buffer.from(sign(exp));
      const got = Buffer.from(sig);
      return good.length === got.length && crypto.timingSafeEqual(good, got);
    },
  };
}
