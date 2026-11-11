// 두암 디지털 공책 — app logic (students write, teachers watch live and give feedback)
const $ = id => document.getElementById(id);
const PAPERS = { lined: '줄공책', grid: '칸공책', '': '무지' };
const PAPER_ORDER = ['lined', 'grid', ''];
const PAGE_LIMIT = 900000; // Firestore documents must stay under 1 MB
const LIVE_MS = 90 * 1000;
const STUDENT_DOMAIN = 'student.duam-notebook.app'; // sign-in ids only; no mail is ever sent

const lsGet = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
const lsPut = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const today = () => new Date().toISOString();
const fmtDate = iso => { const d = new Date(iso); return `${d.getMonth() + 1}월 ${d.getDate()}일 (${'일월화수목금토'[d.getDay()]})`; };
const fmtTime = ms => { const d = new Date(ms); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };
const ago = ms => { const s = (Date.now() - ms) / 1000; if (s < 60) return '방금'; if (s < 3600) return Math.floor(s / 60) + '분 전'; return fmtDate(new Date(ms).toISOString()); };
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
const randCode = () => Array.from(crypto.getRandomValues(new Uint32Array(6)), n => CODE_CHARS[n % CODE_CHARS.length]).join('');
const randPin = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 900000 + 100000);
const studentEmail = (code, num, k) => `${code.toLowerCase()}-${num}-${k}@${STUDENT_DOMAIN}`;
const parseStudentEmail = e => { const m = /^([a-z0-9]{6})-(\d+)-(\d+)@/.exec(e || ''); return m && { code: m[1].toUpperCase(), num: +m[2] }; };
const views = ['boot', 'start', 'classes', 'shelf', 'class', 'book'];
const show = v => views.forEach(n => { $(n).hidden = n !== v; });

let toastTimer = null;
function toast(text) { const t = $('toast'); t.textContent = text; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3500); }
const KO_ERR = {
  'auth/invalid-credential': '반 코드, 번호, 비밀번호를 다시 확인해 주세요.',
  'auth/wrong-password': '비밀번호가 맞지 않아요.',
  'auth/user-not-found': '등록되지 않은 번호예요. 선생님께 물어보세요.',
  'auth/too-many-requests': '너무 여러 번 틀렸어요. 잠시 뒤에 다시 해 주세요.',
  'auth/network-request-failed': '인터넷 연결을 확인해 주세요.',
  'auth/popup-closed-by-user': '로그인 창이 닫혔어요.',
  'auth/unauthorized-domain': '이 주소가 Firebase에 등록되지 않았어요. 설정 안내의 "승인된 도메인"을 확인해 주세요.',
  'permission-denied': '권한이 없어요.',
};
const errText = e => KO_ERR[e && e.code] || ('문제가 생겼어요' + (e && e.code ? ` (${e.code})` : ''));

/* ================= stroke encoding ================= */
function encode(s) {
  let px = 0, py = 0, pp = 0; const out = [];
  for (const p of s.pts) {
    const X = Math.round(p.x * 2), Y = Math.round(p.y * 2), P = Math.round(p.p * 20);
    out.push(X - px, Y - py, P - pp); px = X; py = Y; pp = P;
  }
  return { c: s.color, s: s.size, t: s.erase ? 'e' : s.hl ? 'h' : 'p', d: out.join(',') };
}
function decode(o) {
  const n = o.d ? o.d.split(',').map(Number) : []; const pts = [];
  let X = 0, Y = 0, P = 0;
  for (let i = 0; i + 2 < n.length; i += 3) { X += n[i]; Y += n[i + 1]; P += n[i + 2]; pts.push({ x: X / 2, y: Y / 2, p: P / 20 }); }
  return { pts, color: o.c, size: o.s, erase: o.t === 'e', hl: o.t === 'h' };
}

/* ================= backend ================= */
if (!window.__TEST_BACKEND && (!window.FIREBASE_CONFIG || !window.FIREBASE_CONFIG.apiKey)) {
  $('boot').textContent = 'Firebase 설정이 아직 없어요. config.js에 설정값을 넣어 주세요.';
  throw new Error('missing config');
}
let backend;
try {
  backend = window.__TEST_BACKEND || await (await import('./backend.js')).createBackend(window.FIREBASE_CONFIG);
} catch (e) {
  $('boot').textContent = '서버에 연결하지 못했어요. 인터넷 연결을 확인하고 다시 열어 주세요.';
  throw e;
}
const db = backend.db;

let me = null;          // signed-in user
let classId = null;     // current class code
let R = null;           // refs for the student being written or viewed

function classRefs(code, sid) {
  const student = db.doc(`classes/${code}/students/${sid}`);
  const books = student.collection('notebooks');
  const page = (nb, pg) => books.doc(nb).collection('pages').doc(pg);
  return {
    student, books, page,
    pages: nb => books.doc(nb).collection('pages'),
    fb: (nb, pg) => page(nb, pg).collection('notes').doc('teacher'),
    chat: (nb, pg) => page(nb, pg).collection('chat'),
  };
}
const store = {
  async listNotebooks() { const s = await R.books.get(); return s.docs.map(d => ({ ...d.data(), id: d.id })); },
  async putNotebook(nb) { const { id, ...b } = nb; await R.books.doc(id).set(b); },
  async listPages(nbId) { const s = await R.pages(nbId).orderBy('n').get(); return s.docs.map(d => ({ ...d.data(), id: d.id })); },
  async putPage(nbId, pg) { const { id, ...b } = pg; await R.page(nbId, id).set(b); },
};

// the student's live status for the teacher's grid; students may only change these fields
let studentWrite = Promise.resolve();
function touchStudent(patch) {
  if (!R || mode !== 'student') return;
  studentWrite = studentWrite.then(() => R.student.update(patch)).catch(() => {});
}

