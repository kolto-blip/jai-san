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
