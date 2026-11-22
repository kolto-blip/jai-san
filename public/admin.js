// Страница учителя
const $ = (s) => document.querySelector(s);
const MAX_MB = 20;
const S = { classes: [], materials: [], usage: null, baseUrl: '', type: 'file', file: null, editing: null };

function show(id) {
  for (const s of ['closed', 'login', 'panel', 'loading']) $('#' + s).hidden = s !== id;
}

async function start() {
  const st = await api('/api/admin/state').catch(() => ({ mode: 'closed' }));
  if (st.mode === 'closed') return show('closed');
  if (!st.authed) {
    show('login');
    return $('#pin').focus();
  }
  await refresh();
  show('panel');
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/admin/login', { method: 'POST', body: { pin: $('#pin').value } });
    $('#pin').value = '';
    $('#login-error').textContent = '';
    start();
  } catch (err) {
    $('#login-error').textContent = err.message;
    $('#pin').select();
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST' });
  start();
});

async function refresh() {
  const data = await api('/api/admin/overview');
  Object.assign(S, { classes: data.classes, materials: data.materials, usage: data.usage, baseUrl: data.baseUrl, ai: data.ai });
  renderUsage();
  renderClassPicks();
  renderClasses();
  renderMaterials();
}

function renderUsage() {
  const u = S.usage;
  const used = u.usedBytes / 1048576;
  const pct = Math.min(100, (used / u.limitMb) * 100);
  $('#usage-used').textContent = used.toFixed(1).replace('.', ',');
  $('#usage-limit').textContent = u.limitMb;
  const fill = $('#usage-fill');
  fill.style.width = pct + '%';
  fill.className = pct > 95 ? 'full' : pct > 80 ? 'warn' : '';
  const names = { db: 'Neon Postgres', local: 'жергілікті папка data/', b2: 'Backblaze B2' };
  $('#usage-sub').textContent = `Қойма: ${names[u.storage] || u.storage} · оқушы фотолары: ${(u.photoBytes / 1048576).toFixed(1).replace('.', ',')} МБ`;
}

// ---------- Вкладки ----------
document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.setAttribute('aria-selected', String(x === t)));
    $('#tab-materials').hidden = t.dataset.tab !== 'materials';
    $('#tab-classes').hidden = t.dataset.tab !== 'classes';
  }),
);

// ---------- Классы ----------
function className(id) {
  return S.classes.find((c) => c.id === id)?.name || '?';
}

function renderClasses() {
  const list = $('#class-list');
  if (!S.classes.length) {
    list.innerHTML = '<div class="empty span-all"><div class="big-emoji">👥</div>Сынып әлі жоқ. Жоғарыда қосыңыз.</div>';
    return;
  }
  list.innerHTML = S.classes
    .map(
      (c) => `<div class="card ccard" data-id="${c.id}">
      <div class="ccard-head">
        <div class="cls-badge">${esc(c.name)}</div>
        <div><div class="hint">Сынып коды</div><div class="ccard-code">${esc(c.code)}</div>
        <p class="hint">${c.materials} жеке материал · ${c.students.total ? `${c.students.registered}/${c.students.total} оқушы тіркелді` : 'тізімсіз'}</p></div>
      </div>
      <div class="link">${esc(S.baseUrl)}/k/${esc(c.code)}</div>
      <div class="btns">
        <a class="btn btn-yellow btn-sm" href="/print/${c.id}" target="_blank">🖨 QR карточка</a>
        <button class="btn btn-green btn-sm" data-act="students">👥 Оқушылар (${c.students.total})</button>
        <button class="btn btn-blue btn-sm" data-act="view">👁 Көру</button>
        <button class="btn btn-purple btn-sm" data-act="regen">🎲 Жаңа код</button>
        <button class="btn btn-purple btn-sm" data-act="manual">✏️ Өз кодым</button>
        <button class="btn btn-light btn-sm" data-act="rename">Атын өзгерту</button>
        <button class="btn btn-coral btn-sm" data-act="del">🗑 Жою</button>
      </div></div>`,
    )
    .join('');
}

$('#class-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/admin/classes', { method: 'POST', body: { name: $('#class-name').value, code: $('#class-code').value } });
    $('#class-name').value = '';
    $('#class-code').value = '';
    $('#class-error').textContent = '';
    toast('Сынып қосылды');
    await refresh();
  } catch (err) {
    $('#class-error').textContent = err.message;
  }
});

function askText({ title, text, value = '', max = 6, upper = true }) {
  return new Promise((resolve) => {
    const dlg = $('#code-dlg');
    dlg.querySelector('h2').textContent = title;
    $('#code-dlg-text').textContent = text;
    const inp = $('#code-dlg-input');
    inp.value = value;
    inp.maxLength = max;
    inp.classList.toggle('upper', upper);
    $('#code-dlg-error').textContent = '';
    const finish = (v) => {
      dlg.onsubmit = null;
      $('#code-dlg-cancel').onclick = null;
      if (dlg.open) dlg.close();
      resolve(v);
    };
    dlg.onsubmit = (e) => {
      e.preventDefault();
      finish(inp.value.trim());
    };
    $('#code-dlg-cancel').onclick = () => finish(null);
    dlg.oncancel = () => finish(null);
    dlg.showModal();
    inp.select();
  });
}