/* ================= start & sign-in ================= */
let authSettled = false;
backend.onAuth(async u => {
  me = u;
  if (!u) { authSettled = true; goStart(); return; }
  if (u.isGoogle) { await enterTeacherHome(); }
  else {
    const s = parseStudentEmail(u.email);
    if (!s) { await backend.logout(); return; }
    await enterStudent(s.code, s.num);
  }
  authSettled = true;
});

function goStart() {
  stopClass(); clearPageSubs();
  show('start');
  const last = lsGet('dn-last');
  if (last) { $('s-code').value = last.code || ''; if (last.num) $('s-num').value = last.num; }
}
$('student-form').addEventListener('submit', async e => {
  e.preventDefault();
  const code = $('s-code').value.trim().toUpperCase(), num = parseInt($('s-num').value, 10), pin = $('s-pin').value.trim();
  if (!/^[A-Z0-9]{6}$/.test(code)) { $('s-err').textContent = '반 코드 6글자를 써 주세요.'; return; }
  if (!num) { $('s-err').textContent = '번호를 써 주세요.'; return; }
  if (!/^\d{6}$/.test(pin)) { $('s-err').textContent = '비밀번호 6자리를 써 주세요.'; return; }
  $('s-err').textContent = ''; $('s-go').disabled = true;
  try {
    const roster = await db.doc(`classes/${code}/public/roster`).get();
    const k = roster.exists ? roster.data()['n' + num] : undefined;
    if (k === undefined) { $('s-err').textContent = '반 코드나 번호를 찾을 수 없어요. 선생님께 물어보세요.'; return; }
    lsPut('dn-last', { code, num });
    await backend.studentLogin(studentEmail(code, num, k), pin);
    $('s-pin').value = '';
  } catch (err) { $('s-err').textContent = errText(err); }
  finally { $('s-go').disabled = false; }
});
$('t-login').addEventListener('click', async () => {
  $('t-err').textContent = '';
  try { await backend.teacherLogin(); } catch (err) { $('t-err').textContent = errText(err); }
});
document.querySelectorAll('.logout').forEach(b => b.addEventListener('click', async () => {
  await flushSave(); stopClass(); clearPageSubs(); await backend.logout();
}));

/* ================= student: bookshelf ================= */
let notebooks = [];
let coverColor = '#d8574a', newPaper = 'lined';
let studentInfo = null;

async function enterStudent(code, num) {
  mode = 'student'; classId = code;
  R = classRefs(code, 'n' + num);
  show('shelf'); $('shelf-loading').hidden = false; $('books').textContent = ''; $('shelf-empty').hidden = true;
  try { const d = await R.student.get(); studentInfo = d.exists ? d.data() : { num }; } catch (e) { studentInfo = { num }; }
  $('shelf-title').textContent = `${num}번 ${studentInfo.name || ''}의 공책장`;
  $('shelf-sub').textContent = `반 코드 ${code} · 과목마다 공책을 따로 만들어 차곡차곡 모아요`;
  $('store-note').textContent = '공책은 학교 서버에 저장되고, 선생님이 실시간으로 보고 피드백을 남길 수 있어요.';
  touchStudent({ updated: Date.now() });
  try { notebooks = await store.listNotebooks(); } catch (e) { notebooks = []; $('store-note').textContent = '공책을 불러오지 못했어요. ' + errText(e); }
  renderShelf();
}
function renderShelf() {
  const box = $('books'); box.textContent = '';
  $('shelf-loading').hidden = true;
  $('shelf-empty').hidden = notebooks.length > 0;
  const sorted = [...notebooks].sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
  for (const n of sorted) {
    const b = document.createElement('button');
    b.className = 'book'; b.style.background = n.color;
    const lab = document.createElement('div'); lab.className = 'label-box'; lab.textContent = n.name;
    const meta = document.createElement('div'); meta.className = 'meta';
    meta.textContent = `${n.pages || 1}쪽 · ${fmtDate(n.updated || n.created)}`;
    b.append(lab, meta);
    b.addEventListener('click', () => openStudentNotebook(n));
    box.append(b);
  }
}
function pressIn(group, btn) { group.forEach(b => b.setAttribute('aria-pressed', b === btn ? 'true' : 'false')); }
const coverBtns = [...document.querySelectorAll('.cover')];
coverBtns.forEach(b => b.addEventListener('click', () => { coverColor = b.dataset.c; pressIn(coverBtns, b); }));
const paperNewBtns = [...document.querySelectorAll('#papers-new button')];
paperNewBtns.forEach(b => b.addEventListener('click', () => { newPaper = b.dataset.p; pressIn(paperNewBtns, b); }));
document.querySelectorAll('#quick button').forEach(b => b.addEventListener('click', () => {
  $('nb-name').value = b.dataset.q + ' 공책';
  if (b.dataset.q === '수학') { newPaper = 'grid'; pressIn(paperNewBtns, paperNewBtns[1]); }
}));
$('new-form').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('nb-name').value.trim() || '새 공책';
  const now = today();
  const n = { id: newId(), name, color: coverColor, paper: newPaper, created: now, updated: now, pages: 1 };
  $('nb-create').disabled = true;
  try {
    await store.putNotebook(n);
    notebooks.push(n); $('nb-name').value = '';
    renderShelf(); openStudentNotebook(n);
  } catch (err) { $('store-note').textContent = '공책을 만들지 못했어요. ' + errText(err); }
  finally { $('nb-create').disabled = false; }
});

