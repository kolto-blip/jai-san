import crypto from 'node:crypto';
import os from 'node:os';
import { config } from './config.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) {
      req.resume();
      return reject(new HttpError(413, 'Файл тым үлкен (ең көбі 20 МБ)'));
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Файл тым үлкен (ең көбі 20 МБ)'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson(req) {
  const buf = await readBody(req, 100 * 1024);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Қате сұраныс');
  }
}

export function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* битая кука — пропускаем */
    }
  }
  return out;
}

export function isHttps(req) {
  return req.headers['x-forwarded-proto'] === 'https' || Boolean(req.socket.encrypted);
}

export function cookie(req, name, value, { maxAge, sameSite = 'Lax' } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=${sameSite}`;
  if (maxAge !== undefined) c += `; Max-Age=${maxAge}`;
  if (isHttps(req)) c += '; Secure';
  return c;
}

// IP клиента. На Render запросы идут через прокси (Cloudflare), поэтому
// берём заголовок, который выставляет сам прокси, а не клиент.
export function clientIp(req) {
  if (config.isPublic) {
    const h = req.headers['cf-connecting-ip'] || req.headers['true-client-ip'];
    if (h) return String(h).trim();
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

export function isLoopback(req) {
  const a = req.socket.remoteAddress || '';
  return !req.headers['x-forwarded-for'] && (a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1');
}

// ---------- Коды классов ----------
const LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // без I, L, O
const DIGITS = '23456789'; // без 0 и 1
const LOOKALIKE = {
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X', У: 'Y',
  Ү: 'Y', Ұ: 'Y', Қ: 'K', І: 'I',
};

export function generateCode() {
  const pick = (s) => s[crypto.randomInt(s.length)];
  return pick(LETTERS) + pick(LETTERS) + pick(LETTERS) + pick(DIGITS) + pick(DIGITS);
}

export function normalizeCode(raw) {
  return String(raw || '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[А-ЯЁӘҒҚҢӨҰҮҺІ]/g, (ch) => LOOKALIKE[ch] || ch);
}

export function validManualCode(code) {
  return /^[A-Z0-9]{5,6}$/.test(code);
}

// ---------- Файлы ----------
export const FILE_TYPES = {
  pdf: { mime: 'application/pdf', kind: 'doc', inline: true },
  doc: { mime: 'application/msword', kind: 'doc' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'doc' },
  odt: { mime: 'application/vnd.oasis.opendocument.text', kind: 'doc' },
  rtf: { mime: 'application/rtf', kind: 'doc' },
  ppt: { mime: 'application/vnd.ms-powerpoint', kind: 'pres' },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', kind: 'pres' },
  ppsx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.slideshow', kind: 'pres' },
  odp: { mime: 'application/vnd.oasis.opendocument.presentation', kind: 'pres' },
};

export function fileExt(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

export function cleanFileName(name) {
  let n = String(name || '').normalize('NFC');
  n = n.split(/[\\/]/).pop();
  n = n.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '_').trim();
  return n.slice(-150) || 'file';
}

// Content-Disposition, который правильно передаёт казахские имена (RFC 6266/5987).
const TRANSLIT = {
  а: 'a', ә: 'a', б: 'b', в: 'v', г: 'g', ғ: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i', к: 'k',
  қ: 'q', л: 'l', м: 'm', н: 'n', ң: 'n', о: 'o', ө: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ұ: 'u', ү: 'u',
  ф: 'f', х: 'h', һ: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sh', ъ: '', ы: 'y', і: 'i', ь: '', э: 'e', ю: 'iu', я: 'ia',
  '№': 'N',
};

export function contentDisposition(type, filename) {
  // запасное имя латиницей — для очень старых браузеров; современные берут filename*
  const ascii = filename
    .replace(/[Ѐ-ӿ№]/g, (ch) => {
      const t = TRANSLIT[ch.toLowerCase()] ?? '_';
      return ch === ch.toLowerCase() ? t : t.charAt(0).toUpperCase() + t.slice(1);
    })
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// ---------- Ссылки ----------
export function safeHttpUrl(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function youtubeId(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    const host = u.hostname.replace(/^(www\.|m\.|music\.)/, '');
    let id = null;
    if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (u.pathname === '/watch') id = u.searchParams.get('v');
      else {
        const m = /^\/(embed|shorts|live|v)\/([^/?#]+)/.exec(u.pathname);
        if (m) id = m[2];
      }
    }
    return id && /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function todayISO() {
  // en-CA даёт формат YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.timeZone }).format(new Date());
}

export function validDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

export function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

export function baseUrl(req) {
  if (config.publicUrl) return config.publicUrl;
  const proto = isHttps(req) ? 'https' : 'http';
  let host = String(req.headers['x-forwarded-host'] || req.headers.host || `localhost:${config.port}`);
  // Учитель открыл сайт как localhost — для QR нужен адрес в школьной сети.
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host)) {
    const lan = lanAddress();
    if (lan) host = host.replace(/^(localhost|127\.0\.0\.1|\[::1\])/, lan);
  }
  return `${proto}://${host}`;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