$('#class-list').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const id = Number(b.closest('[data-id]').dataset.id);
  const c = S.classes.find((x) => x.id === id);
  try {
    if (b.dataset.act === 'students') return openStudents(c);
    if (b.dataset.act === 'view') {
      await api('/api/join', { method: 'POST', body: { code: c.code } });
      window.open('/', '_blank');
    } else if (b.dataset.act === 'regen') {
      if (!(await confirmBox(`${c.name} сыныбына жаңа код жасалады. Ескі код (${c.code}) жұмыс істемей қалады, басылған QR карточкаларды жаңарту керек.`, 'Иә, өзгерту'))) return;
      const r = await api(`/api/admin/classes/${id}`, { method: 'PUT', body: { regenerate: true } });
      toast(`Жаңа код: ${r.code}`);
    } else if (b.dataset.act === 'manual') {
      const code = await askText({ title: 'Өз кодым', text: '5–6 латын әрпі немесе сан. Ескі код жұмыс істемей қалады.', value: c.code });
      if (!code) return;
      await api(`/api/admin/classes/${id}`, { method: 'PUT', body: { code } });
      toast('Код сақталды');
    } else if (b.dataset.act === 'rename') {
      const name = await askText({ title: 'Сынып атауы', text: '', value: c.name, max: 30, upper: false });
      if (!name) return;
      await api(`/api/admin/classes/${id}`, { method: 'PUT', body: { name } });
    } else if (b.dataset.act === 'del') {
      if (!(await confirmBox(`«${c.name}» сыныбы жойылады. Материалдар қалады, бірақ бұл сыныпқа көрінбейді.`))) return;
      await api(`/api/admin/classes/${id}`, { method: 'DELETE' });
      toast('Сынып жойылды');
    }
    await refresh();
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- Форма материала ----------
function renderClassPicks() {
  const checked = new Set([...document.querySelectorAll('#class-picks input:checked')].map((i) => Number(i.value)));
  $('#class-picks').innerHTML = S.classes
    .map((c) => `<label class="pick"><input type="checkbox" value="${c.id}" ${checked.has(c.id) ? 'checked' : ''}><span>${esc(c.name)}</span></label>`)
    .join('') || '<span class="hint">Алдымен «Сыныптар» бөлімінде сынып қосыңыз.</span>';
  syncAllClasses();
  const topics = [...new Set(S.materials.map((m) => m.topic).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'kk'));
  $('#topics').innerHTML = topics.map((t) => `<option value="${esc(t)}">`).join('');
  const f = $('#mat-class-filter');
  const cur = f.value;
  f.innerHTML = '<option value="">Барлық сыныптар</option>' + S.classes.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  f.value = cur;
}

function syncAllClasses() {
  const all = $('#all-classes').checked;
  document.querySelectorAll('#class-picks input').forEach((i) => (i.disabled = all));
}
$('#all-classes').addEventListener('change', syncAllClasses);

function setType(type) {
  S.type = type;
  document.querySelectorAll('#mat-type button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.type === type)));
  $('#f-file').hidden = type !== 'file';
  $('#f-url').hidden = type === 'file';
  $('#url').placeholder = { video: 'https://www.youtube.com/watch?v=…', slides: 'https://docs.google.com/presentation/…', link: 'https://…' }[type] || '';
}
document.querySelectorAll('#mat-type button').forEach((b) => b.addEventListener('click', () => !b.disabled && setType(b.dataset.type)));

function setFile(file) {
  const drop = $('#drop');
  if (!file) {
    S.file = null;
    drop.classList.remove('has-file');
    $('#drop-text').innerHTML = S.editing?.file
      ? `Қазіргі файл: <b>${esc(S.editing.file.name)}</b><br>Ауыстыру үшін жаңасын сүйреңіз`
      : 'Файлды осында сүйреңіз немесе <u>таңдаңыз</u>';
    return;
  }
  if (file.size > MAX_MB * 1048576) {
    toast(`Файл тым үлкен: ${fmtSize(file.size)}. Ең көбі ${MAX_MB} МБ.`, true);
    return;
  }
  if (!/\.(pdf|docx?|odt|rtf|pptx?|ppsx|odp)$/i.test(file.name)) {
    toast('Тек PDF, Word және PowerPoint файлдары', true);
    return;
  }
  S.file = file;
  drop.classList.add('has-file');
  $('#drop-text').innerHTML = `✅ <b>${esc(file.name)}</b> · ${fmtSize(file.size)}`;
  if (!$('#title').value.trim()) $('#title').value = file.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ');
}

$('#file').addEventListener('change', (e) => setFile(e.target.files[0]));
const drop = $('#drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => setFile(e.dataTransfer.files[0]));
// файл, брошенный мимо зоны, не должен открываться в браузере
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  if (!$('#tab-materials').hidden && S.type === 'file' && e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
});

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function resetForm() {
  S.editing = null;
  $('#mat-form').reset();
  $('#date').value = today();
  $('#mat-form-title').textContent = 'Жаңа материал';
  $('#mat-cancel').hidden = true;
  $('#mat-error').textContent = '';
  document.querySelectorAll('#mat-type button').forEach((b) => (b.disabled = false));
  setType('file');
  setFile(null);
  syncAllClasses();
  $('#quiz-key').open = false;
  $('#quiz-key').classList.remove('has-key');
  $('#hw-key').open = false;
  $('#hw-key').classList.remove('has-key');
}
$('#mat-cancel').addEventListener('click', resetForm);

function editMaterial(m) {
  resetForm();
  S.editing = m;
  $('#mat-form-title').textContent = 'Материалды өзгерту';
  $('#mat-cancel').hidden = false;
  const type = m.file ? 'file' : m.kind === 'pres' ? 'slides' : m.kind;
  setType(type);
  // файл можно заменить файлом; у ссылки — сменить вид ссылки
  document.querySelectorAll('#mat-type button').forEach((b) => (b.disabled = m.file ? b.dataset.type !== 'file' : b.dataset.type === 'file'));
  setFile(null);
  $('#url').value = m.url || '';
  $('#title').value = m.title;
  $('#topic').value = m.topic;
  $('#date').value = m.date;
  $('#all-classes').checked = m.allClasses;
  if (m.hw) {
    $('#hw-on').checked = true;
    $('#hw-open').checked = m.hw.open;
    $('#hw-due').value = m.hw.due || '';
    $('#hw-ainote').value = m.hw.aiNote || '';
    $('#hw-key').open = true;
    $('#hw-key').classList.add('has-key');
  }
  if (m.quizKey) {
    $('#quiz-answers').value = m.quizKey.answers.join('\n');
    $('#quiz-open').checked = m.quizKey.open;
    $('#quiz-retry').checked = m.quizKey.retry;
    $('#quiz-show').checked = m.quizKey.show;
    $('#quiz-key').open = true;
    $('#quiz-key').classList.add('has-key');
  }
  document.querySelectorAll('#class-picks input').forEach((i) => (i.checked = m.classIds.includes(Number(i.value))));
  syncAllClasses();
  $('#mat-form').scrollIntoView({ behavior: 'smooth' });
  $('#title').focus({ preventScroll: true });
}

function formMeta() {
  return {
    title: $('#title').value.trim(),
    topic: $('#topic').value.trim(),
    date: $('#date').value || today(),
    allClasses: $('#all-classes').checked,
    classIds: [...document.querySelectorAll('#class-picks input:checked')].map((i) => Number(i.value)),
    quiz: quizMeta(),
    hw: $('#hw-on').checked ? { open: $('#hw-open').checked, due: $('#hw-due').value || null, aiNote: $('#hw-ainote').value.trim() } : null,
  };
}

function quizMeta() {
  const answers = $('#quiz-answers').value.split('\n').map((a) => a.trim()).filter(Boolean);
  if (!answers.length) return null;
  return { answers, open: $('#quiz-open').checked, retry: $('#quiz-retry').checked, show: $('#quiz-show').checked };
}

function upload(url, method, file, meta) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.setRequestHeader('X-Req', '1');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.setRequestHeader('X-Meta', encodeURIComponent(JSON.stringify(meta)));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    const bar = $('#progress');
    bar.hidden = false;
    xhr.upload.onprogress = (e) => e.lengthComputable && ($('#progress-fill').style.width = (e.loaded / e.total) * 100 + '%');
    xhr.onload = () => {
      bar.hidden = true;
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      xhr.status < 300 ? resolve(data) : reject(new Error(data.error || `Қате (${xhr.status})`));
    };
    xhr.onerror = () => {
      bar.hidden = true;
      reject(new Error('Интернет байланысы жоқ'));
    };
    xhr.send(file);
  });
}