/* ================= teacher: classes ================= */
async function enterTeacherHome() {
  mode = 'teacher'; stopClass();
  show('classes');
  $('teacher-who').textContent = `${me.name || me.email} 선생님`;
  let list = [];
  try { list = (await db.collection('classes').where('teacherUid', '==', me.uid).get()).docs.map(d => ({ ...d.data(), id: d.id })); }
  catch (e) { $('class-err').textContent = '반 목록을 불러오지 못했어요. ' + errText(e); }
  list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const box = $('class-list'); box.textContent = '';
  $('class-empty').hidden = list.length > 0;
  for (const c of list) {
    const b = document.createElement('button'); b.className = 'class-item';
    const t = document.createElement('b'); t.textContent = c.name;
    const s = document.createElement('span'); s.className = 'small'; s.textContent = `반 코드 ${c.id}`;
    b.append(t, s); b.addEventListener('click', () => enterClass(c));
    box.append(b);
  }
}
$('class-form').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('class-name').value.trim();
  if (!name) { $('class-err').textContent = '반 이름을 써 주세요.'; return; }
  $('class-err').textContent = '';
  try {
    let code;
    for (let i = 0; i < 5; i++) { code = randCode(); if (!(await db.doc(`classes/${code}/public/roster`).get()).exists) break; }
    await db.doc(`classes/${code}`).set({ name, teacherUid: me.uid, created: today() });
    await db.doc(`classes/${code}/public/roster`).set({});
    $('class-name').value = '';
    enterClass({ id: code, name });
  } catch (err) { $('class-err').textContent = '반을 만들지 못했어요. ' + errText(err); }
});
$('to-classes').addEventListener('click', () => enterTeacherHome());

/* ================= teacher: class grid ================= */
let classUnsub = null, students = [], cards = {}, thumbSubs = {}, thumbData = {}, ageTimer = null, currentClass = null;
let seen = lsGet('dn-seen') || {};

function enterClass(c) {
  mode = 'teacher'; currentClass = c; classId = c.id;
  show('class');
  $('class-title').textContent = c.name;
  $('class-code').textContent = c.id;
  stopClass();
  $('kids').textContent = ''; cards = {};
  classUnsub = db.collection(`classes/${c.id}/students`).onSnapshot(snap => {
    students = snap.docs.map(d => ({ ...d.data(), id: d.id })).sort((a, b) => (a.num || 0) - (b.num || 0));
    renderClass(); renderPins();
  }, err => { $('kids-empty').hidden = false; $('kids-empty').textContent = '학생 목록을 불러오지 못했어요. ' + errText(err); });
  ageTimer = setInterval(() => students.forEach(updateCardText), 15000);
}
function stopClass() {
  if (classUnsub) classUnsub(); classUnsub = null;
  Object.values(thumbSubs).forEach(t => t.unsub()); thumbSubs = {};
  clearInterval(ageTimer);
}
function renderClass() {
  $('kids-empty').hidden = students.length > 0;
  const box = $('kids');
  for (const id of Object.keys(cards)) if (!students.some(s => s.id === id)) { cards[id].el.remove(); delete cards[id]; }
  for (const st of students) {
    let c = cards[st.id];
    if (!c) {
      const el = document.createElement('button'); el.className = 'kid';
      const cv = document.createElement('canvas');
      const info = document.createElement('div'); info.className = 'info';
      const name = document.createElement('div'); name.className = 'name';
      const where = document.createElement('div'); where.className = 'where';
      const when = document.createElement('div'); when.className = 'when';
      info.append(name, where, when); el.append(cv, info);
      el.addEventListener('click', () => openTeacherNotebook(students.find(s => s.id === st.id)));
      c = cards[st.id] = { el, cv, name, where, when };
    }
    box.append(c.el);
    updateCardText(st);
    // live preview: follow the page this student is on now
    const cur = st.current, key = cur ? cur.nb + '/' + cur.pg : '';
    const t = thumbSubs[st.id];
    if (!t || t.key !== key) {
      if (t) t.unsub();
      if (!cur) { thumbSubs[st.id] = { key, unsub: () => {} }; thumbData[st.id] = null; drawThumb(st.id); continue; }
      const refs = classRefs(classId, st.id);
      thumbSubs[st.id] = { key, unsub: refs.page(cur.nb, cur.pg).onSnapshot(d => { thumbData[st.id] = d.exists ? d.data() : null; drawThumb(st.id); }, () => {}) };
    }
  }
}
function updateCardText(st) {
  const c = cards[st.id]; if (!c) return;
  c.name.textContent = `${st.num}번 ${st.name || ''}`;
  c.where.textContent = st.current ? `${st.current.nbName} · ${st.current.n}쪽` : '아직 공책을 열지 않았어요';
  const on = st.updated && Date.now() - st.updated < LIVE_MS;
  c.when.className = 'when' + (on ? ' on' : '');
  c.when.textContent = on ? '지금 쓰는 중' : (st.updated ? ago(st.updated) : '');
  if (st.lastMsgAt && st.lastMsgAt > (seen[st.id] || 0)) {
    const p = document.createElement('span'); p.className = 'pill'; p.textContent = '새 메시지'; c.when.append(p);
  }
}
function drawThumb(sid) {
  const c = cards[sid]; if (!c) return;
  const cv = c.cv, r = cv.getBoundingClientRect(), k = window.devicePixelRatio || 1;
  cv.width = Math.round(r.width * k) || 400; cv.height = Math.round(r.height * k) || 300;
  const g = cv.getContext('2d'); g.clearRect(0, 0, cv.width, cv.height);
  const data = thumbData[sid];
  if (data && data.strokes) {
    const scale = cv.width / Math.max(data.w || 1000, 300);
    for (const o of data.strokes) drawStroke(g, decode(o), scale);
  }
  g.globalCompositeOperation = 'destination-over';
  g.fillStyle = cssVar('--paper'); g.fillRect(0, 0, cv.width, cv.height);
  g.globalCompositeOperation = 'source-over';
}

