// Страница ученика
const $ = (s) => document.querySelector(s);
const STORE_KEY = 'classCode';
const state = { materials: [], kind: 'all', q: '' };

const store = {
  get() { try { return localStorage.getItem(STORE_KEY) || ''; } catch { return ''; } },
  set(v) { try { localStorage.setItem(STORE_KEY, v); } catch {} },
  clear() { try { localStorage.removeItem(STORE_KEY); } catch {} },
};

function show(id) {
  for (const s of ['join', 'who', 'pin', 'main', 'loading']) $('#' + s).hidden = s !== id;
}

async function join(code) {
  const data = await api('/api/join', { method: 'POST', body: { code } });
  store.set(data.code);
  return data;
}

// Открыть материалы класса; если у класса есть список учеников — сначала выбор имени и PIN.
async function openClass() {
  try {
    render(await api('/api/materials'));
  } catch (e) {
    if (e.data?.needLogin) return showWho();
    throw e;
  }
}

async function load() {
  // 1) код из QR-ссылки (?k=KUN47)
  const params = new URLSearchParams(location.search);
  const k = params.get('k');
  if (k) {
    history.replaceState(null, '', location.pathname);
    try {
      await join(k);
    } catch (e) {
      return showJoin(e.status === 429 ? e.message : 'QR-кодтағы сынып коды табылмады.');
    }
  }
  // 2) кука на сервере; 3) запасной вариант — код в памяти телефона
  try {
    return await openClass();
  } catch (e) {
    if (e.status !== 401) return showJoin(e.message);
  }
  const saved = store.get();
  if (saved) {
    try {
      await join(saved);
      return await openClass();
    } catch (e) {
      if (e.status === 404) {
        store.clear();
        return showJoin('Сынып коды өзгерген. Жаңа кодты мұғаліміңізден сұраңыз.');
      }
      return showJoin(e.message);
    }
  }
  showJoin('');
}

function showJoin(msg) {
  show('join');
  $('#join-error').textContent = msg || '';
  $('#code').focus();
}

$('#join-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const code = $('#code').value.trim();
  if (!code) return ($('#join-error').textContent = 'Кодты жазыңыз');
  const btn = ev.submitter || $('#join-form button');
  btn.disabled = true;
  try {
    await join(code);
    $('#code').value = '';
    await openClass();
  } catch (e) {
    $('#join-error').textContent = e.message;
  } finally {
    btn.disabled = false;
  }
});

async function leave() {
  store.clear();
  await api('/api/leave', { method: 'POST' }).catch(() => {});
  showJoin('');
}
$('#leave').addEventListener('click', leave);
$('#who-leave').addEventListener('click', leave);

// ---------- Кто ты? (вход ученика) ----------
let roster = [];
let picked = null;

async function showWho(msg = '') {
  const data = await api('/api/roster');
  roster = data.students;
  $('#who-cls').textContent = data.class.name;
  $('#who-search').value = '';
  $('#who-msg').textContent = msg;
  renderWho();
  show('who');
}

function renderWho() {
  const q = $('#who-search').value.trim().toLocaleLowerCase('kk');
  const items = roster.filter((x) => !q || x.name.toLocaleLowerCase('kk').includes(q));
  $('#who-list').innerHTML = items.length
    ? items.map((x) => `<button class="who" type="button" data-id="${x.id}">
        <span class="who-av" aria-hidden="true">${esc(x.name.charAt(0))}</span>
        <span class="who-name">${esc(x.name)}</span>
        <span class="who-st">${x.registered ? '🔒' : '<span class="badge-new">Жаңа</span>'}</span></button>`).join('')
    : '<div class="empty">Табылмады</div>';
}
$('#who-search').addEventListener('input', renderWho);
$('#who-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-id]');
  if (b) showPin(roster.find((x) => String(x.id) === b.dataset.id));
});

function showPin(st) {
  picked = st;
  $('#pin-name').textContent = st.name;
  $('#pin1').value = '';
  $('#pin2').value = '';
  $('#pin-error').textContent = '';
  const first = !st.registered;
  $('#pin-hint').textContent = first
    ? 'Бірінші рет кіріп тұрсыз. 4 саннан тұратын PIN ойлап табыңыз. Оны ұмытпаңыз және ешкімге айтпаңыз!'
    : 'PIN-іңізді енгізіңіз.';
  $('#pin1-label').textContent = first ? 'Жаңа PIN' : 'PIN';
  $('#pin2-wrap').hidden = !first;
  $('#pin-submit').textContent = first ? 'Тіркелу ✓' : 'Кіру';
  show('pin');
  $('#pin1').focus();
}
$('#pin-back').addEventListener('click', () => showWho());