$('#mat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const meta = formMeta();
  const err = $('#mat-error');
  err.textContent = '';
  if (!meta.title) return (err.textContent = 'Атауын жазыңыз');
  if (!meta.allClasses && !meta.classIds.length) return (err.textContent = 'Кем дегенде бір сыныпты таңдаңыз');
  const btn = $('#mat-submit');
  btn.disabled = true;
  try {
    const ed = S.editing;
    if (S.type === 'file') {
      if (ed && !S.file) await api(`/api/admin/materials/${ed.id}`, { method: 'PUT', body: meta });
      else if (!S.file) throw new Error('Файлды таңдаңыз');
      else if (ed) await upload(`/api/admin/materials/${ed.id}/file`, 'PUT', S.file, meta);
      else await upload('/api/admin/materials/upload', 'POST', S.file, meta);
    } else {
      const body = { ...meta, type: S.type, url: $('#url').value.trim() };
      if (!body.url) throw new Error('Сілтемені қойыңыз');
      if (ed) await api(`/api/admin/materials/${ed.id}`, { method: 'PUT', body });
      else await api('/api/admin/materials', { method: 'POST', body });
    }
    toast(ed ? 'Өзгерістер сақталды' : 'Материал қосылды ✅');
    const keepTopic = meta.topic;
    resetForm();
    if (!ed) $('#topic').value = keepTopic;
    await refresh();
  } catch (e2) {
    err.textContent = e2.message;
  } finally {
    btn.disabled = false;
  }
});