/* ---------- enrolment ---------- */
$('enroll-form').addEventListener('submit', async e => {
  e.preventDefault();
  const num = parseInt($('e-num').value, 10), name = $('e-name').value.trim();
  if (!num || num < 1 || num > 99) { $('e-err').textContent = '번호(1~99)를 써 주세요.'; return; }
  if (!name) { $('e-err').textContent = '이름이나 별명을 써 주세요.'; return; }
  if (students.some(s => s.num === num)) { $('e-err').textContent = `${num}번은 이미 등록되어 있어요. 비밀번호를 바꾸려면 아래 카드에서 "새 비밀번호"를 눌러요.`; return; }
  $('e-err').textContent = ''; $('e-go').disabled = true;
  try {
    await issueAccount(num, name, 0);
    $('e-num').value = ''; $('e-name').value = '';
    toast(`${num}번 ${name} 등록됨`);
    $('pins').hidden = false; $('toggle-pins').textContent = '숨기기';
  } catch (err) { $('e-err').textContent = '등록하지 못했어요. ' + errText(err); }
  finally { $('e-go').disabled = false; }
});
async function issueAccount(num, name, k) {
  const pin = randPin();
  const uid = await backend.createStudentAccount(studentEmail(classId, num, k), pin);
  const sid = 'n' + num;
  const prev = students.find(s => s.id === sid) || {};
  const { id, ...rest } = prev;
  await db.doc(`classes/${classId}/students/${sid}`).set({ ...rest, num, name, uid, pin, k, created: prev.created || Date.now() });
  const roster = await db.doc(`classes/${classId}/public/roster`).get();
  await db.doc(`classes/${classId}/public/roster`).set({ ...(roster.exists ? roster.data() : {}), [sid]: k });
}
function renderPins() {
  const box = $('pin-cards'); box.textContent = '';
  for (const st of students) {
    const d = document.createElement('div'); d.className = 'pin-card';
    const n = document.createElement('b'); n.textContent = `${st.num}번 ${st.name || ''}`;
    const cc = document.createElement('span'); cc.className = 'cc'; cc.textContent = `반 코드 ${classId}`;
    const p = document.createElement('span'); p.className = 'pin'; p.textContent = st.pin || '------';
    const again = document.createElement('button'); again.textContent = '새 비밀번호';
    again.addEventListener('click', async () => {
      if (again.dataset.armed !== '1') { again.dataset.armed = '1'; again.textContent = '한 번 더 누르면 바뀌어요'; setTimeout(() => { again.dataset.armed = ''; again.textContent = '새 비밀번호'; }, 3000); return; }
      again.disabled = true;
      try { await issueAccount(st.num, st.name, (st.k || 0) + 1); toast(`${st.num}번 비밀번호를 새로 만들었어요`); }
      catch (err) { toast('바꾸지 못했어요. ' + errText(err)); again.disabled = false; }
    });
    d.append(n, cc, p, again); box.append(d);
  }
}
$('toggle-pins').addEventListener('click', () => { const h = !$('pins').hidden; $('pins').hidden = h; $('toggle-pins').textContent = h ? '보기' : '숨기기'; });

/* ================= notebook (shared by student and teacher) ================= */
const sheet = $('sheet'), ink = $('ink'), live = $('live');
// desynchronized: Chrome on Android draws straight to screen, skipping a frame of delay.
// On Android a low-latency canvas must be opaque (a transparent one shows black), so the ink canvas
// paints the paper itself; finished strokes live on hidden layers and are composited on redraw.
const ctx = ink.getContext('2d', { desynchronized: true, alpha: false });
const lctx = live.getContext('2d');
const offBase = document.createElement('canvas'), bctx = offBase.getContext('2d');
const offEdit = document.createElement('canvas'), ectx = offEdit.getContext('2d');
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const statusText = $('status-text'), dot = $('dot'), hint = $('hint');

let mode = 'student';
let nb = null, pages = [], pi = 0;
let strokes = [];   // what this person is writing (student: own ink; teacher: red-pen feedback)
let base = [];      // read-only layer under it (teacher sees the student's ink)
let overlay = [];   // read-only layer over it (student sees the teacher's feedback)
let seal = '';
let ready = true;
let pageSubs = [];
let tNotebooks = [];
let color = '#1b1b1b', size = 4, tool = 'pen';
let palmBlock = true, penSeen = false;
let current = null, activeId = null, dpr = 1, pendingRedraw = false;

function clearPageSubs() { pageSubs.forEach(u => u()); pageSubs = []; }

