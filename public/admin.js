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
  Object.assign(S, { classes: data.classes, materials: data.materials, usage: data.usage, baseUrl: data.baseUrl });
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
  $('#usage-sub').textContent = `Қойма: ${names[u.storage] || u.storage} · бір файл ≤ ${u.maxFileMb} МБ`;
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
        <p class="hint">${c.materials} жеке материал</p></div>
      </div>
      <div class="link">${esc(S.baseUrl)}/k/${esc(c.code)}</div>
      <div class="btns">
        <a class="btn btn-yellow btn-sm" href="/print/${c.id}" target="_blank">🖨 QR карточка</a>
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
  };
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
          <div class="meta">${tags}</div></div>
        <div class="btns">
          <a class="btn btn-light btn-sm" href="${esc(open)}" target="_blank" rel="noopener">Ашу</a>
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

resetForm();
start();
