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

// quiz — объект ключа ({ answers, ent? }) или просто массив ответов
export function grade(answers, quiz) {
  const key = Array.isArray(quiz) ? quiz : quiz.answers;
  if (!Array.isArray(quiz) && quiz.ent) {
    const pts = key.map((k, i) => entPoints(answers[i], k));
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
