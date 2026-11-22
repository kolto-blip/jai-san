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
  for (const s of ['join', 'main', 'loading']) $('#' + s).hidden = s !== id;
}

async function join(code) {
  const data = await api('/api/join', { method: 'POST', body: { code } });
  store.set(data.code);
  return data;
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
    return render(await api('/api/materials'));
  } catch (e) {
    if (e.status !== 401) return showJoin(e.message);
  }
  const saved = store.get();
  if (saved) {
    try {
      await join(saved);
      return render(await api('/api/materials'));
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
    render(await api('/api/materials'));
  } catch (e) {
    $('#join-error').textContent = e.message;
  } finally {
    btn.disabled = false;
  }
});

$('#leave').addEventListener('click', async () => {
  store.clear();
  await api('/api/leave', { method: 'POST' }).catch(() => {});
  showJoin('');
});

function render(data) {
  state.materials = data.materials;
  $('#cls-name').textContent = data.class.name;
  document.title = `${data.class.name} — Математика`;
  $('#cls-count').textContent = `${data.materials.length} материал`;
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
    <div class="actions">${action}${quizBlock(m)}</div>
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
  const done = local.get('quiz:' + m.id);
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
  $('#quiz-name').value = local.get('studentName') || '';
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
  if (name.length < 3) return (err.textContent = 'Аты-жөніңізді жазыңыз'), $('#quiz-name').focus();
  const empty = answers.filter((a) => !a).length;
  if (empty === answers.length) return (err.textContent = 'Жауаптарды жазыңыз');
  if (empty && !(await confirmBox(`${empty} есепке жауап жазылмады. Солай жібере берейін бе?`, 'Иә, жіберу'))) return;
  const btn = $('#quiz-submit');
  btn.disabled = true;
  try {
    const r = await api(`/api/quiz/${quizMat.id}`, { method: 'POST', body: { name, answers } });
    local.set('studentName', name);
    local.set('quiz:' + quizMat.id, { score: r.score, total: r.total });
    showQuizResult(r, answers);
    renderList();
  } catch (e2) {
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

load();