// только цифры, не больше 4
for (const id of ['#pin1', '#pin2']) {
  $(id).addEventListener('input', (e) => (e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4)));
}

$('#pin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pin = $('#pin1').value;
  const err = $('#pin-error');
  if (!/^\d{4}$/.test(pin)) return (err.textContent = 'PIN — 4 сан');
  if (!picked.registered && pin !== $('#pin2').value) return (err.textContent = 'PIN-дер сәйкес емес');
  const btn = $('#pin-submit');
  btn.disabled = true;
  try {
    await api('/api/student/login', { method: 'POST', body: { id: picked.id, pin } });
    await openClass();
  } catch (e2) {
    if (e2.status === 409) return showWho(e2.message);
    err.textContent = e2.message;
    $('#pin1').select();
  } finally {
    btn.disabled = false;
  }
});

function render(data) {
  state.materials = data.materials;
  state.student = data.student;
  $('#cls-name').textContent = data.class.name;
  document.title = `${data.class.name} — Математика`;
  const who = data.student ? `👤 ${data.student.name} · ` : '';
  $('#cls-count').textContent = `${who}${data.materials.length} материал`;
  $('#leave').textContent = data.student ? 'Шығу' : 'Сыныпты ауыстыру';
  $('#preview').hidden = !data.preview;
  show('main');
  renderList();
}

function renderList() {
  const q = state.q.toLocaleLowerCase('kk');
  const items = state.materials.filter(
    (m) => (state.kind === 'all' || m.kind === state.kind) && (!q || m.title.toLocaleLowerCase('kk').includes(q)),
  );
  const list = $('#list');
  if (!items.length) {
    list.innerHTML = `<div class="empty"><div class="big-emoji">${state.materials.length ? '🔍' : '📭'}</div>
      ${state.materials.length ? 'Ештеңе табылмады' : 'Әзірге материал жоқ'}</div>`;
    return;
  }
  // группировка по темам: порядок — по самому свежему материалу темы
  const groups = new Map();
  for (const m of items) {
    const t = m.topic || 'Басқа';
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(m);
  }
  list.innerHTML = [...groups]
    .map(([topic, ms]) => `<h2 class="topic">${esc(topic)} <span class="count">${ms.length}</span></h2>
      <div class="grid">${ms.map(card).join('')}</div>`)
    .join('');
}

function card(m) {
  const k = KINDS[m.kind] || KINDS.link;
  let action = '';
  if (m.action === 'open') {
    action = `<a class="btn" href="${m.href}" target="_blank" rel="noopener">Ашу</a>
              <a class="btn btn-icon" href="${m.href}?dl=1" aria-label="Жүктеу">⬇</a>`;
  } else if (m.action === 'download') {
    action = `<a class="btn" href="${m.href}" download>Жүктеу ⬇</a>`;
  } else if (m.action === 'play') {
    action = `<button class="btn" type="button" data-play="${m.id}">▶ Көру</button>`;
  } else {
    action = `<a class="btn" href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">Ашу ↗</a>`;
  }
  const extra = m.file ? `<span>${esc(m.file.ext.toUpperCase())} · ${fmtSize(m.file.size)}</span>` : '';
  return `<article class="card mat" data-kind="${m.kind}">
    <div class="kicon" aria-hidden="true">${k.icon}</div>
    <div>
      <h3>${esc(m.title)}${m.isNew ? '<span class="badge-new">Жаңа</span>' : ''}</h3>
      <div class="meta"><span class="kind-name">${k.name}</span><span>${esc(m.topic)}</span><span>${fmtDate(m.date)}</span>${extra}</div>
    </div>
    <div class="actions">${action}${quizBlock(m)}${hwBlock(m)}</div>
  </article>`;
}

document.querySelectorAll('.chip').forEach((chip) =>
  chip.addEventListener('click', () => {
    state.kind = chip.dataset.kind;
    document.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
    renderList();
  }),
);
$('#search').addEventListener('input', (e) => {
  state.q = e.target.value.trim();
  renderList();
});