async function openStudentNotebook(n) {
  await flushSave();
  mode = 'student'; nb = n;
  setEditorChrome();
  show('book');
  $('book-name').textContent = n.name;
  setSave('불러오는 중…');
  let list = [];
  try { list = await store.listPages(n.id); } catch (e) { setSave('불러오지 못했어요', true); }
  if (!list.length) list = [{ id: newId(), n: 1, paper: n.paper || 'lined', created: n.created, strokes: [] }];
  pages = list;
  resize();
  showPage(pages.length - 1);
  setSave('저장됨');
}
async function openTeacherNotebook(st) {
  if (!st) return;
  mode = 'teacher';
  seen[st.id] = Date.now(); lsPut('dn-seen', seen); updateCardText(st);
  R = classRefs(classId, st.id);
  setEditorChrome();
  show('book');
  $('book-name').textContent = `${st.num}번 ${st.name || ''}`;
  setSave('불러오는 중…');
  try { tNotebooks = (await R.books.get()).docs.map(d => ({ ...d.data(), id: d.id })); } catch (e) { tNotebooks = []; }
  const sel = $('t-notebook'); sel.textContent = '';
  for (const n of tNotebooks) { const o = document.createElement('option'); o.value = n.id; o.textContent = n.name; sel.append(o); }
  const cur = st.current;
  const first = (cur && tNotebooks.find(n => n.id === cur.nb)) || tNotebooks[0];
  if (!first) { pages = []; nb = null; resize(); showEmptyTeacher(); return; }
  sel.value = first.id;
  await loadTeacherNotebook(first, cur && cur.nb === first.id ? cur.pg : null);
}
async function loadTeacherNotebook(n, pgId) {
  await flushSave();
  nb = n;
  try { pages = (await R.pages(n.id).orderBy('n').get()).docs.map(d => ({ ...d.data(), id: d.id })); } catch (e) { pages = []; }
  resize();
  if (!pages.length) { showEmptyTeacher(); return; }
  const i = pages.findIndex(p => p.id === pgId);
  showPage(i >= 0 ? i : pages.length - 1);
}
function showEmptyTeacher() {
  clearPageSubs(); strokes = []; base = []; overlay = []; seal = ''; ready = false;
  hint.hidden = false; hint.textContent = '이 학생은 아직 쓴 페이지가 없어요.';
  $('pageno').textContent = '0쪽'; $('prev').disabled = $('next').disabled = true;
  $('datestamp').textContent = ''; renderSeal(); redraw(); setSave('');
}
$('t-notebook').addEventListener('change', e => { const n = tNotebooks.find(x => x.id === e.target.value); if (n) loadTeacherNotebook(n, null); });

function setEditorChrome() {
  const t = mode === 'teacher';
  $('back').textContent = t ? '← 우리 반' : '← 공책장';
  $('teacher-bar').hidden = !t;
  $('add-page').hidden = t;
  $('paper').hidden = t;
  $('chat').hidden = true;
  $('chat-title').textContent = t ? '학생과 이야기' : '선생님과 이야기';
  hint.textContent = '오늘 배운 내용을 써 보세요.';
  const pick = t ? $('c-red') : $('c-black');
  color = pick.dataset.color; pressIn(swatches, pick); setTool('pen');
}

function showPage(i) {
  clearPageSubs();
  pi = Math.max(0, Math.min(i, pages.length - 1));
  const pg = pages[pi];
  sheet.className = pg.paper || '';
  $('paper').textContent = PAPERS[pg.paper || ''];
  $('datestamp').textContent = fmtDate(pg.created);
  $('pageno').textContent = `${pi + 1} / ${pages.length}쪽`;
  $('prev').disabled = pi === 0;
  $('next').disabled = pi === pages.length - 1;
  overlay = []; base = []; seal = ''; msgs = []; chatSeenCount = 0; renderChat();
  if (mode === 'student') {
    if (!pg._dec) pg._dec = (pg.strokes || []).map(decode);
    strokes = pg._dec; ready = true;
    hint.hidden = strokes.length > 0;
    touchStudent({ current: { nb: nb.id, nbName: nb.name, pg: pg.id, n: pg.n }, updated: Date.now() });
    let first = true, lastUpdated = null;
    pageSubs.push(R.fb(nb.id, pg.id).onSnapshot(d => {
      const data = d.exists ? d.data() : {};
      if (!first && data.updated === lastUpdated) return;
      overlay = (data.strokes || []).map(decode); seal = data.seal || '';
      renderSeal(); safeRedraw();
      if (!first && !d.metadata.hasPendingWrites) toast('선생님이 공책에 피드백을 남겼어요');
      first = false; lastUpdated = data.updated;
    }, () => {}));
  } else {
    hint.hidden = true;
    base = (pg.strokes || []).map(decode);
    strokes = []; ready = false;
    // the student keeps writing: follow their ink live
    pageSubs.push(R.page(nb.id, pg.id).onSnapshot(d => {
      if (!d.exists) return;
      const data = d.data();
      base = (data.strokes || []).map(decode);
      if (data.paper !== undefined && data.paper !== pg.paper) { pg.paper = data.paper; sheet.className = pg.paper; }
      safeRedraw();
    }, () => {}));
    R.fb(nb.id, pg.id).get().then(d => {
      if (pages[pi] !== pg) return;
      const data = d.exists ? d.data() : {};
      strokes = (data.strokes || []).map(decode); seal = data.seal || '';
      ready = true; renderSeal(); redraw();
    }).catch(() => { ready = true; });
  }
  subscribeChat(pg);
  renderSeal();
  redraw();
}
function safeRedraw() { if (current) pendingRedraw = true; else redraw(); }

function renderSeal() {
  const el = $('seal'); el.hidden = !seal; el.textContent = seal;
  document.querySelectorAll('.seal-btn').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.seal === seal)));
}
document.querySelectorAll('.seal-btn').forEach(b => b.addEventListener('click', () => {
  if (mode !== 'teacher' || !ready) return;
  seal = seal === b.dataset.seal ? '' : b.dataset.seal;
  renderSeal(); markDirty();
}));

$('prev').addEventListener('click', async () => { await flushSave(); showPage(pi - 1); });
$('next').addEventListener('click', async () => { await flushSave(); showPage(pi + 1); });
$('add-page').addEventListener('click', async () => {
  await flushSave();
  const last = pages[pages.length - 1];
  const pg = { id: newId(), n: last.n + 1, paper: last.paper, created: today(), strokes: [], _dec: [] };
  pages.push(pg);
  showPage(pages.length - 1);
  markDirty();
});
$('back').addEventListener('click', async () => {
  await flushSave(); clearPageSubs(); $('chat').hidden = true;
  if (mode === 'teacher') { show('class'); students.forEach(updateCardText); Object.keys(cards).forEach(drawThumb); }
  else { show('shelf'); renderShelf(); }
});

