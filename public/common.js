// Общие функции для страниц ученика и учителя.
const KINDS = {
  doc: { name: 'PDF·Word', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>' },
  pres: { name: 'Презентация', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v4M8 20h8M8 12V9M12 12V7M16 12v-2"/></svg>' },
  video: { name: 'Видео', icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>' },
  link: { name: 'Сілтеме', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/></svg>' },
};

const MONTHS = ['қаңтар', 'ақпан', 'наурыз', 'сәуір', 'мамыр', 'маусым', 'шілде', 'тамыз', 'қыркүйек', 'қазан', 'қараша', 'желтоқсан'];

function fmtDate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  if (!y) return '';
  const nowY = new Date().getFullYear();
  return `${d} ${MONTHS[m - 1]}${y !== nowY ? ' ' + y : ''}`;
}

function fmtSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' КБ';
  return (bytes / 1048576).toFixed(1).replace('.', ',') + ' МБ';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const opts = { method, headers: { 'X-Req': '1', ...headers }, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw Object.assign(new Error('Интернет байланысы жоқ'), { status: 0 });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Қате'), { status: res.status, data });
  return data;
}

let toastTimer;
function toast(text, isError = false) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
  }
  // поверх открытого окна (dialog в «верхнем слое» перекрывает всё остальное)
  const host = [...document.querySelectorAll('dialog[open]')].pop() || document.body;
  if (el.parentNode !== host) host.appendChild(el);
  el.textContent = text;
  el.classList.toggle('err', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

// Подтверждение «Растау?» — возвращает Promise<boolean>
function confirmBox(text, okLabel = 'Иә, жою') {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.innerHTML = `<div class="modal confirm"><div class="big-emoji">⚠️</div><h2>Растау?</h2><p>${esc(text)}</p>
      <div class="row"><button class="btn btn-light" value="no">Жоқ</button><button class="btn btn-coral" value="yes">${esc(okLabel)}</button></div></div>`;
    document.body.appendChild(dlg);
    const done = (v) => {
      dlg.close();
      dlg.remove();
      resolve(v);
    };
    dlg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => done(b.value === 'yes')));
    dlg.addEventListener('cancel', () => done(false));
    dlg.showModal();
    dlg.querySelector('[value=no]').focus();
  });
}

// ---------- Приложение (PWA) ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// Плашка «Орнату»: Android/компьютер — системное окно установки, iPhone — подсказка.
function initInstall(container) {
  if (isStandalone()) return;
  let until = 0;
  try { until = Number(localStorage.getItem('installHiddenUntil')) || 0; } catch {}
  if (Date.now() < until) return;
  let deferred = null;

  const bar = document.createElement('div');
  bar.className = 'install-bar';
  bar.hidden = true;
  bar.innerHTML = `<img src="/icons/icon-192.png" alt="" width="44" height="44">
    <div class="ib-text"><b>Қолданба</b><small>Телефонға орнатыңыз</small></div>
    <button class="btn btn-green btn-sm" type="button" data-ib="go">Орнату</button>
    <button class="ib-x" type="button" data-ib="x" aria-label="Жабу">✕</button>`;
  container.prepend(bar);

  bar.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-ib]');
    if (!b) return;
    if (b.dataset.ib === 'x') {
      bar.hidden = true;
      try { localStorage.setItem('installHiddenUntil', String(Date.now() + 14 * 86400_000)); } catch {}
      return;
    }
    if (deferred) {
      deferred.prompt();
      const { outcome } = await deferred.userChoice;
      deferred = null;
      if (outcome === 'accepted') bar.hidden = true;
    } else if (isIOS()) {
      iosHelp();
    }
  });

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    bar.hidden = false;
  });
  window.addEventListener('appinstalled', () => (bar.hidden = true));
  if (isIOS()) bar.hidden = false;
}

function iosHelp() {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `<div class="modal confirm ios-help">
    <img src="/icons/icon-192.png" alt="" width="72" height="72">
    <h2>iPhone-ға орнату</h2>
    <ol>
      <li>Safari-дің төменгі жағындағы <b>«Бөлісу»</b> батырмасын басыңыз <span class="ios-share" aria-hidden="true">⬆︎</span></li>
      <li>Тізімнен <b>«Экранға қосу»</b> («На экран „Домой“») таңдаңыз</li>
      <li>Жоғарғы оң жақтағы <b>«Қосу»</b> батырмасын басыңыз</li>
    </ol>
    <p class="hint">Қолданбада сынып кодын бір рет қайта енгізу керек болуы мүмкін.</p>
    <div class="row"><button class="btn btn-green" type="button">Түсінікті</button></div></div>`;
  document.body.appendChild(dlg);
  dlg.querySelector('button').addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
}

// ---------- Математическая запись ----------
// «3/4» → дробь «три над четыре», «x^2» → x². Учитель пишет обычным текстом, ученик видит как в учебнике.
const FRAC_PART = String.raw`(?:−|-)?(?:\d+(?:[.,]\d+)?|[a-zA-Zа-яА-ЯәіңғүұқөһӘІҢҒҮҰҚӨҺ]\w{0,2}|\([^()]{1,24}\))`;
const FRAC_RE = new RegExp(`(${FRAC_PART})\\/(${FRAC_PART})`, 'g');
function mathHtml(text) {
  const strip = (p) => (p.startsWith('(') && p.endsWith(')') ? p.slice(1, -1) : p);
  return esc(text)
    .replace(/\^(\(([^()]{1,24})\)|−?-?[\w.]{1,6})/g, (_, all, inner) => `<sup>${inner ?? all}</sup>`)
    .replace(FRAC_RE, (_, a, b) => `<span class="frac" role="math" aria-label="${a} бөлу ${b}"><span>${strip(a)}</span><span>${strip(b)}</span></span>`);
}