// YouTube во всплывающем окне
const dlg = $('#video-dlg');
$('#list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-play]');
  if (!b) return;
  const m = state.materials.find((x) => String(x.id) === b.dataset.play);
  if (!m?.youtubeId) return window.open(m?.url, '_blank', 'noopener');
  $('#video-title').textContent = m.title;
  $('#video-yt').href = m.url;
  $('#video-box').innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(m.youtubeId)}?autoplay=1&rel=0&playsinline=1&origin=${encodeURIComponent(location.origin)}"
    title="${esc(m.title)}" referrerpolicy="strict-origin-when-cross-origin" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`;
  dlg.showModal();
});
const closeVideo = () => {
  $('#video-box').innerHTML = '';
  if (dlg.open) dlg.close();
};
$('#video-close').addEventListener('click', closeVideo);
dlg.addEventListener('close', () => ($('#video-box').innerHTML = ''));
dlg.addEventListener('click', (e) => e.target === dlg && closeVideo());

// ---------- Ответы с автопроверкой ----------
const local = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

function quizBlock(m) {
  if (!m.quiz) return '';
  const done = state.student ? m.quiz.done : local.get('quiz:' + m.id);
  if (done) {
    const again = m.quiz.retry && m.quiz.open ? `<button class="btn btn-light btn-sm" type="button" data-quiz="${m.id}">Қайта</button>` : '';
    return `<div class="quiz-done">✅ Тапсырылды: ${done.score}/${done.total}${again}</div>`;
  }
  if (!m.quiz.open) return '<div class="quiz-done">🔒 Жауап қабылдау жабылды</div>';
  return `<button class="btn btn-quiz" type="button" data-quiz="${m.id}">✏️ Жауап беру · ${m.quiz.count} есеп</button>`;
}

const quizDlg = $('#quiz-dlg');
let quizMat = null;

function openQuiz(m) {
  quizMat = m;
  $('#quiz-title').textContent = m.title;
  $('#quiz-name').value = state.student ? state.student.name : local.get('studentName') || '';
  $('#quiz-name').hidden = $('#quiz-name-label').hidden = Boolean(state.student);
  $('#quiz-inputs').innerHTML = Array.from({ length: m.quiz.count }, (_, i) =>
    `<label class="quiz-item"><span>№${i + 1}</span><input class="quiz-input" data-i="${i}" maxlength="100" inputmode="text" autocapitalize="off" spellcheck="false"></label>`,
  ).join('');
  $('#quiz-error').textContent = '';
  $('#quiz-body').hidden = false;
  $('#quiz-result').hidden = true;
  quizDlg.showModal();
  ($('#quiz-name').value ? $('#quiz-inputs input') : $('#quiz-name')).focus();
}

$('#list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-quiz]');
  if (b) openQuiz(state.materials.find((x) => String(x.id) === b.dataset.quiz));
});
$('#quiz-close').addEventListener('click', () => quizDlg.close());

$('#quiz-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#quiz-name').value.trim();
  const answers = [...document.querySelectorAll('#quiz-inputs input')].map((i) => i.value.trim());
  const err = $('#quiz-error');
  if (name.length < 2) return (err.textContent = 'Аты-жөніңізді жазыңыз'), $('#quiz-name').focus();
  const empty = answers.filter((a) => !a).length;
  if (empty === answers.length) return (err.textContent = 'Жауаптарды жазыңыз');
  if (empty && !(await confirmBox(`${empty} есепке жауап жазылмады. Солай жібере берейін бе?`, 'Иә, жіберу'))) return;
  const btn = $('#quiz-submit');
  btn.disabled = true;
  try {
    const r = await api(`/api/quiz/${quizMat.id}`, { method: 'POST', body: { name, answers } });
    if (!state.student) {
      local.set('studentName', name);
      local.set('quiz:' + quizMat.id, { score: r.score, total: r.total });
    } else quizMat.quiz.done = { score: r.score, total: r.total };
    showQuizResult(r, answers);
    renderList();
  } catch (e2) {
    if (e2.data?.needLogin) {
      quizDlg.close();
      return showWho('Қайта кіріңіз: атыңызды таңдап, PIN енгізіңіз.');
    }
    err.textContent = e2.message;
  } finally {
    btn.disabled = false;
  }
});

function showQuizResult(r, answers) {
  const pct = r.score / r.total;
  const cls = pct >= 0.8 ? '' : pct >= 0.5 ? 'mid' : 'low';
  const praise = pct === 1 ? 'Керемет! Бәрі дұрыс 🎉' : pct >= 0.8 ? 'Жарайсың! 👏' : pct >= 0.5 ? 'Жаман емес, қателерді қара 💪' : 'Тақырыпты қайталап шық 📚';
  $('#quiz-result').innerHTML = `
    <div class="quiz-score"><div class="big ${cls}">${r.score}/${r.total}</div><div><b>${praise}</b></div></div>
    <div class="quiz-marks">${r.marks.map((ok, i) => `<div class="quiz-mark ${ok ? '' : 'bad'}">№${i + 1} ${ok ? '✅' : '❌'}
      <small>Сіз: ${esc(answers[i] || '—')}${!ok && r.correct ? ` · Дұрысы: ${esc(r.correct[i])}` : ''}</small></div>`).join('')}</div>
    <div class="row">${quizMat.quiz.retry ? '<button class="btn btn-blue" type="button" id="quiz-again">Қайта тапсыру</button>' : ''}
      <button class="btn btn-light" type="button" id="quiz-ok">Жабу</button></div>`;
  $('#quiz-body').hidden = true;
  $('#quiz-result').hidden = false;
  $('#quiz-ok').addEventListener('click', () => quizDlg.close());
  $('#quiz-again')?.addEventListener('click', () => openQuiz(quizMat));
}

// ---------- Фото домашней работы ----------
function fmtTime(t) {
  const d = new Date(t);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function hwBlock(m) {
  if (!m.hw) return '';
  const sent = state.student ? m.hw.sent : local.get('hw:' + m.id);
  const again = m.hw.open ? `<button class="btn btn-light btn-sm" type="button" data-hw="${m.id}">Тағы жіберу</button>` : '';
  if (sent) {
    const ch = sent.checked;
    const thumbs = sent.files?.length ? `<div class="hw-mine">${sent.files.map((u) => `<a href="${u}" target="_blank"><img src="${u}" alt="" loading="lazy"></a>`).join('')}</div>` : '';
    return `<div class="hw-status ${ch ? 'checked' : ''}">
      <div class="row">📷 Жіберілді: ${fmtTime(sent.at)} · ${sent.photos} фото${sent.late ? ' <span class="hw-late">· кешігіп</span>' : ''}${again}</div>
      ${thumbs}
      ${ch ? `<div>✅ Тексерілді${ch.grade ? ` · Баға: <b>${esc(ch.grade)}</b>` : ''}</div>${ch.feedback ? `<div class="fb">«${esc(ch.feedback)}»</div>` : ''}` : '<div>⏳ Мұғалім әлі тексерген жоқ</div>'}
    </div>`;
  }
  if (!m.hw.open) return '<div class="quiz-done">🔒 Жұмыс қабылдау жабылды</div>';
  const due = m.hw.due ? ` · ${fmtDate(m.hw.due)} дейін` : '';
  return `<button class="btn btn-hw" type="button" data-hw="${m.id}">📷 Үй жұмысын жіберу${due}</button>`;
}

const hwDlg = $('#hw-dlg');
const hw = { mat: null, photos: [] }; // photos: [{ blob, url }]

function openHw(m) {
  hw.mat = m;
  for (const p of hw.photos) URL.revokeObjectURL(p.url);
  hw.photos = [];
  $('#hw-title').textContent = m.title;
  $('#hw-due').textContent = m.hw.due ? `Тапсыру мерзімі: ${fmtDate(m.hw.due)}` : '';
  $('#hw-name').value = state.student ? state.student.name : local.get('studentName') || '';
  $('#hw-name').hidden = $('#hw-name-label').hidden = Boolean(state.student);
  $('#hw-comment').value = '';
  $('#hw-error').textContent = '';
  $('#hw-body').hidden = false;
  $('#hw-done').hidden = true;
  renderHwPreviews();
  hwDlg.showModal();
}

$('#list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-hw]');
  if (b) openHw(state.materials.find((x) => String(x.id) === b.dataset.hw));
});
$('#hw-close').addEventListener('click', () => hwDlg.close());
$('#hw-pick').addEventListener('click', () => $('#hw-file').click());

// Сжатие на телефоне: длинная сторона до 1600 px, JPEG ~70 % → обычно 150–400 КБ вместо 3–5 МБ.
async function compressPhoto(file) {
  const MAX = 1600;
  let src;
  let w;
  let h;
  try {
    src = await createImageBitmap(file, { imageOrientation: 'from-image' });
    w = src.width;
    h = src.height;
  } catch {
    const url = URL.createObjectURL(file);
    src = new Image();
    src.src = url;
    await src.decode();
    w = src.naturalWidth;
    h = src.naturalHeight;
    URL.revokeObjectURL(url);
  }
  const k = Math.min(1, MAX / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * k);
  canvas.height = Math.round(h * k);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('jpeg'))), 'image/jpeg', 0.72));
}

$('#hw-file').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  const err = $('#hw-error');
  err.textContent = '';
  for (const f of files) {
    if (hw.photos.length >= 6) {
      err.textContent = 'Ең көбі 6 фото';
      break;
    }
    try {
      const blob = await compressPhoto(f);
      hw.photos.push({ blob, url: URL.createObjectURL(blob) });
    } catch {
      err.textContent = `«${f.name}» ашылмады. Камерамен қайта түсіріп көріңіз.`;
    }
  }
  renderHwPreviews();
});

function renderHwPreviews() {
  $('#hw-previews').innerHTML = hw.photos
    .map((p, i) => `<div class="hw-thumb"><img src="${p.url}" alt="Фото ${i + 1}"><button type="button" data-rm="${i}" aria-label="Жою">✕</button></div>`)
    .join('');
  $('#hw-pick').textContent = hw.photos.length ? '➕ Тағы фото қосу' : '📷 Суретке түсіру / таңдау';
  $('#hw-pick').hidden = hw.photos.length >= 6;
}
$('#hw-previews').addEventListener('click', (e) => {
  const b = e.target.closest('[data-rm]');
  if (!b) return;
  const [p] = hw.photos.splice(Number(b.dataset.rm), 1);
  URL.revokeObjectURL(p.url);
  renderHwPreviews();
});

function sendHw(url, blobs, meta) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('X-Req', '1');
    xhr.setRequestHeader('X-Parts', blobs.map((b) => b.size).join(','));
    xhr.setRequestHeader('X-Meta', encodeURIComponent(JSON.stringify(meta)));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    const bar = $('#hw-progress');
    bar.hidden = false;
    xhr.upload.onprogress = (e) => e.lengthComputable && ($('#hw-progress-fill').style.width = (e.loaded / e.total) * 100 + '%');
    xhr.onload = () => {
      bar.hidden = true;
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      xhr.status < 300 ? resolve(data) : reject(Object.assign(new Error(data.error || `Қате (${xhr.status})`), { status: xhr.status, data }));
    };
    xhr.onerror = () => {
      bar.hidden = true;
      reject(new Error('Интернет байланысы жоқ. Қайта жіберіп көріңіз.'));
    };
    xhr.send(new Blob(blobs));
  });
}

$('#hw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#hw-error');
  const name = $('#hw-name').value.trim();
  if (name.length < 2) return (err.textContent = 'Аты-жөніңізді жазыңыз'), $('#hw-name').focus();
  if (!hw.photos.length) return (err.textContent = 'Кем дегенде бір фото қосыңыз');
  const btn = $('#hw-submit');
  btn.disabled = true;
  try {
    const r = await sendHw(`/api/hw/${hw.mat.id}`, hw.photos.map((p) => p.blob), { name, comment: $('#hw-comment').value.trim() });
    if (!state.student) {
      local.set('studentName', name);
      local.set('hw:' + hw.mat.id, { at: r.at, photos: r.photos, late: r.late });
    }
    $('#hw-done').innerHTML = `<div class="quiz-score"><div class="big">📬</div><div><b>Жіберілді! ${r.photos} фото</b></div>
      ${r.late ? '<div class="hw-late">Мерзімнен кешігіп жіберілді</div>' : ''}
      <p class="hint">Мұғалім тексергенде, бағасы осы жерде көрінеді.</p></div>
      <button class="btn btn-light btn-block" type="button" id="hw-ok">Жабу</button>`;
    $('#hw-body').hidden = true;
    $('#hw-done').hidden = false;
    $('#hw-ok').addEventListener('click', () => hwDlg.close());
    if (state.student) await openClass().catch(() => {});
    else renderList();
  } catch (e2) {
    if (e2.data?.needLogin) {
      hwDlg.close();
      return showWho('Қайта кіріңіз: атыңызды таңдап, PIN енгізіңіз.');
    }
    err.textContent = e2.message;
  } finally {
    btn.disabled = false;
  }
});

load();