/* ---------- chat ---------- */
let msgs = [], chatSeenCount = 0;
function subscribeChat(pg) {
  let first = true;
  pageSubs.push(R.chat(nb.id, pg.id).orderBy('at').onSnapshot(snap => {
    const before = msgs.length;
    msgs = snap.docs.map(d => d.data());
    const mine = mode === 'teacher' ? 't' : 's';
    const fresh = msgs.slice(before).filter(m => m.from !== mine);
    if (!first && fresh.length) toast(mode === 'teacher' ? '학생이 메시지를 보냈어요' : '선생님이 메시지를 보냈어요');
    if (first) chatSeenCount = msgs.filter(m => m.from === mine).length;
    first = false;
    renderChat();
  }, () => {}));
}
function renderChat() {
  const box = $('msgs'); box.textContent = '';
  const mine = mode === 'teacher' ? 't' : 's';
  if (!msgs.length) { const p = document.createElement('p'); p.className = 'small'; p.textContent = '이 페이지에 대해 이야기를 나눠요.'; box.append(p); }
  for (const m of msgs) {
    const d = document.createElement('div'); d.className = 'msg ' + (m.from === mine ? 'mine' : 'theirs');
    d.textContent = m.text;
    const t = document.createElement('time'); t.textContent = (m.from === 't' ? '선생님 · ' : '학생 · ') + fmtTime(m.at);
    d.append(t); box.append(d);
  }
  box.scrollTop = box.scrollHeight;
  if (!$('chat').hidden) chatSeenCount = msgs.length;
  const unread = Math.max(0, msgs.length - chatSeenCount);
  const badge = $('chat-badge'); badge.hidden = unread === 0; badge.textContent = unread;
}
$('chat-open').addEventListener('click', () => { $('chat').hidden = !$('chat').hidden; chatSeenCount = msgs.length; renderChat(); if (!$('chat').hidden) $('chat-input').focus(); });
$('chat-close').addEventListener('click', () => { $('chat').hidden = true; });
$('chat-form').addEventListener('submit', async e => {
  e.preventDefault();
  const text = $('chat-input').value.trim();
  if (!text || !nb || !pages[pi]) return;
  $('chat-input').value = '';
  const at = Date.now();
  try {
    await R.chat(nb.id, pages[pi].id).add({ from: mode === 'teacher' ? 't' : 's', text, at });
    if (mode === 'student') touchStudent({ lastMsgAt: at, updated: at });
  } catch (err) { toast('메시지를 보내지 못했어요'); $('chat-input').value = text; }
});

/* ---------- autosave ---------- */
let dirty = false, saveTimer = null, saving = Promise.resolve();
function setSave(text, err) { const el = $('save'); el.textContent = text; el.classList.toggle('err', !!err); }
function markDirty() { dirty = true; setSave('저장 중…'); clearTimeout(saveTimer); saveTimer = setTimeout(flushSave, 1200); }
function flushSave() {
  clearTimeout(saveTimer); saveTimer = null;
  if (!dirty || !nb || !pages[pi]) return saving;
  dirty = false;
  const pg = pages[pi], book = nb, enc = strokes.map(encode), refs = R, who = mode;
  const r = sheet.getBoundingClientRect();
  let job;
  if (who === 'teacher') {
    const body = { strokes: enc, seal, updated: Date.now() };
    job = async () => { await refs.fb(book.id, pg.id).set(body); return JSON.stringify(body).length; };
  } else {
    const body = { id: pg.id, n: pg.n, paper: pg.paper, created: pg.created, strokes: enc, w: Math.round(r.width), h: Math.round(r.height) };
    book.updated = today(); book.pages = pages.length;
    job = async () => {
      await store.putPage(book.id, body);
      await store.putNotebook(book);
      touchStudent({ current: { nb: book.id, nbName: book.name, pg: pg.id, n: pg.n }, updated: Date.now() });
      return JSON.stringify(body).length;
    };
  }
  // one write at a time: chain after the previous save
  saving = saving.then(async () => {
    try {
      const bytes = await job();
      if (bytes > PAGE_LIMIT * 0.85) setSave('이 페이지가 거의 찼어요. 새 페이지에 이어 써 주세요', true);
      else setSave(who === 'teacher' ? '피드백 저장됨' : '저장됨');
    } catch (e) {
      dirty = true;
      setSave('저장하지 못했어요. 잠시 뒤 다시 시도해요', true);
      clearTimeout(saveTimer); saveTimer = setTimeout(flushSave, 4000);
    }
  });
  return saving;
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });

