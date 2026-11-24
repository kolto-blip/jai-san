// Проверка ответов по ключу с учётом математической записи.
//  3,5 = 3.5 = 7/2 ;  −3 = -3 ;  x = 5  = 5 ;  «2; -3» = «-3; 2» (корни в любом порядке)
//  В ключе несколько допустимых вариантов пишутся через «|»:  0,5 | 1/2

function clean(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[−–—‒]/g, '-')
    .replace(/[×·∙]/g, '*')
    .replace(/:/g, '/')
    .replace(/\s+/g, '')
    .replace(/^[a-zа-яәғқңөұүһі]\d?=/i, '') // «x=5», «x1=2»
    .replace(/,(?=\d)/g, '.');
}

function toNumber(s) {
  if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s)) return Number(s);
  const f = /^([-+]?(?:\d+\.?\d*|\.\d+))\/([-+]?(?:\d+\.?\d*|\.\d+))$/.exec(s);
  if (f && Number(f[2]) !== 0) return Number(f[1]) / Number(f[2]);
  return null;
}

function sameValue(a, b) {
  const na = toNumber(a);
  const nb = toNumber(b);
  if (na !== null && nb !== null) return Math.abs(na - nb) <= 1e-9 * Math.max(1, Math.abs(nb));
  return a === b;
}

function sortKey(s) {
  const n = toNumber(s);
  return n === null ? '1' + s : '0' + String(n + 1e12).padStart(30, '0');
}

function matchOne(given, expected) {
  const g = clean(given);
  const e = clean(expected);
  if (!g || !e) return false;
  if (e.includes(';')) {
    const gs = g.split(';').filter(Boolean).sort((x, y) => (sortKey(x) < sortKey(y) ? -1 : 1));
    const es = e.split(';').filter(Boolean).sort((x, y) => (sortKey(x) < sortKey(y) ? -1 : 1));
    return gs.length === es.length && es.every((x, i) => sameValue(gs[i], x));
  }
  return sameValue(g, e);
}

export function isCorrect(given, key) {
  return String(key ?? '')
    .split('|')
    .some((alt) => matchOne(given, alt));
}

// Буквы ответа ЕНТ: «a c», «А,С» (кириллица), «CA» → «AC»
const CYR = { А: 'A', В: 'B', С: 'C', Е: 'E', Н: 'H', К: 'K', М: 'M', О: 'O', Р: 'P', Т: 'T', Х: 'X' };
export function entLetters(s) {
  const up = String(s ?? '').toUpperCase().replace(/[АВСЕНКМОРТХ]/g, (c) => CYR[c]);
  return [...new Set(up.replace(/[^A-H]/g, ''))].sort().join('');
}

// Баллы ЕНТ за вопрос: один правильный ответ — 1 балл;
// несколько правильных — 2 балла за всё верно, 1 балл за одну ошибку (лишняя или пропущенная буква).
export function entPoints(given, key) {
  const g = entLetters(given);
  const k = entLetters(key);
  if (k.length <= 1) return { points: g === k && g !== '' ? 1 : 0, max: 1 };
  if (!g) return { points: 0, max: 2 };
  const gs = new Set(g);
  const ks = new Set(k);
  let diff = 0;
  for (const c of gs) if (!ks.has(c)) diff++;
  for (const c of ks) if (!gs.has(c)) diff++;
  return { points: diff === 0 ? 2 : diff === 1 ? 1 : 0, max: 2 };
}

// Формат ЕНТ «бейіндік математика»: 40 вопросов, 50 баллов
export const PROFILE_TYPES = Array.from({ length: 40 }, (_, i) => (i < 25 ? 'one' : i < 30 ? 'ctx' : i < 35 ? 'match' : 'many'));
export const TYPE_LETTERS = { one: 4, ctx: 4, match: 4, many: 6 };

// Сәйкестендіру: «B,D» / «BD» / «1-B 2-D» → «B,D» (порядок важен: 1→B, 2→D)
export function matchPairs(s) {
  const up = String(s ?? '').toUpperCase().replace(/[АВСЕ]/g, (c) => CYR[c]);
  const parts = up.includes(',') ? up.split(',') : [...up.replace(/[^A-H]/g, '')];
  return parts.map((p) => (p.match(/[A-H]/) || [''])[0]).slice(0, 2);
}

function typedPoints(given, key, type) {
  if (type === 'match') {
    const g = matchPairs(given);
    const k = matchPairs(key);
    return { points: k.filter((c, i) => c && g[i] === c).length, max: 2 };
  }
  if (type === 'many') {
    const r = entPoints(given, key);
    return { points: r.max === 2 ? r.points : r.points * 2, max: 2 }; // в этом разделе всегда 2 балла
  }
  const g = entLetters(given);
  return { points: g.length === 1 && g === entLetters(key) ? 1 : 0, max: 1 };
}

// quiz — объект ключа ({ answers, ent? }) или просто массив ответов
export function grade(answers, quiz) {
  const key = Array.isArray(quiz) ? quiz : quiz.answers;
  if (!Array.isArray(quiz) && quiz.ent) {
    const types = quiz.ent.types;
    const pts = key.map((k, i) => (types ? typedPoints(answers[i], k, types[i]) : entPoints(answers[i], k)));
    return {
      marks: pts.map((p) => p.points === p.max),
      points: pts.map((p) => p.points),
      score: pts.reduce((x, p) => x + p.points, 0),
      total: pts.reduce((x, p) => x + p.max, 0),
    };
  }
  const marks = key.map((k, i) => isCorrect(answers[i], k));
  return { marks, score: marks.filter(Boolean).length, total: key.length };
}

// «Аты-жөні» для сравнения: без лишних пробелов и регистра
export function nameKey(name) {
  return String(name).normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('kk');
}