// ---------- Список материалов ----------
function renderMaterials() {
  const q = $('#mat-search').value.trim().toLocaleLowerCase('kk');
  const cf = Number($('#mat-class-filter').value) || 0;
  const items = S.materials.filter(
    (m) => (!q || m.title.toLocaleLowerCase('kk').includes(q) || m.topic.toLocaleLowerCase('kk').includes(q)) &&
      (!cf || m.allClasses || m.classIds.includes(cf)),
  );
  const list = $('#mat-list');
  if (!items.length) {
    list.innerHTML = `<div class="empty"><div class="big-emoji">📭</div>${S.materials.length ? 'Ештеңе табылмады' : 'Материал әлі жоқ'}</div>`;
    return;
  }
  list.innerHTML = items
    .map((m) => {
      const k = KINDS[m.kind] || KINDS.link;
      const tags = m.allClasses
        ? '<span class="tag tag-all">Барлық сыныптар</span>'
        : m.classIds.length
          ? m.classIds.map((id) => `<span class="tag">${esc(className(id))}</span>`).join(' ')
          : '<span class="tag tag-none">Сынып жоқ — ешкім көрмейді</span>';
      const open = m.href ? m.href : m.url;
      return `<div class="card arow" data-kind="${m.kind}" data-id="${m.id}">
        <div class="kicon" aria-hidden="true">${k.icon}</div>
        <div><h3>${esc(m.title)}${m.isNew ? '<span class="badge-new">Жаңа</span>' : ''}</h3>
          <div class="meta"><span class="kind-name">${k.name}</span><span>${esc(m.topic)}</span><span>${fmtDate(m.date)}</span>
          ${m.file ? `<span>${esc(m.file.name)} · ${fmtSize(m.file.size)}</span>` : ''}</div>
          <div class="meta">${tags}${m.hw ? ` <span class="tag tag-hw">📷 фото${m.hw.due ? ' · ' + fmtDate(m.hw.due) + ' дейін' : ''}${m.hw.open ? '' : ' · жабық'}</span>` : ''}${m.quizKey ? ` <span class="tag tag-quiz">✏️ ${m.quizKey.answers.length} есеп${m.quizKey.open ? '' : ' · жабық'}</span>` : ''}</div></div>
        <div class="btns">
          <a class="btn btn-light btn-sm" href="${esc(open)}" target="_blank" rel="noopener">Ашу</a>
          ${m.hw ? `<button class="btn btn-blue btn-sm" data-act="subs">📷 Жұмыстар (${m.submissions.total}${m.submissions.unchecked ? ` · ${m.submissions.unchecked} жаңа` : ''})</button>` : ''}
          ${m.quizKey ? `<button class="btn btn-green btn-sm" data-act="results">📊 Нәтижелер (${m.results})</button>` : ''}
          <button class="btn btn-blue btn-sm" data-act="edit">✏️ Өзгерту</button>
          <button class="btn btn-coral btn-sm" data-act="del">🗑 Жою</button>
        </div></div>`;
    })
    .join('');
}
$('#mat-search').addEventListener('input', renderMaterials);
$('#mat-class-filter').addEventListener('change', renderMaterials);