/* ---------- drawing ---------- */
function resize() {
  dpr = window.devicePixelRatio || 1;
  const r = sheet.getBoundingClientRect();
  if (!r.width) return;
  for (const c of [ink, live, offBase, offEdit]) { c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); }
  redraw();
}
function widthFor(s, p) {
  if (s.hl) return s.size * 3 + 10;
  const pr = (p && p > 0) ? p : 0.5;
  return s.erase ? s.size * 4 : s.size * (0.35 + pr * 1.3);
}
function inkMode(c, s) {
  if (s.erase && c === ctx) { c.globalCompositeOperation = 'source-over'; return cssVar('--paper'); }
  c.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over';
  return s.color;
}
function drawHighlight(c, s, k) {
  const pts = s.pts; if (!pts.length) return;
  c.save();
  c.globalCompositeOperation = c === lctx ? 'source-over' : 'multiply';
  c.globalAlpha = 0.38; c.strokeStyle = s.color; c.lineCap = 'round'; c.lineJoin = 'round';
  c.lineWidth = widthFor(s) * k;
  c.beginPath(); c.moveTo(pts[0].x * k, pts[0].y * k);
  if (pts.length === 1) c.lineTo(pts[0].x * k + 0.1, pts[0].y * k);
  for (let i = 1; i < pts.length; i++) c.lineTo(pts[i].x * k, pts[i].y * k);
  c.stroke(); c.restore();
}
function seg(c, s, a, b, k = dpr) {
  c.strokeStyle = inkMode(c, s); c.lineCap = 'round'; c.lineJoin = 'round';
  c.lineWidth = widthFor(s, (a.p + b.p) / 2) * k;
  c.beginPath(); c.moveTo(a.x * k, a.y * k); c.lineTo(b.x * k, b.y * k); c.stroke();
}
function dotAt(c, s, a, k = dpr) {
  c.fillStyle = inkMode(c, s);
  c.beginPath(); c.arc(a.x * k, a.y * k, widthFor(s, a.p) * k / 2, 0, Math.PI * 2); c.fill();
}
function drawStroke(c, s, k = dpr) {
  if (s.hl) { drawHighlight(c, s, k); return; }
  const pts = s.pts; if (!pts.length) return;
  if (pts.length === 1) { dotAt(c, s, pts[0], k); return; }
  for (let i = 1; i < pts.length; i++) seg(c, s, pts[i - 1], pts[i], k);
}
function paintPaper() {
  const W = ink.width, H = ink.height, kind = (pages[pi] && pages[pi].paper) || '';
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = cssVar('--paper'); ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = cssVar('--rule');
  const step = 48 * dpr, t = Math.max(1, Math.round(dpr));
  if (kind === 'lined') {
    for (let y = 23 * dpr; y < H; y += step) ctx.fillRect(0, Math.round(y), W, t);
    ctx.fillStyle = cssVar('--margin'); ctx.fillRect(Math.round(63 * dpr), 0, Math.round(2 * dpr), H);
  } else if (kind === 'grid') {
    for (let y = 47 * dpr; y < H; y += step) ctx.fillRect(0, Math.round(y), W, t);
    for (let x = 47 * dpr; x < W; x += step) ctx.fillRect(Math.round(x), 0, t, H);
  }
}
function redraw() {
  pendingRedraw = false;
  bctx.clearRect(0, 0, offBase.width, offBase.height);
  for (const s of base) drawStroke(bctx, s);
  bctx.globalCompositeOperation = 'source-over';
  ectx.clearRect(0, 0, offEdit.width, offEdit.height);
  for (const s of strokes) drawStroke(ectx, s);
  ectx.globalCompositeOperation = 'source-over';
  paintPaper();
  if (base.length) ctx.drawImage(offBase, 0, 0);
  ctx.drawImage(offEdit, 0, 0);
  for (const s of overlay) drawStroke(ctx, s);
  ctx.globalCompositeOperation = 'source-over';
}
function pt(e) {
  const r = sheet.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top, p: e.pointerType === 'pen' ? e.pressure : 0.5 };
}
function setStatus(type) {
  if (type === 'pen') { dot.classList.add('pen'); statusText.textContent = palmBlock ? 'S펜 인식됨 · 손 터치 무시 중' : 'S펜 인식됨'; }
  else if (type === 'touch') statusText.textContent = '손가락으로 쓰는 중';
  else statusText.textContent = '마우스로 쓰는 중';
}
const allowed = e => ready && !!pages[pi] && !(e.pointerType === 'touch' && palmBlock && penSeen);
function clearLive() { lctx.clearRect(0, 0, live.width, live.height); }
function renderLive() { clearLive(); drawStroke(lctx, current); lctx.globalCompositeOperation = 'source-over'; }

// straight-line helper: draw, then hold the pen still → the stroke becomes a straight line
const HOLD_MS = 500, HOLD_SLOP = 5, MIN_LEN = 60, AXIS_DEG = 7;
let holdTimer = null, holdAnchor = null;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function aim(a, b) {
  const deg = Math.abs(Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI);
  if (deg < AXIS_DEG || deg > 180 - AXIS_DEG) return { x: b.x, y: a.y, p: b.p };
  if (Math.abs(deg - 90) < AXIS_DEG) return { x: a.x, y: b.y, p: b.p };
  return b;
}
function trySnap() {
  holdTimer = null;
  if (!current || current.snap || current.erase) return;
  const pts = current.pts, a = pts[0], b = pts[pts.length - 1];
  if (dist(a, b) < MIN_LEN) return;
  const avgP = pts.reduce((t, q) => t + q.p, 0) / pts.length;
  if (!current.live) { strokes.pop(); redraw(); current.live = true; }
  current.snap = true;
  current.pts = [{ x: a.x, y: a.y, p: avgP }, { ...aim(a, b), p: avgP }];
  renderLive();
  statusText.textContent = '직선으로 바꿨어요 · 펜을 떼면 확정돼요';
}
function armHold(p) {
  if (current.erase || current.snap) return;
  if (holdAnchor && dist(p, holdAnchor) < HOLD_SLOP) return;
  holdAnchor = p; clearTimeout(holdTimer); holdTimer = setTimeout(trySnap, HOLD_MS);
}

