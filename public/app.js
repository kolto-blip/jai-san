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
  for (const s of ['join', 'who', 'pin', 'main', 'ent', 'loading']) $('#' + s).hidden = s !== id;
  document.body.classList.toggle('ent-mode', id === 'ent'); // во время теста — ничего лишнего
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
    if (e.status === 0 && (await showOffline())) return; // нет интернета — сохранённые материалы
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
        await offline.clear();
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
  await offline.clear(); // общий телефон: сохранённые файлы класса не оставляем
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
  state.offline = false;
  $('#offline-note').hidden = true;
  $('#leave').hidden = false;
  show('main');
  renderList();
  if (!data.preview) offline.remember(data);
  offline.refresh();
}

function renderList() {
  const q = state.q.toLocaleLowerCase('kk');
  const isEnt = (m) => Boolean(m.quiz?.ent);
  const items = state.materials.filter(
    (m) => (state.kind === 'all' || (state.kind === 'ent' ? isEnt(m) : m.kind === state.kind && !isEnt(m))) &&
      (!q || m.title.toLocaleLowerCase('kk').includes(q)),
  );
  const list = $('#list');
  if (!items.length) {
    list.innerHTML = `<div class="empty"><div class="big-emoji">${state.materials.length ? '🔍' : '📭'}</div>
      ${state.materials.length ? 'Ештеңе табылмады' : 'Әзірге материал жоқ'}</div>`;
    return;
  }
  // группировка по темам: порядок — по самому свежему материалу темы
  const groups = new Map();
  const ENT = '🎯 ЕНТ нұсқалары';
  if (items.some(isEnt)) groups.set(ENT, []); // варианты ЕНТ — отдельный раздел сверху
  for (const m of items) {
    const t = isEnt(m) ? ENT : m.topic || 'Басқа';
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(m);
  }
  list.innerHTML = [...groups]
    .map(([topic, ms]) => `<h2 class="topic ${topic === ENT ? 'topic-ent' : ''}">${esc(topic)} <span class="count">${ms.length}</span></h2>
      <div class="grid">${ms.map(card).join('')}</div>`)
    .join('');
}