$('#mat-list').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const m = S.materials.find((x) => x.id === Number(b.closest('[data-id]').dataset.id));
  if (b.dataset.act === 'edit') return editMaterial(m);
  if (b.dataset.act === 'results') return openResults(m);
  if (b.dataset.act === 'subs') return openSubs(m);
  if (!(await confirmBox(`«${m.title}» материалы жойылады. Оны қайтару мүмкін емес.`))) return;
  try {
    await api(`/api/admin/materials/${m.id}`, { method: 'DELETE' });
    if (S.editing?.id === m.id) resetForm();
    toast('Материал жойылды');
    await refresh();
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- Результаты ----------
const R = { data: null, mat: null };
const resDlg = $('#res-dlg');

async function openResults(m) {
  R.mat = m;
  $('#res-title').textContent = `📊 ${m.title}`;
  $('#res-csv').href = `/api/admin/materials/${m.id}/results.csv`;
  try {
    R.data = await api(`/api/admin/materials/${m.id}/results`);
  } catch (e) {
    return toast(e.message, true);
  }
  const all = [...R.data.results, ...R.data.missing];
  const classIds = [...new Set(all.map((r) => r.classId))];
  $('#res-class').innerHTML = '<option value="">Барлық сыныптар</option>' +
    classIds.map((id) => `<option value="${id}">${esc(all.find((r) => r.classId === id).className)}</option>`).join('');
  renderResults();
  if (!resDlg.open) resDlg.showModal();
}

function renderResults() {
  const { key, results } = R.data;
  const cf = Number($('#res-class').value) || 0;
  let rows = results.filter((r) => !cf || r.classId === cf);
  if ($('#res-last').checked) {
    const last = new Map();
    for (const r of rows) last.set(r.classId + '|' + r.name.toLocaleLowerCase('kk'), r);
    rows = [...last.values()];
  }
  rows.sort((a, b) => a.className.localeCompare(b.className, 'kk') || a.name.localeCompare(b.name, 'kk') || a.attempt - b.attempt);

  if (!rows.length && !R.data.missing.some((x) => !cf || x.classId === cf)) {
    $('#res-summary').innerHTML = '';
    $('#res-table').innerHTML = '<div class="empty res-empty"><div class="big-emoji">📭</div>Әзірге жауап жоқ</div>';
    return;
  }
  const avg = rows.length ? rows.reduce((s, r) => s + r.score / r.total, 0) / rows.length : 0;
  const full = rows.filter((r) => r.score === r.total).length;
  const miss = R.data.missing.filter((x) => !cf || x.classId === cf).length;
  $('#res-summary').innerHTML = `<span class="tag">Жауап берді: ${rows.length}</span>${miss ? `<span class="tag tag-none">Тапсырмағандар: ${miss}</span>` : ''}
    <span class="tag">Орташа: ${Math.round(avg * 100)}%</span><span class="tag tag-quiz">Бәрі дұрыс: ${full}</span>`;

  const pct = key.map((_, i) => (rows.length ? Math.round((rows.filter((r) => r.marks[i]).length / rows.length) * 100) : 0));
  const fmtTime = (t) => new Date(t).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  $('#res-table').innerHTML = `<table>
    <thead><tr><th class="l">Сынып</th><th class="l">Аты-жөні</th><th>Ұпай</th>${key.map((k, i) => `<th title="Жауабы: ${esc(k)}">№${i + 1}</th>`).join('')}<th>Уақыт</th><th></th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td class="l">${esc(r.className)}</td>
      <td class="l">${esc(r.name)}${r.attempt > 1 ? ` <span class="tag">${r.attempt}-әрекет</span>` : ''}</td>
      <td class="score">${r.score}/${r.total}</td>
      ${r.marks.map((ok, i) => `<td><span class="mk ${ok ? 'ok' : 'no'}">${ok ? '✓' : '✗'}</span><small title="${esc(r.answers[i])}">${esc(r.answers[i] || '—')}</small></td>`).join('')}
      <td>${fmtTime(r.createdAt)}</td>
      <td><button class="del-res" data-res="${r.id}" title="Жою">🗑</button></td></tr>`).join('')}</tbody>
    ${missingRows(cf)}
    <tfoot><tr><td class="l" colspan="3">Дұрыс шығарғандар</td>${pct.map((p) => `<td class="${p < 50 ? 'pct-low' : ''}">${p}%</td>`).join('')}<td colspan="2"></td></tr></tfoot>
  </table>`;
}

function missingRows(cf) {
  const list = R.data.missing.filter((x) => !cf || x.classId === cf)
    .sort((a, b) => a.className.localeCompare(b.className, 'kk') || a.name.localeCompare(b.name, 'kk'));
  if (!list.length) return '';
  return `<tbody>${list.map((x) => `<tr class="missing"><td class="l">${esc(x.className)}</td><td class="l">${esc(x.name)}</td>
    <td>—</td><td colspan="${R.data.key.length}">тапсырмаған${x.registered ? '' : ' · сайтқа кірмеген'}</td><td></td><td></td></tr>`).join('')}</tbody>`;
}

$('#res-class').addEventListener('change', renderResults);
$('#res-last').addEventListener('change', renderResults);
$('#res-close').addEventListener('click', () => resDlg.close());
resDlg.addEventListener('close', () => refresh().catch(() => {}));
$('#res-table').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-res]');
  if (!b) return;
  if (!(await confirmBox('Бұл жауап жойылады.'))) return;
  await api(`/api/admin/results/${b.dataset.res}`, { method: 'DELETE' }).catch((err) => toast(err.message, true));
  openResults(R.mat);
});
$('#res-clear').addEventListener('click', async () => {
  if (!(await confirmBox(`«${R.mat.title}» бойынша барлық жауаптар жойылады.`))) return;
  await api(`/api/admin/materials/${R.mat.id}/results`, { method: 'DELETE' }).catch((err) => toast(err.message, true));
  openResults(R.mat);
});

// ---------- Оқушылар ----------
const stuDlg = $('#stu-dlg');
let stuClass = null;

async function openStudents(c) {
  stuClass = c;
  $('#stu-title').textContent = `👥 ${c.name} — оқушылар`;
  let list;
  try {
    list = await api(`/api/admin/classes/${c.id}/students`);
  } catch (e) {
    return toast(e.message, true);
  }
  const reg = list.filter((x) => x.registered).length;
  $('#stu-summary').innerHTML = list.length
    ? `<span class="tag">Барлығы: ${list.length}</span><span class="tag tag-quiz">Тіркелді: ${reg}</span>${list.length - reg ? `<span class="tag tag-none">Әлі кірмеген: ${list.length - reg}</span>` : ''}`
    : '<span class="tag tag-none">Тізім бос — оқушылар есімсіз кіреді (тек сынып коды)</span>';
  $('#stu-list').innerHTML = list.map((x) => `<div class="srow" data-sid="${x.id}">
      <span class="nm">${esc(x.name)}</span>
      <span class="st ${x.registered ? 'ok' : ''}">${x.registered ? '✅ тіркелді' : '⏳ әлі кірмеген'}</span>
      ${x.registered ? '<button class="btn btn-yellow btn-sm" data-sact="reset">🔑 PIN тастау</button>' : ''}
      <button class="btn btn-light btn-sm" data-sact="rename">✏️</button>
      <button class="btn btn-coral btn-sm" data-sact="del">🗑</button></div>`).join('');
  $('#stu-add').open = !list.length;
  if (!stuDlg.open) stuDlg.showModal();
}

$('#stu-close').addEventListener('click', () => stuDlg.close());
stuDlg.addEventListener('close', () => refresh().catch(() => {}));

$('#stu-save').addEventListener('click', async () => {
  const names = $('#stu-names').value;
  if (!names.trim()) return toast('Есімдерді жазыңыз', true);
  try {
    const r = await api(`/api/admin/classes/${stuClass.id}/students`, { method: 'POST', body: { names } });
    $('#stu-names').value = '';
    toast(`Қосылды: ${r.added}${r.skipped ? ` · қайталанғаны өткізілді: ${r.skipped}` : ''}`);
    openStudents(stuClass);
  } catch (e) {
    toast(e.message, true);
  }
});

$('#stu-list').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-sact]');
  if (!b) return;
  const id = b.closest('[data-sid]').dataset.sid;
  const name = b.closest('[data-sid]').querySelector('.nm').textContent;
  try {
    if (b.dataset.sact === 'reset') {
      if (!(await confirmBox(`${name}: PIN өшіріледі. Оқушы келесі кіргенде жаңа PIN ойлап табады.`, 'Иә, тастау'))) return;
      await api(`/api/admin/students/${id}/reset`, { method: 'POST' });
      toast('PIN тасталды');
    } else if (b.dataset.sact === 'rename') {
      const nn = await askText({ title: 'Оқушы аты', text: '', value: name, max: 60, upper: false });
      if (!nn) return;
      await api(`/api/admin/students/${id}`, { method: 'PUT', body: { name: nn } });
    } else {
      if (!(await confirmBox(`${name} тізімнен жойылады. Бұрынғы жауаптары нәтижелерде қалады.`))) return;
      await api(`/api/admin/students/${id}`, { method: 'DELETE' });
    }
    openStudents(stuClass);
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- Жұмыстар (фото) ----------
const subDlg = $('#sub-dlg');
const SB = { mat: null, data: null, photos: [], i: 0, rot: 0 };

async function openSubs(m) {
  SB.mat = m;
  $('#sub-title').textContent = `📷 ${m.title}`;
  try {
    SB.data = await api(`/api/admin/materials/${m.id}/submissions`);
  } catch (e) {
    return toast(e.message, true);
  }
  const all = [...SB.data.submissions, ...SB.data.missing];
  const ids = [...new Set(all.map((x) => x.classId))];
  const cur = $('#sub-class').value;
  $('#sub-class').innerHTML = '<option value="">Барлық сыныптар</option>' +
    ids.map((id) => `<option value="${id}">${esc(all.find((x) => x.classId === id).className)}</option>`).join('');
  $('#sub-class').value = ids.includes(Number(cur)) ? cur : '';
  renderSubs();
  if (!subDlg.open) subDlg.showModal();
}

function renderSubs() {
  const cf = Number($('#sub-class').value) || 0;
  const onlyNew = $('#sub-new').checked;
  const subs = SB.data.submissions
    .filter((x) => (!cf || x.classId === cf) && (!onlyNew || x.status !== 'checked'))
    .sort((a, b) => a.className.localeCompare(b.className, 'kk') || a.name.localeCompare(b.name, 'kk') || a.id - b.id);
  const missing = SB.data.missing.filter((x) => !cf || x.classId === cf);
  const unchecked = SB.data.submissions.filter((x) => (!cf || x.classId === cf) && x.status !== 'checked').length;
  $('#sub-summary').innerHTML = `<span class="tag">Жіберді: ${new Set(SB.data.submissions.filter((x) => !cf || x.classId === cf).map((x) => x.studentId || x.name)).size}</span>
    ${unchecked ? `<span class="tag tag-hw">Тексерілмеген: ${unchecked}</span>` : '<span class="tag tag-quiz">Бәрі тексерілді</span>'}
    ${missing.length ? `<span class="tag tag-none">Жібермегендер: ${missing.length}</span>` : ''}
    ${SB.data.material.due ? `<span class="tag">Мерзімі: ${fmtDate(SB.data.material.due)}</span>` : ''}`;
  const todo = SB.data.submissions.filter((x) => (!cf || x.classId === cf) && !x.ai && x.status !== 'checked');
  $('#sub-ai-all').hidden = !S.ai?.enabled || !todo.length;
  $('#sub-ai-all').textContent = `🤖 Барлығын AI-мен тексеру (${todo.length})`;
  if (!S.ai?.enabled) $('#sub-summary').insertAdjacentHTML('beforeend', '<span class="tag ai-off">🤖 AI өшірулі — Render-де ANTHROPIC_API_KEY қосыңыз</span>');
  SB.photos = [];
  const fmtT = (t) => new Date(t).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  $('#sub-list').innerHTML = (subs.map((x) => {
    const ph = x.files.map((f) => {
      SB.photos.push({ url: f.url, cap: `${x.name} · ${x.className}` });
      return `<button type="button" data-ph="${SB.photos.length - 1}"><img src="${f.url}" alt="" loading="lazy"></button>`;
    }).join('');
    return `<div class="sub ${x.status === 'checked' ? 'checked' : ''}" data-sub="${x.id}">
      <div class="sub-head"><b>${esc(x.name)}</b><span class="tag">${esc(x.className)}</span><span class="hint">${fmtT(x.createdAt)}</span>
        ${x.late ? '<span class="tag tag-none">кешігіп</span>' : ''}${x.status === 'checked' ? '<span class="tag tag-quiz">✅ тексерілді</span>' : ''}</div>
      ${x.comment ? `<div class="sub-comment">«${esc(x.comment)}»</div>` : ''}
      <div class="sub-photos">${ph}</div>
      ${aiBox(x)}
      <div class="sub-check">
        <input data-f="grade" maxlength="20" placeholder="Баға" value="${esc(x.grade)}" aria-label="Баға">
        <input data-f="feedback" maxlength="300" placeholder="Оқушыға пікір (міндетті емес)" value="${esc(x.feedback)}" aria-label="Пікір">
        ${S.ai?.enabled ? `<button class="btn btn-purple btn-sm" data-sb="ai">🤖 ${x.ai ? 'Қайта AI' : 'AI тексеру'}</button>` : ''}
        <button class="btn btn-green btn-sm" data-sb="check">✅ Тексерілді</button>
        <button class="btn btn-coral btn-sm" data-sb="del" aria-label="Жою">🗑</button>
      </div></div>`;
  }).join('') || '<div class="empty res-empty"><div class="big-emoji">📭</div>Әзірге жұмыс жоқ</div>') +
    (missing.length ? `<div class="sub sub-missing"><b>Жібермегендер:</b> ${missing.map((x) => esc(x.name) + (cf ? '' : ` (${esc(x.className)})`)).join(', ')}</div>` : '');
}

const VERDICT = { correct: '✅', error: '❌', unclear: '❓', missing: '➖' };

function aiBox(x) {
  const a = x.ai;
  if (!a) return '';
  return `<div class="ai-box">
    <div class="ai-head">🤖 AI ұсынысы${a.grade ? ` · Баға: <b>${esc(a.grade)}</b>` : ''}
      <button class="btn btn-light btn-sm" data-sb="ai-apply" type="button">Ұсынысты қою ↓</button></div>
    ${a.legible ? '' : '<div class="ai-warn">⚠️ Фото анық емес — өзіңіз мұқият қараңыз</div>'}
    <ul class="ai-list">${a.problems.map((p) => `<li><b>${VERDICT[p.verdict] || '❓'} №${esc(p.number)}</b> ${esc(p.note)}</li>`).join('')}</ul>
    ${a.summary ? `<div class="ai-sum">${esc(a.summary)}</div>` : ''}
    ${a.feedback ? `<div class="ai-sum">Оқушыға: «${esc(a.feedback)}»</div>` : ''}
    <div class="ai-meta">AI қателесуі мүмкін — тексеріп барып «Тексерілді» басыңыз.</div>
  </div>`;
}

async function runAi(id, btn) {
  btn?.classList.add('busy');
  if (btn) btn.textContent = '🤖 Тексерілуде…';
  try {
    const ai = await api(`/api/admin/submissions/${id}/ai`, { method: 'POST' });
    const x = SB.data.submissions.find((s) => String(s.id) === String(id));
    if (x) x.ai = ai;
    return true;
  } catch (err) {
    toast(err.message, true);
    return false;
  } finally {
    btn?.classList.remove('busy');
  }
}

$('#sub-ai-all').addEventListener('click', async () => {
  const cf = Number($('#sub-class').value) || 0;
  const todo = SB.data.submissions.filter((x) => (!cf || x.classId === cf) && !x.ai && x.status !== 'checked');
  const btn = $('#sub-ai-all');
  btn.classList.add('busy');
  let done = 0;
  for (const x of todo) {
    btn.textContent = `🤖 ${done + 1}/${todo.length} тексерілуде…`;
    if (!(await runAi(x.id))) break;
    done++;
    renderSubs();
  }
  btn.classList.remove('busy');
  renderSubs();
  if (done) toast(`AI тексерді: ${done}. Ұсыныстарды қарап, «Тексерілді» басыңыз.`);
});

$('#sub-class').addEventListener('change', renderSubs);
$('#sub-new').addEventListener('change', renderSubs);
$('#sub-close').addEventListener('click', () => subDlg.close());
subDlg.addEventListener('close', () => refresh().catch(() => {}));

$('#sub-list').addEventListener('click', async (e) => {
  const ph = e.target.closest('[data-ph]');
  if (ph) return openLightbox(Number(ph.dataset.ph));
  const b = e.target.closest('[data-sb]');
  if (!b) return;
  const card = b.closest('[data-sub]');
  const id = card.dataset.sub;
  if (b.dataset.sb === 'ai') {
    if (await runAi(id, b)) renderSubs();
    return;
  }
  if (b.dataset.sb === 'ai-apply') {
    const ai = SB.data.submissions.find((s) => String(s.id) === id).ai;
    card.querySelector('[data-f=grade]').value = ai.grade;
    card.querySelector('[data-f=feedback]').value = ai.feedback;
    card.querySelector('[data-f=grade]').focus();
    return;
  }
  try {
    if (b.dataset.sb === 'check') {
      await api(`/api/admin/submissions/${id}`, {
        method: 'PUT',
        body: { status: 'checked', grade: card.querySelector('[data-f=grade]').value, feedback: card.querySelector('[data-f=feedback]').value },
      });
      toast('Сақталды — оқушы бағасын көреді');
    } else {
      if (!(await confirmBox('Бұл жұмыс пен оның фотолары жойылады.'))) return;
      await api(`/api/admin/submissions/${id}`, { method: 'DELETE' });
    }
    await openSubs(SB.mat);
  } catch (err) {
    toast(err.message, true);
  }
});
// Enter в поле оценки — то же, что «Тексерілді»
$('#sub-list').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('.sub-check input')) {
    e.preventDefault();
    e.target.closest('[data-sub]').querySelector('[data-sb=check]').click();
  }
});

$('#sub-clear').addEventListener('click', async () => {
  if (!(await confirmBox(`«${SB.mat.title}» бойынша барлық жұмыстар мен фотолар жойылады. Бағалар да өшеді.`))) return;
  try {
    const r = await api(`/api/admin/materials/${SB.mat.id}/submissions`, { method: 'DELETE' });
    toast(`Босатылды: ${(r.freedBytes / 1048576).toFixed(1).replace('.', ',')} МБ`);
    await openSubs(SB.mat);
  } catch (err) {
    toast(err.message, true);
  }
});

// Просмотр фото: стрелки, поворот
const lb = $('#lb-dlg');
function showPhoto() {
  const p = SB.photos[SB.i];
  $('#lb-img').src = p.url;
  $('#lb-img').style.transform = `rotate(${SB.rot}deg)`;
  $('#lb-cap').textContent = `${p.cap} · ${SB.i + 1}/${SB.photos.length}`;
  $('#lb-open').href = p.url;
}
function openLightbox(i) {
  SB.i = i;
  SB.rot = 0;
  showPhoto();
  lb.showModal();
}
const step = (d) => {
  SB.i = (SB.i + d + SB.photos.length) % SB.photos.length;
  SB.rot = 0;
  showPhoto();
};
$('#lb-prev').addEventListener('click', () => step(-1));
$('#lb-next').addEventListener('click', () => step(1));
$('#lb-close').addEventListener('click', () => lb.close());
$('#lb-rot').addEventListener('click', () => {
  SB.rot = (SB.rot + 90) % 360;
  showPhoto();
});
lb.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') step(-1);
  if (e.key === 'ArrowRight') step(1);
});

resetForm();
start();