sheet.addEventListener('pointerdown', e => {
  if (e.pointerType === 'pen') {
    penSeen = true;
    if (current && current.type === 'touch' && palmBlock) {
      if (!current.live) { strokes.pop(); redraw(); }
      clearTimeout(holdTimer); clearLive(); current = null; activeId = null;
    }
  }
  if (!allowed(e) || current) return;
  e.preventDefault();
  sheet.setPointerCapture(e.pointerId);
  const erase = tool === 'eraser' || (e.pointerType === 'pen' && (e.buttons & 2 || e.buttons & 32));
  const hl = !erase && tool === 'hl';
  current = { pts: [pt(e)], color, size, erase, hl, live: hl, snap: false, type: e.pointerType };
  activeId = e.pointerId; holdAnchor = current.pts[0];
  if (current.live) renderLive();
  else { strokes.push(current); dotAt(ctx, current, current.pts[0]); }
  hint.hidden = true;
  setStatus(e.pointerType);
});
sheet.addEventListener('pointermove', e => {
  if (!current || e.pointerId !== activeId) return;
  e.preventDefault();
  if (current.snap) {
    const a = current.pts[0];
    current.pts[1] = { ...aim(a, pt(e)), p: a.p };
    renderLive(); return;
  }
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ce of (evs.length ? evs : [e])) {
    const p = pt(ce), last = current.pts[current.pts.length - 1];
    if (Math.abs(p.x - last.x) + Math.abs(p.y - last.y) < 0.6) continue;
    current.pts.push(p);
    if (!current.live) seg(ctx, current, last, p);
  }
  if (current.live) renderLive();
  else {
    clearLive();
    if (!current.erase && e.getPredictedEvents) {
      let prev = current.pts[current.pts.length - 1];
      for (const pe of e.getPredictedEvents().slice(0, 3)) { const p = pt(pe); seg(lctx, current, prev, p); prev = p; }
    }
  }
  armHold(current.pts[current.pts.length - 1]);
});
function end(e) {
  if (!current || e.pointerId !== activeId) return;
  clearTimeout(holdTimer); holdTimer = null; holdAnchor = null;
  clearLive();
  if (current.live) { strokes.push(current); drawStroke(ctx, current); }
  ctx.globalCompositeOperation = 'source-over';
  const wasErase = current.erase, wasSnap = current.snap, type = current.type;
  current = null; activeId = null;
  if (wasErase || pendingRedraw || overlay.length) redraw();
  if (wasSnap) setStatus(type);
  markDirty();
}
sheet.addEventListener('pointerup', end);
sheet.addEventListener('pointercancel', end);
sheet.addEventListener('contextmenu', e => e.preventDefault());

/* ---------- toolbar ---------- */
const swatches = [...document.querySelectorAll('.swatch')];
swatches.forEach(b => b.addEventListener('click', () => { color = b.dataset.color; pressIn(swatches, b); if (tool === 'eraser') setTool('pen'); }));
const sizes = [...document.querySelectorAll('.size')];
const range = $('size-range');
sizes.forEach(b => b.addEventListener('click', () => { size = +b.dataset.size; range.value = size; pressIn(sizes, b); }));
range.addEventListener('input', () => { size = +range.value; pressIn(sizes, null); });
const toolBtns = { pen: $('tool-pen'), hl: $('tool-hl'), eraser: $('tool-eraser') };
function setTool(t) { tool = t; pressIn(Object.values(toolBtns), toolBtns[t]); }
toolBtns.pen.addEventListener('click', () => setTool('pen'));
toolBtns.eraser.addEventListener('click', () => setTool('eraser'));
toolBtns.hl.addEventListener('click', () => {
  setTool('hl');
  if (color === '#1b1b1b') { const y = $('c-yellow'); color = y.dataset.color; pressIn(swatches, y); }
});
$('undo').addEventListener('click', () => { if (ready && strokes.length) { strokes.pop(); redraw(); markDirty(); } });
const clearBtn = $('clear');
let armed = null;
clearBtn.addEventListener('click', () => {
  if (!ready) return;
  if (!armed) {
    clearBtn.textContent = '한 번 더 누르면 지워져요';
    armed = setTimeout(() => { armed = null; clearBtn.textContent = '전체 지우기'; }, 2500);
    return;
  }
  clearTimeout(armed); armed = null; clearBtn.textContent = '전체 지우기';
  strokes.length = 0; redraw(); if (mode === 'student') hint.hidden = false; markDirty();
});
$('paper').addEventListener('click', () => {
  const pg = pages[pi]; if (!pg || mode !== 'student') return;
  const i = (PAPER_ORDER.indexOf(pg.paper || '') + 1) % PAPER_ORDER.length;
  pg.paper = PAPER_ORDER[i];
  sheet.className = pg.paper; $('paper').textContent = PAPERS[pg.paper];
  redraw(); markDirty();
});
const palmBtn = $('palm');
palmBtn.addEventListener('click', () => {
  palmBlock = !palmBlock; palmBtn.setAttribute('aria-pressed', String(palmBlock));
  statusText.textContent = palmBlock ? '손바닥 차단 켜짐' : '손바닥 차단 꺼짐 · 손가락도 써져요';
});
const fsBtn = $('fs');
const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement;
fsBtn.addEventListener('click', () => {
  const root = document.documentElement;
  try {
    const r = fsEl()
      ? (document.exitFullscreen || document.webkitExitFullscreen).call(document)
      : (root.requestFullscreen || root.webkitRequestFullscreen).call(root, { navigationUI: 'hide' });
    Promise.resolve(r).catch(() => { statusText.textContent = '이 화면에서는 전체 화면을 쓸 수 없어요'; });
  } catch (err) { statusText.textContent = '이 화면에서는 전체 화면을 쓸 수 없어요'; }
});
const onFs = () => { fsBtn.textContent = fsEl() ? '전체 화면 끝내기' : '전체 화면'; setTimeout(resize, 100); };
document.addEventListener('fullscreenchange', onFs);
document.addEventListener('webkitfullscreenchange', onFs);
window.addEventListener('resize', () => { resize(); if (!$('class').hidden) Object.keys(cards).forEach(drawThumb); });

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js').catch(() => {});