function card(m) {
  const k = KINDS[m.kind] || KINDS.link;
  let action = '';
  const saved = offline.ids.has(String(m.id));
  if (state.offline && !(m.file && saved)) {
    action = '<span class="need-net">📶 Интернет керек</span>';
  } else if (m.action === 'open') {
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
  return `<article class="card mat" data-kind="${m.kind}" ${m.quiz?.ent ? 'data-ent' : ''}>
    <div class="kicon" aria-hidden="true">${k.icon}</div>
    <div>
      <h3>${esc(m.title)}${m.isNew ? '<span class="badge-new">Жаңа</span>' : ''}</h3>
      <div class="meta"><span class="kind-name">${k.name}</span><span>${esc(m.topic)}</span><span>${fmtDate(m.date)}</span>${extra}</div>
    </div>
    <div class="actions">${action}${m.file && offline.supported ? saveBtn(m, saved) : ''}${state.offline ? '' : quizBlock(m) + hwBlock(m)}</div>
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
  if (m.quiz.ent) return entBlock(m);
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

// ---------- Материалы без интернета ----------
// Файлы сохраняются в кеш браузера на этом телефоне (Cache API); список материалов — в localStorage.
// Сервис-воркер отдаёт сохранённый файл, только когда сети нет; при сети доступ проверяет сервер.
const offline = {
  CACHE: 'offline-files',
  supported: 'caches' in window && window.isSecureContext && 'serviceWorker' in navigator,
  ids: new Set(),
  bytes: 0,
  async refresh() {
    if (!this.supported) return;
    const c = await caches.open(this.CACHE);
    const keys = await c.keys();
    this.ids = new Set(keys.map((r) => new URL(r.url).pathname.split('/')[2]));
    this.bytes = 0;
    for (const m of state.materials) if (m.file && this.ids.has(String(m.id))) this.bytes += m.file.size;
    renderOfflineBar();
    renderList();
  },
  async save(m) {
    const res = await fetch(m.href, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('Файл жүктелмеді');
    await (await caches.open(this.CACHE)).put(m.href, res);
    navigator.storage?.persist?.().catch(() => {}); // просим браузер не удалять сохранённое
  },
  async remove(m) {
    await (await caches.open(this.CACHE)).delete(m.href);
  },
  remember(data) {
    // только то, что нужно для показа списка; ответы и фото не сохраняются
    const list = data.materials.map(({ id, title, topic, kind, date, file, href, action }) => ({ id, title, topic, kind, date, file, href, action }));
    try {
      localStorage.setItem('offlineList', JSON.stringify({ class: data.class, student: data.student, materials: list, at: Date.now() }));
    } catch {}
  },
  load() {
    try { return JSON.parse(localStorage.getItem('offlineList')); } catch { return null; }
  },
  async clear() {
    try { localStorage.removeItem('offlineList'); } catch {}
    if (this.supported) await caches.delete(this.CACHE).catch(() => {});
    this.ids = new Set();
  },
};

function saveBtn(m, saved) {
  if (state.offline) return saved ? '<span class="saved-tag">📥 Телефонда</span>' : '';
  return saved
    ? `<button class="btn btn-icon saved" type="button" data-off="del" data-id="${m.id}" title="Телефоннан өшіру">✅📥</button>`
    : `<button class="btn btn-icon" type="button" data-off="save" data-id="${m.id}" title="Интернетсіз ашу үшін телефонға сақтау">📥</button>`;
}

function renderOfflineBar() {
  const bar = $('#offline-bar');
  const files = state.materials.filter((m) => m.file);
  if (!offline.supported || state.offline || !files.length) return (bar.hidden = true);
  const n = files.filter((m) => offline.ids.has(String(m.id))).length;
  bar.hidden = false;
  bar.innerHTML = `<span>📥 Интернетсіз ашу үшін: <b>${n}/${files.length}</b> файл сақталған${n ? ` · ${fmtSize(offline.bytes)}` : ''}</span>
    ${n < files.length ? '<button class="btn btn-blue btn-sm" type="button" data-off="all">Барлығын сақтау</button>' : ''}
    ${n ? '<button class="btn btn-light btn-sm" type="button" data-off="clear">Тазалау</button>' : ''}`;
}

async function showOffline() {
  const snap = offline.load();
  if (!snap) return false;
  state.offline = true;
  state.student = snap.student;
  state.materials = snap.materials;
  if (offline.supported) {
    const keys = await (await caches.open(offline.CACHE)).keys();
    offline.ids = new Set(keys.map((r) => new URL(r.url).pathname.split('/')[2]));
  }
  $('#cls-name').textContent = snap.class.name;
  $('#cls-count').textContent = `${snap.student ? `👤 ${snap.student.name} · ` : ''}${snap.materials.length} материал`;
  $('#leave').hidden = true;
  $('#preview').hidden = true;
  $('#offline-bar').hidden = true;
  const at = new Date(snap.at);
  $('#offline-note').innerHTML = `📴 Интернет жоқ. Тізім ${at.getDate()} ${MONTHS[at.getMonth()]}, ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')} күйінде.
    Телефонға сақталған файлдар ашылады. <button class="btn btn-light btn-sm" type="button" id="offline-retry">🔄 Қайталау</button>`;
  $('#offline-note').hidden = false;
  $('#offline-retry').addEventListener('click', () => location.reload());
  show('main');
  renderList();
  return true;
}
window.addEventListener('online', () => state.offline && location.reload());

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-off]');
  if (!b) return;
  const act = b.dataset.off;
  const files = state.materials.filter((m) => m.file);
  try {
    if (act === 'save' || act === 'del') {
      const m = state.materials.find((x) => String(x.id) === b.dataset.id);
      b.disabled = true;
      if (act === 'save') {
        b.textContent = '⏳';
        await offline.save(m);
        toast('Сақталды — енді интернетсіз де ашылады');
      } else await offline.remove(m);
    } else if (act === 'all') {
      const todo = files.filter((m) => !offline.ids.has(String(m.id)));
      b.disabled = true;
      for (let i = 0; i < todo.length; i++) {
        b.textContent = `⏳ ${i + 1}/${todo.length}`;
        await offline.save(todo[i]);
      }
      toast(`Сақталды: ${todo.length} файл`);
    } else if (act === 'clear') {
      if (!(await confirmBox('Телефонға сақталған барлық файлдар өшіріледі. Интернет болса, қайта сақтауға болады.', 'Иә, өшіру'))) return;
      await caches.delete(offline.CACHE);
    }
  } catch (err) {
    toast(err.status === 0 || err instanceof TypeError ? 'Интернет жоқ — кейін сақтаңыз' : err.message, true);
  }
  await offline.refresh();
});

// ---------- ЕНТ нұсқалары ----------
const LETTERS = 'ABCDEFGH';
const E = { mat: null, ans: [], timer: null, end: 0 };
const entKey = (m, k) => `ent:${m.id}:${state.student?.name || ''}:${k}`;

function entBlock(m) {
  const e = m.quiz.ent;
  const done = state.student ? m.quiz.done : local.get('quiz:' + m.id);
  const running = local.get(entKey(m, 'end'));
  const info = `<div class="ent-info"><span>${esc(e.subject)}</span><span>${m.quiz.count} сұрақ</span>${e.minutes ? `<span>⏱ ${e.minutes} мин</span>` : ''}
    ${done ? `<span class="best">Нәтиже: ${done.score}/${done.total} балл</span>` : ''}</div>`;
  if (!m.quiz.open) return info + '<div class="quiz-done">🔒 Жабық</div>';
  if (running && running > Date.now()) return info + `<button class="btn btn-ent" type="button" data-ent="${m.id}">▶ Жалғастыру</button>`;
  if (done && !m.quiz.retry) return info;
  return info + `<button class="btn btn-ent" type="button" data-ent="${m.id}">${done ? '🔁 Қайта тапсыру' : '▶ Бастау'}</button>`;
}

$('#list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-ent]');
  if (b && b.tagName === 'BUTTON') openEnt(state.materials.find((x) => String(x.id) === b.dataset.ent));
});

function openEnt(m) {
  E.mat = m;
  const e = m.quiz.ent;
  // продолжение начатой попытки (после перезагрузки страницы)
  let end = local.get(entKey(m, 'end'));
  if (!end || end <= Date.now()) {
    end = e.minutes ? Date.now() + e.minutes * 60_000 : Number.MAX_SAFE_INTEGER; // без таймера
    local.set(entKey(m, 'end'), end);
    local.set(entKey(m, 'ans'), []);
  }
  E.end = end;
  E.ans = local.get(entKey(m, 'ans')) || [];
  $('#ent-title').textContent = m.title;
  $('#ent-sub').textContent = `${e.subject} · ${m.quiz.count} сұрақ${e.minutes ? ` · ${e.minutes} минут` : ''}`;
  $('#ent-pdf').hidden = !m.href;
  if (m.href) $('#ent-pdf').href = m.href;
  $('#ent-name').value = state.student ? state.student.name : local.get('studentName') || '';
  $('#ent-name').hidden = $('#ent-name-label').hidden = Boolean(state.student);
  $('#ent-error').textContent = '';
  renderSheet();
  $('#ent-body').hidden = false;
  $('#ent-result').hidden = true;
  $('#ent-finish').hidden = false;
  show('ent');
  scrollTo(0, 0);
  clearInterval(E.timer);
  $('#ent-timer').classList.remove('low', 'crit');
  if (e.minutes) {
    tick();
    E.timer = setInterval(tick, 1000);
  } else {
    $('#ent-timer').textContent = '🎯 ЕНТ';
  }
}

function renderSheet() {
  const e = E.mat.quiz.ent;
  $('#ent-sheet').innerHTML = Array.from({ length: E.mat.quiz.count }, (_, i) => {
    const a = E.ans[i] || '';
    return `<div class="ent-row ${a ? 'done' : ''}" data-q="${i}"><span class="ent-no">${i + 1}.</span>
      ${[...LETTERS.slice(0, e.letters)].map((L) => `<button class="bub" type="button" data-l="${L}" aria-pressed="${a.includes(L)}" aria-label="${i + 1}-сұрақ, ${L}">${L}</button>`).join('')}
      ${e.multi[i] ? '<span class="ent-multi">бірнеше жауап</span>' : ''}</div>`;
  }).join('');
}

$('#ent-sheet').addEventListener('click', (e) => {
  const b = e.target.closest('.bub');
  if (!b) return;
  const i = Number(b.closest('[data-q]').dataset.q);
  const multi = E.mat.quiz.ent.multi[i];
  let a = E.ans[i] || '';
  const L = b.dataset.l;
  if (multi) a = a.includes(L) ? a.replace(L, '') : [...a + L].sort().join('');
  else a = a === L ? '' : L;
  E.ans[i] = a;
  local.set(entKey(E.mat, 'ans'), E.ans);
  const row = b.closest('[data-q]');
  row.classList.toggle('done', Boolean(a));
  row.querySelectorAll('.bub').forEach((x) => x.setAttribute('aria-pressed', String(a.includes(x.dataset.l))));
});

function tick() {
  const left = Math.max(0, Math.round((E.end - Date.now()) / 1000));
  const el = $('#ent-timer');
  el.textContent = `⏱ ${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
  el.classList.toggle('low', left <= 300 && left > 60);
  el.classList.toggle('crit', left <= 60);
  if (left === 0) {
    clearInterval(E.timer);
    submitEnt(true);
  }
}

$('#ent-back').addEventListener('click', () => {
  clearInterval(E.timer);
  toast(E.mat.quiz.ent.minutes ? 'Уақыт жүріп жатыр — «Жалғастыру» басып оралыңыз' : 'Жауаптар сақталды — «Жалғастыру» басып оралыңыз');
  show('main');
  renderList();
});
// имя сохраняем сразу: попытку могут продолжить после перезагрузки
$('#ent-name').addEventListener('input', (e) => local.set('studentName', e.target.value.trim()));
$('#ent-finish').addEventListener('click', () => submitEnt(false));
$('#ent-submit').addEventListener('click', () => submitEnt(false));

async function submitEnt(auto) {
  const m = E.mat;
  const name = $('#ent-name').value.trim();
  const err = $('#ent-error');
  if (!state.student && name.length < 2) {
    err.textContent = 'Аты-жөніңізді жазыңыз';
    $('#ent-name').focus();
    if (auto) {
      // время вышло, а имени нет — ждём имя, ответы не теряем
      toast('Уақыт бітті. Атыңызды жазып, «Аяқтау» басыңыз.', true);
    }
    return;
  }
  const answers = Array.from({ length: m.quiz.count }, (_, i) => E.ans[i] || '');
  const empty = answers.filter((a) => !a).length;
  if (!auto && empty && !(await confirmBox(`${empty} сұраққа жауап белгіленбеді. Аяқтайсыз ба?`, 'Иә, аяқтау'))) return;
  if (!auto && !empty && !(await confirmBox('Жауаптарды жіберіп, тестті аяқтайсыз ба?', 'Иә, аяқтау'))) return;
  if (answers.every((a) => !a)) answers[0] = '-'; // пустой бланк тоже засчитываем (0 баллов)
  try {
    const r = await api(`/api/quiz/${m.id}`, { method: 'POST', body: { name, answers } });
    clearInterval(E.timer);
    local.set(entKey(m, 'end'), 0);
    if (!state.student) {
      local.set('studentName', name);
      local.set('quiz:' + m.id, { score: r.score, total: r.total });
    } else m.quiz.done = { score: r.score, total: r.total };
    showEntResult(r, answers, auto);
  } catch (e2) {
    if (e2.data?.needLogin) return showWho('Қайта кіріңіз: атыңызды таңдап, PIN енгізіңіз.');
    err.textContent = e2.message;
    if (auto) toast(e2.message, true);
  }
}

function showEntResult(r, answers, auto) {
  const pct = Math.round((r.score / r.total) * 100);
  const cls = pct >= 80 ? '' : pct >= 50 ? 'mid' : 'low';
  $('#ent-result').innerHTML = `<div class="quiz-score">${auto ? '<div class="hint">⏱ Уақыт бітті — жауаптар жіберілді</div>' : ''}
      <div class="big ${cls}">${r.score}/${r.total}</div><div><b>балл · ${pct}%</b></div></div>
    <div class="ent-sheet">${answers.map((a, i) => {
      const p = r.points[i];
      const max = E.mat.quiz.ent.multi[i] ? 2 : 1;
      const c = p === max ? '' : p > 0 ? 'half' : 'bad';
      return `<div class="ent-res-row ${c}"><span>${i + 1}.</span>
        <span><small>Сіз</small>${esc(a.replace('-', '') || '—')}</span>
        <span>${r.correct ? `<small>Дұрысы</small>${esc(r.correct[i])}` : ''}</span>
        <span class="pts">${p === max ? '✅' : p > 0 ? '🟡' : '❌'} ${p}/${max}</span></div>`;
    }).join('')}</div>
    <button class="btn btn-light btn-block" type="button" id="ent-done">Материалдарға оралу</button>`;
  $('#ent-body').hidden = true;
  $('#ent-finish').hidden = true;
  $('#ent-result').hidden = false;
  $('#ent-timer').textContent = '🎯 Нәтиже';
  $('#ent-timer').classList.remove('low', 'crit');
  scrollTo(0, 0);
  $('#ent-done').addEventListener('click', () => {
    show('main');
    renderList();
  });
}

initInstall(document.querySelector('.wrap'));
load();
