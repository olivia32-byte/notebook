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
function encodeCached(s) { return s === current ? encode(s) : (s._enc || (s._enc = encode(s))); }
function decode(o) {
  const n = o.d ? o.d.split(',').map(Number) : []; const pts = [];
  let X = 0, Y = 0, P = 0;
  for (let i = 0; i + 2 < n.length; i += 3) { X += n[i]; Y += n[i + 1]; P += n[i + 2]; pts.push({ x: X / 2, y: Y / 2, p: P / 20 }); }
  return { pts, color: o.c, size: o.s, erase: o.t === 'e', hl: o.t === 'h', _enc: o };
}
// decode only strokes added since the last copy (the student usually just added a few)
function decodeMore(prev, raw) {
  if (prev.length && raw.length >= prev.length && prev[prev.length - 1]._enc && raw[prev.length - 1] && prev[prev.length - 1]._enc.d === raw[prev.length - 1].d)
    return prev.concat(raw.slice(prev.length).map(decode));
  return raw.map(decode);
}
const sizeOf = enc => enc.reduce((t, e) => t + e.d.length + 40, 200);

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
  // later saves only touch the page count and date, so a name the teacher changed is not written back over
  async touchNotebook(nb) {
    try { await R.books.doc(nb.id).update({ pages: nb.pages, updated: nb.updated }); }
    catch (e) { if (e && e.code === 'not-found') await store.putNotebook(nb); else throw e; }
  },
  async listPages(nbId) { const s = await R.pages(nbId).orderBy('n').get(); return s.docs.map(d => ({ ...d.data(), id: d.id })); },
  async putPage(nbId, pg) { const { id, ...b } = pg; await R.page(nbId, id).set(b); },
};

// the student's live status for the teacher's grid; students may only change these fields
let studentWrite = Promise.resolve();
function touchStudent(patch) {
  if (!R || mode !== 'student' || ownBook) return;
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
  await flushSave(); stopClass(); stopNotices(); clearPageSubs(); await backend.logout();
}));

/* ================= student: bookshelf ================= */
let notebooks = [];
let coverColor = '#d8574a', newPaper = 'lined';
let studentInfo = null;

// 선생님 공책장: the same shelf and editor as a student's, stored under teachers/<uid>, seen by nobody else
let ownBook = false;
function ownRefs(uid) {
  const books = db.collection(`teachers/${uid}/notebooks`);
  const page = (nb, pg) => books.doc(nb).collection('pages').doc(pg);
  return {
    student: null, books, page,
    pages: nb => books.doc(nb).collection('pages'),
    fb: (nb, pg) => page(nb, pg).collection('notes').doc('teacher'),
    chat: (nb, pg) => page(nb, pg).collection('chat'),
  };
}
function setShelfChrome() {
  document.querySelectorAll('#shelf .logout').forEach(b => { b.hidden = ownBook; });
  $('shelf-home').hidden = !ownBook;
  $('chat-open').hidden = ownBook;
}
async function enterOwnShelf() {
  stopClass(); stopNotices();
  mode = 'student'; ownBook = true; studentInfo = null;
  R = ownRefs(me.uid);
  setShelfChrome();
  show('shelf'); $('shelf-loading').hidden = false; $('books').textContent = ''; $('shelf-empty').hidden = true;
  $('shelf-title').textContent = '선생님 공책장';
  $('shelf-sub').textContent = '수업 준비, 개인 메모, 필기 예시를 모아요. 선생님만 볼 수 있어요.';
  $('store-note').textContent = '이 공책은 학생에게 보이지 않아요. 보여 줄 때는 교실 TV로 화면을 미러링해 주세요.';
  try { notebooks = await store.listNotebooks(); } catch (e) { notebooks = []; $('store-note').textContent = '공책을 불러오지 못했어요. ' + errText(e); }
  renderShelf();
}
$('own-shelf').addEventListener('click', () => enterOwnShelf());
$('shelf-home').addEventListener('click', async () => { deleting = false; $('del-mode').textContent = '공책 지우기'; $('del-mode').setAttribute('aria-pressed', 'false'); ownBook = false; setShelfChrome(); await enterTeacherHome(); });
async function enterStudent(code, num) {
  mode = 'student'; classId = code; ownBook = false; setShelfChrome();
  R = classRefs(code, 'n' + num);
  show('shelf'); $('shelf-loading').hidden = false; $('books').textContent = ''; $('shelf-empty').hidden = true;
  try { const d = await R.student.get(); studentInfo = d.exists ? d.data() : { num }; } catch (e) { studentInfo = { num }; }
  $('shelf-title').textContent = `${num}번 ${studentInfo.name || ''}의 공책장`;
  $('shelf-sub').textContent = `반 코드 ${code} · 과목마다 공책을 따로 만들어 차곡차곡 모아요`;
  $('store-note').textContent = '공책은 학교 서버에 저장되고, 선생님이 실시간으로 보고 피드백을 남길 수 있어요.';
  touchStudent({ updated: Date.now() });
  try { notebooks = await store.listNotebooks(); } catch (e) { notebooks = []; $('store-note').textContent = '공책을 불러오지 못했어요. ' + errText(e); }
  renderShelf();
  startNotices();
}
let deleting = false;
$('del-mode').addEventListener('click', () => {
  deleting = !deleting;
  $('del-mode').textContent = deleting ? '지우기 끝내기' : '공책 지우기';
  $('del-mode').setAttribute('aria-pressed', String(deleting));
  renderShelf();
});
async function deleteNotebook(n, b, tag) {
  b.disabled = true; tag.textContent = '지우는 중…';
  try {
    // pages, their background pictures, then the notebook itself
    const all = await R.pages(n.id).get();
    for (const d of all.docs) await R.pages(n.id).doc(d.id).delete();
    await R.books.doc(n.id).delete();
    notebooks = notebooks.filter(x => x.id !== n.id);
    if (studentInfo && studentInfo.current && studentInfo.current.nb === n.id) touchStudent({ current: null, updated: Date.now() });
    toast(`"${n.name}"을(를) 지웠어요`);
    renderShelf();
  } catch (err) { b.disabled = false; tag.textContent = '지우지 못했어요'; }
}
function renderShelf() {
  renderInbox();
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
    const news = !ownBook && noticeList.filter(x => x.nb === n.id && isUnseen(x));
    if (news && news.length) {
      const dot = document.createElement('div'); dot.className = 'news-tag';
      dot.textContent = news.some(x => x.kind === 'chat') ? '새 메시지' : '새 피드백'; b.append(dot);
    }
    if (deleting) {
      b.classList.add('deleting');
      const tag = document.createElement('div'); tag.className = 'del-tag'; tag.textContent = '눌러서 지우기';
      b.append(tag);
      b.addEventListener('click', () => {
        if (b.dataset.armed !== '1') { b.dataset.armed = '1'; tag.textContent = '한 번 더 누르면 지워져요'; setTimeout(() => { b.dataset.armed = ''; tag.textContent = '눌러서 지우기'; }, 3000); return; }
        deleteNotebook(n, b, tag);
      });
    } else b.addEventListener('click', () => openStudentNotebook(n));
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
  mode = 'teacher'; stopClass(); stopNotices(); ownBook = false; setShelfChrome();
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
  $('kids').textContent = ''; cards = {}; students = []; layoutCount = -1; browse = null; colBooks = {}; $('col-name').textContent = ''; setClassTab(false);
  classUnsub = db.collection(`classes/${c.id}/students`).onSnapshot(snap => {
    students = snap.docs.map(d => ({ ...d.data(), id: d.id })).sort((a, b) => (a.num || 0) - (b.num || 0));
    renderClass(); renderPins(); renderHandoutKids(); syncMembers();
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
  const n = students.length, relayout = n !== layoutCount;
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
      el.addEventListener('click', () => { browse = null; openTeacherNotebook(students.find(s => s.id === st.id)); });
      c = cards[st.id] = { el, cv, name, where, when };
    }
    box.append(c.el);
    updateCardText(st);
    c.st = st;
    // live preview: follow the page this student is on now
    const cur = st.current, key = cur ? cur.nb + '/' + cur.pg : '';
    const t = thumbSubs[st.id];
    if (!t || t.key !== key) {
      if (t) t.unsub();
      if (!cur) { thumbSubs[st.id] = { key, unsub: () => {} }; thumbData[st.id] = null; drawThumb(st.id); continue; }
      const refs = classRefs(classId, st.id);
      thumbSubs[st.id] = { key, unsub: refs.page(cur.nb, cur.pg).onSnapshot(d => { thumbData[st.id] = d.exists ? d.data() : null; thumbLater(st.id); }, () => {}) };
    }
  }
  if (relayout) layoutKids();
}
// Fit every student on one screen: try each column count and keep the one that gives the biggest page.
let layoutCount = -1;
function layoutKids() {
  if (colMode) { layoutCount = students.length; layoutCollection(); return; }
  // remember the count only once the grid really got laid out, so a later update tries again
  if (fitGrid($('kids'), students.length)) { layoutCount = students.length; Object.keys(cards).forEach(drawThumb); }
  else layoutCount = -1;
}
function fitGrid(box, n) {
  if (!n || $('class').hidden || box.hidden) return false;
  const GAP = 2, top = $('class').querySelector('.topbar'), bar = $('col-bar');
  const W = box.clientWidth - GAP * 2;
  if (W < 50) return false;
  const H = Math.max(240, $('class').clientHeight - top.offsetHeight - (bar.hidden ? 0 : bar.offsetHeight) - GAP * 2);
  let best = { s: 0, cols: 1, ch: H, cw: W };
  if (boardBig) {
    // 크게 보기: bigger tiles, scroll down for the rest of the class
    const cols = Math.max(1, Math.min(n, Math.round(W / 380)));
    const cw = (W - (cols - 1) * GAP) / cols, info = 46;
    best = { cols, cw, ch: (boardZoom ? cw * 0.75 : cw * PAGE_H / PAGE_W) + info };
    box.style.setProperty('--cols', best.cols);
    box.style.setProperty('--rowh', Math.floor(best.ch) + 'px');
    box.classList.remove('tiny');
    return true;
  }
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cw = (W - (cols - 1) * GAP) / cols, ch = (H - (rows - 1) * GAP) / rows;
    const s = Math.min(cw / PAGE_W, ch / PAGE_H);
    if (s > best.s) best = { s, cols, ch, cw };
  }
  box.style.setProperty('--cols', best.cols);
  box.style.setProperty('--rowh', Math.floor(best.ch) + 'px');
  box.classList.toggle('tiny', best.cw < 170);
  return true;
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
const thumbTimers = {};
function thumbLater(sid) {
  if (thumbTimers[sid]) return;
  thumbTimers[sid] = setTimeout(() => { thumbTimers[sid] = null; if (!$('class').hidden) drawThumb(sid); }, 3000);
  if (!thumbTimers[sid + ':first']) { thumbTimers[sid + ':first'] = 1; drawThumb(sid); }
}
function drawThumb(sid) {
  const c = cards[sid]; if (c) paintThumb(c.cv, c.el, thumbData[sid]);
}
let boardZoom = lsGet('dn-board-zoom') !== false, boardBig = lsGet('dn-board-big') === true;
function paintThumb(cv, el, data) {
  const r = cv.getBoundingClientRect(), k = window.devicePixelRatio || 1;
  const w = Math.round(r.width * k) || 300, h = Math.round(r.height * k) || 400;
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const g = cv.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = cssVar('--paper'); g.fillRect(0, 0, w, h);
  const infoH = el.querySelector('.info').offsetHeight * k;
  const availH = Math.max(h - infoH, h * 0.6);
  const strokes = data && data.strokes ? data.strokes.map(decode) : [];
  // what part of the page to show: the whole page, or (쓴 부분 확대) just the area with writing
  let bx = 0, by = 0, bw = PAGE_W, bh = PAGE_H;
  if (boardZoom && strokes.length) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const st of strokes) if (!st.erase) for (const q of st.pts) { if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y; }
    if (x1 >= x0) {
      const pad = 12, minW = 260, minH = 200;
      x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
      if (x1 - x0 < minW) { const c = (x0 + x1) / 2; x0 = c - minW / 2; x1 = c + minW / 2; }
      if (y1 - y0 < minH) { y1 = y0 + minH; }
      bx = Math.max(0, x0); by = Math.max(0, y0); bw = Math.min(PAGE_W, x1) - bx; bh = Math.min(PAGE_H, y1) - by;
    }
  }
  const full = Math.min(w / PAGE_W, availH / PAGE_H);
  // fill the tile across with no side margins; if the writing is then taller than the tile,
  // show the part around the newest stroke (where the student is writing now)
  let s, oy;
  if (boardZoom) {
    s = w / bw;
    const contentH = bh * s;
    if (contentH <= availH) oy = -by * s;
    else {
      const last = [...strokes].reverse().find(st => !st.erase && st.pts.length);
      const ly = last ? last.pts.reduce((t, q) => t + q.y, 0) / last.pts.length : by;
      const top = Math.min(Math.max(ly * s - availH * 0.6, by * s), (by + bh) * s - availH);
      oy = -top;
    }
  } else { s = full; oy = -by * s; }
  const ox = (w - bw * s) / 2 - bx * s;
  if (!boardZoom && (w - PAGE_W * s) / 2 > 2) { g.strokeStyle = cssVar('--line'); g.lineWidth = 1; g.strokeRect(ox + 0.5, 0.5, PAGE_W * s - 1, PAGE_H * s); }
  g.save(); g.beginPath(); g.rect(0, 0, w, availH + 1); g.clip();
  g.translate(ox, oy);
  for (const st of strokes) drawStroke(g, st, s);
  g.restore();
  g.globalCompositeOperation = 'source-over';
}
function setBoardView() {
  $('b-zoom').setAttribute('aria-pressed', String(boardZoom));
  $('b-big').setAttribute('aria-pressed', String(boardBig));
  layoutKids();
}
$('b-zoom').addEventListener('click', () => { boardZoom = !boardZoom; lsPut('dn-board-zoom', boardZoom); setBoardView(); });
$('b-big').addEventListener('click', () => { boardBig = !boardBig; lsPut('dn-board-big', boardBig); setBoardView(); });
setTimeout(setBoardView, 0);

/* ---------- after class: one notebook name, every student ---------- */
// The teacher picks a notebook name (e.g. "수학") and a page; every student's copy is shown side by side.
// Tapping one opens it for feedback, and 이전/다음 학생 walks through the class without coming back here.
let colMode = false, colBooks = {}, colTiles = {}, colItems = [], browse = null, colLoadId = 0;
const normName = x => (x || '').trim();
function setClassTab(col) {
  colMode = col;
  pressIn([$('tab-live'), $('tab-col')], col ? $('tab-col') : $('tab-live'));
  $('kids').hidden = col; $('col-bar').hidden = !col; $('col-kids').hidden = !col;
  if (col) loadCollection(); else layoutKids();
}
$('tab-live').addEventListener('click', () => setClassTab(false));
$('tab-col').addEventListener('click', () => setClassTab(true));
async function loadCollection() {
  const id = ++colLoadId;
  $('col-status').textContent = '공책을 모으는 중…';
  const got = await Promise.all(students.map(st => classRefs(classId, st.id).books.get()
    .then(q => [st.id, q.docs.map(d => ({ ...d.data(), id: d.id }))]).catch(() => [st.id, []])));
  if (id !== colLoadId) return;
  colBooks = Object.fromEntries(got);
  const count = {};
  for (const list of Object.values(colBooks)) new Set(list.map(n => normName(n.name))).forEach(nm => { if (nm) count[nm] = (count[nm] || 0) + 1; });
  const names = Object.keys(count).sort((a, b) => count[b] - count[a] || a.localeCompare(b, 'ko'));
  const sel = $('col-name'), prev = sel.value || lsGet('dn-col-name');
  sel.textContent = '';
  for (const nm of names) { const o = document.createElement('option'); o.value = nm; o.textContent = `${nm} (${count[nm]}명)`; sel.append(o); }
  if (names.includes(prev)) sel.value = prev;
  $('col-status').textContent = names.length ? '' : '아직 학생들이 만든 공책이 없어요.';
  renderCollection();
}
function colPick(st) {
  // a student may have two notebooks with the same name: use the one written in most recently
  const nm = $('col-name').value;
  return (colBooks[st.id] || []).filter(n => normName(n.name) === nm).sort((a, b) => (b.updated || '').localeCompare(a.updated || ''))[0] || null;
}
function renderCollection() {
  const nm = $('col-name').value; lsPut('dn-col-name', nm);
  const box = $('col-kids'); box.textContent = ''; colTiles = {};
  colItems = students.map(st => ({ st, nb: colPick(st) }));
  const most = Math.max(1, ...colItems.map(x => (x.nb && x.nb.pages) || 1));
  const ps = $('col-page'), keep = ps.value || 'last';
  ps.textContent = '';
  const opt = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; ps.append(o); };
  opt('last', '마지막 쪽'); for (let i = 1; i <= most; i++) opt(String(i), i + '쪽');
  ps.value = [...ps.options].some(o => o.value === keep) ? keep : 'last';
  if (!nm) return;
  colItems.forEach((it, i) => {
    const el = document.createElement('button'); el.className = 'kid' + (it.nb ? '' : ' none');
    const cv = document.createElement('canvas');
    const info = document.createElement('div'); info.className = 'info';
    const name = document.createElement('div'); name.className = 'name'; name.textContent = `${it.st.num}번 ${it.st.name || ''}`;
    const where = document.createElement('div'); where.className = 'where';
    const when = document.createElement('div'); when.className = 'when';
    where.textContent = it.nb ? '불러오는 중…' : '이 공책이 없어요';
    info.append(name, where, when); el.append(cv, info);
    if (it.nb) el.addEventListener('click', () => openFromCollection(i));
    else el.disabled = true;
    box.append(el);
    colTiles[it.st.id] = { el, cv, where, when, data: null };
  });
  layoutCollection();
  colItems.forEach(it => { if (it.nb) loadColTile(it); });
}
function layoutCollection() {
  if (fitGrid($('col-kids'), colItems.length)) Object.keys(colTiles).forEach(sid => paintThumb(colTiles[sid].cv, colTiles[sid].el, colTiles[sid].data));
}
async function colPage(st, nbId) {
  const ref = classRefs(classId, st.id).pages(nbId), want = $('col-page').value;
  const q = await (want === 'last' ? ref.orderBy('n', 'desc').limit(1) : ref.where('n', '==', +want).limit(1)).get();
  const docs = q.docs.map(d => ({ ...d.data(), id: d.id })).filter(d => typeof d.n === 'number');
  return docs.sort((a, b) => b.n - a.n)[0] || null;
}
async function loadColTile(it) {
  const t = colTiles[it.st.id], id = colLoadId, nm = $('col-name').value, want = $('col-page').value;
  try {
    const pg = await colPage(it.st, it.nb.id);
    if (colTiles[it.st.id] !== t) return;
    it.pg = pg;
    t.data = pg;
    t.where.textContent = pg ? `${pg.n}쪽 · ${fmtDate(pg.created)}` : (want === 'last' ? '빈 공책' : `${want}쪽이 없어요`);
    paintThumb(t.cv, t.el, pg);
    if (!pg) return;
    const fb = await classRefs(classId, it.st.id).fb(it.nb.id, pg.id).get();
    if (colTiles[it.st.id] !== t) return;
    const d = fb.exists ? fb.data() : {};
    const done = (d.strokes && d.strokes.length) || d.seal;
    t.when.className = 'when' + (done ? ' done' : '');
    t.when.textContent = done ? (d.seal ? `피드백 함 · ${d.seal}` : '피드백 함') : '';
  } catch (e) { if (colTiles[it.st.id] === t) t.where.textContent = '불러오지 못했어요'; }
}
// rename every student's notebook with this name at once (e.g. "수학 공책" → "수학" so they group together)
$('col-rename').addEventListener('click', () => { if ($('col-name').value) openRename($('col-rename-box'), $('col-rename-input'), $('col-name').value); });
$('col-rename-cancel').addEventListener('click', () => { $('col-rename-box').hidden = true; });
$('col-rename-box').addEventListener('submit', async e => {
  e.preventDefault();
  const from = $('col-name').value, name = $('col-rename-input').value.trim();
  if (!name || !from) return;
  if (name === from) { $('col-rename-box').hidden = true; return; }
  const jobs = [];
  for (const st of students) for (const n of colBooks[st.id] || []) if (normName(n.name) === from) {
    jobs.push(classRefs(classId, st.id).books.doc(n.id).update({ name }).then(() => { n.name = name; }));
  }
  const res = await Promise.allSettled(jobs), bad = res.filter(r => r.status === 'rejected').length;
  $('col-rename-box').hidden = true;
  toast(bad ? `${jobs.length - bad}권은 바꿨지만 ${bad}권은 바꾸지 못했어요` : `${jobs.length}권의 이름을 "${name}"(으)로 바꿨어요`);
  lsPut('dn-col-name', name); $('col-name').value = '';
  loadCollection();
});
$('col-name').addEventListener('change', () => { $('col-page').value = 'last'; renderCollection(); });
$('col-page').addEventListener('change', renderCollection);
function openFromCollection(i) {
  const it = colItems[i]; if (!it || !it.nb) return;
  browse = { i };
  openTeacherNotebook(it.st, { nb: it.nb.id, pg: it.pg ? it.pg.id : null });
}
function browseStep(dir) {
  if (!browse) return;
  for (let i = browse.i + dir; i >= 0 && i < colItems.length; i += dir) {
    if (colItems[i].nb) { flushSave().then(() => openFromCollection(i)); return; }
  }
  toast(dir > 0 ? '마지막 학생이에요' : '첫 번째 학생이에요');
}
$('t-prev-kid').addEventListener('click', () => browseStep(-1));
$('t-next-kid').addEventListener('click', () => browseStep(1));
function updateBrowseBar() {
  const on = !!browse; $('t-browse').hidden = !on;
  if (!on) return;
  const have = colItems.filter(x => x.nb), at = have.indexOf(colItems[browse.i]);
  $('t-kid-pos').textContent = `${$('col-name').value} · ${at + 1} / ${have.length}명`;
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
  await db.doc(`classes/${classId}/members/${uid}`).set({ sid });
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
const cssCache = {};
const CSS_FALLBACK = { '--paper': '#fffdf7', '--rule': '#b9d3ea', '--margin': '#f0a6a6', '--line': '#d5dde3' };
// an empty value would leave the canvas colour at its default, black, so fall back to the usual colour
const cssVar = n => cssCache[n] || (cssCache[n] = getComputedStyle(document.documentElement).getPropertyValue(n).trim()) || CSS_FALLBACK[n] || '#ffffff';
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
// Palm rejection can only tell a pen from a hand once this tablet has reported a pen. That used to be
// forgotten on every reload, so until a student's first pen stroke, fingers and palms drew too.
// Now a pen seen once (even hovering) is remembered on this tablet.
let palmBlock = true, penSeen = lsGet('dn-pen') === true;
function notePen() { if (!penSeen) { penSeen = true; lsPut('dn-pen', true); } }
let current = null, activeId = null, dpr = 1, pendingRedraw = false;
// Every page is the same sheet of paper, PAGE_W × PAGE_H in page units, scaled to fit the screen whole.
// Strokes are stored in page units, so a page looks the same upright, sideways, and on the teacher's computer.
const PAGE_W = 800, PAGE_H = 1080;
let scale = 1, view = 1; // view = page unit → canvas pixel

function clearPageSubs() { pageSubs.forEach(u => u()); pageSubs = []; }

/* ---------- notices: the teacher's feedback and messages reach the student anywhere in the app ---------- */
// The teacher writes a short list of recent notices on the student's own record (which the student can read).
// The student's app watches that record and shows a banner with a 보러 가기 button, a sound and a vibration.
const NOTICE_KEEP = 20, NOTICE_GAP = 3 * 60 * 1000;
function notifyStudent(st, refs, kind, book, pg, text) {
  if (!st || !refs || !refs.student || ownBook || !book || !pg) return;
  const live = (typeof students !== 'undefined' && students.find(x => x.id === st.id)) || st;
  const list = Array.isArray(live.notices) ? live.notices.slice() : [];
  const now = Date.now();
  // feedback is saved every few seconds while the teacher writes: one notice per page is enough
  if (kind === 'fb' && list.some(x => x.kind === 'fb' && x.pg === pg.id && now - x.at < NOTICE_GAP)) return;
  list.push({ at: now, kind, nb: book.id, nbName: book.name || '', pg: pg.id, n: pg.n || 0, text: (text || '').slice(0, 60) });
  const notices = list.slice(-NOTICE_KEEP);
  live.notices = notices; st.notices = notices;
  refs.student.update({ notices }).catch(() => {});
}
let noticeUnsub = null, noticeSeen = {}, noticeKey = '', noticeList = [], noticeShown = null;
function startNotices() {
  stopNotices();
  if (!R || !R.student || ownBook) return;
  noticeKey = `dn-notice-${classId}-${R.student.id}`;
  noticeSeen = lsGet(noticeKey) || {};
  noticeUnsub = R.student.onSnapshot(d => {
    if (!d.exists) return;
    noticeList = Array.isArray(d.data().notices) ? d.data().notices : [];
    checkNotices();
  }, () => {});
}
function stopNotices() { if (noticeUnsub) noticeUnsub(); noticeUnsub = null; noticeList = []; hideNotice(); }
const noticeId = x => x.nb + '/' + x.pg + '/' + x.kind;
function isUnseen(x) { return x.at > (noticeSeen[noticeId(x)] || 0); }
function markNoticeSeen(nbId, pgId) {
  let changed = false;
  for (const x of noticeList) if (x.nb === nbId && (!pgId || x.pg === pgId) && isUnseen(x)) { noticeSeen[noticeId(x)] = x.at; changed = true; }
  if (!changed) return;
  const keys = Object.keys(noticeSeen); if (keys.length > 200) keys.sort((a, b) => noticeSeen[a] - noticeSeen[b]).slice(0, keys.length - 200).forEach(k => delete noticeSeen[k]);
  lsPut(noticeKey, noticeSeen);
  if (noticeShown && !isUnseen(noticeShown)) hideNotice();
  if (!$('shelf').hidden) renderShelf();
}
function checkNotices() {
  if (mode !== 'student' || ownBook) return;
  // the page on screen: its feedback and messages already show there
  const onBook = !$('book').hidden && nb && pages[pi];
  if (onBook) {
    const here = noticeList.filter(x => x.nb === nb.id && x.pg === pages[pi].id && isUnseen(x) && (x.kind === 'fb' || !$('chat').hidden));
    if (here.length) markNoticeSeen(nb.id, pages[pi].id);
  }
  if (!$('shelf').hidden) renderShelf();
  const fresh = noticeList.filter(x => isUnseen(x) && !noticeDismissed.has(noticeId(x) + '@' + x.at)).sort((a, b) => b.at - a.at);
  if (!fresh.length) { hideNotice(); return; }
  const top = fresh[0];
  if (noticeShown && noticeShown.at === top.at) return;
  showNotice(top, fresh.length);
}
function showNotice(x, count) {
  noticeShown = x;
  const where = `${x.nbName || '공책'} ${x.n ? x.n + '쪽' : ''}`.trim();
  $('notice-text').textContent = x.kind === 'chat'
    ? `선생님이 ${where}에 메시지를 보냈어요${x.text ? ': "' + x.text + '"' : ''}`
    : `선생님이 ${where}에 피드백을 남겼어요`;
  $('notice-more').textContent = count > 1 ? `새 소식 ${count}개` : '';
  $('notice').hidden = false;
  try { if (navigator.vibrate) navigator.vibrate([120, 80, 120]); } catch (e) {}
}
function hideNotice() { noticeShown = null; const el = $('notice'); if (el) el.hidden = true; }
// 닫기 only puts the banner away; the notice stays in 확인 안 한 알림 on the bookshelf until it is opened
const noticeDismissed = new Set();
$('notice-close').addEventListener('click', () => { for (const x of noticeList) if (isUnseen(x)) noticeDismissed.add(noticeId(x) + '@' + x.at); hideNotice(); });
async function goToNotice(x) {
  if (!x) return;
  hideNotice();
  let n = notebooks.find(b => b.id === x.nb);
  if (!n) { try { notebooks = await store.listNotebooks(); } catch (e) {} n = notebooks.find(b => b.id === x.nb); }
  if (!n) { markNoticeSeen(x.nb, x.pg); toast('그 공책을 찾지 못했어요. 지워진 공책일 수 있어요'); return; }
  if (!(nb && nb.id === n.id && !$('book').hidden)) await openStudentNotebook(n);
  const i = pages.findIndex(p => p.id === x.pg);
  if (i < 0) toast('그 쪽을 찾지 못했어요. 지워진 쪽일 수 있어요');
  else if (i !== pi) { await flushSave(); showPage(i); }
  if (x.kind === 'chat') { $('chat').hidden = false; markChatRead(); renderChat(); }
  markNoticeSeen(x.nb, x.pg);
  checkNotices();
}
$('notice-go').addEventListener('click', () => goToNotice(noticeShown));
// 확인 안 한 알림 on the bookshelf: one row per page (feedback and messages on the same page together)
function renderInbox() {
  const box = $('inbox-list'); box.textContent = '';
  const groups = new Map();
  for (const x of noticeList.filter(isUnseen).sort((a, b) => b.at - a.at)) {
    const k = x.nb + '/' + x.pg;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(x);
  }
  $('inbox').hidden = ownBook || mode !== 'student' || !groups.size;
  $('inbox-count').textContent = groups.size;
  for (const list of groups.values()) {
    const x = list[0], hasFb = list.some(y => y.kind === 'fb'), msg = list.find(y => y.kind === 'chat');
    const row = document.createElement('button'); row.className = 'inbox-row';
    const ico = document.createElement('span'); ico.className = 'ico' + (hasFb ? '' : ' chat'); ico.textContent = hasFb ? '✎' : '💬';
    const what = document.createElement('span'); what.className = 'what';
    const t = document.createElement('b'); t.textContent = `${x.nbName || '공책'} ${x.n ? x.n + '쪽' : ''}`.trim();
    const d = document.createElement('span');
    const kinds = [hasFb ? '선생님 피드백' : '', msg ? `메시지 "${msg.text}"` : ''].filter(Boolean).join(' · ');
    d.textContent = `${kinds} · ${ago(x.at)}`;
    what.append(t, d);
    const go = document.createElement('span'); go.className = 'go'; go.textContent = '보러 가기 →';
    row.append(ico, what, go);
    row.addEventListener('click', () => goToNotice(msg && !hasFb ? msg : (msg || x)));
    box.append(row);
  }
}
$('inbox-all').addEventListener('click', () => {
  for (const x of noticeList) if (isUnseen(x)) noticeSeen[noticeId(x)] = x.at;
  lsPut(noticeKey, noticeSeen); hideNotice(); renderShelf();
});

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
  refreshTrash();
}
let tStudent = null;
async function openTeacherNotebook(st, target) {
  if (!st) return;
  tStudent = st;
  mode = 'teacher';
  seen[st.id] = Date.now(); lsPut('dn-seen', seen); updateCardText(st);
  R = classRefs(classId, st.id);
  setEditorChrome();
  show('book'); updateBrowseBar();
  $('book-name').textContent = `${st.num}번 ${st.name || ''}`;
  setSave('불러오는 중…');
  try { tNotebooks = (await R.books.get()).docs.map(d => ({ ...d.data(), id: d.id })); } catch (e) { tNotebooks = []; }
  const sel = $('t-notebook'); sel.textContent = '';
  for (const n of tNotebooks) { const o = document.createElement('option'); o.value = n.id; o.textContent = n.name; sel.append(o); }
  const cur = target || st.current;
  const first = (cur && tNotebooks.find(n => n.id === cur.nb)) || tNotebooks[0];
  if (!first) { pages = []; nb = null; resize(); showEmptyTeacher(); return; }
  sel.value = first.id;
  await loadTeacherNotebook(first, cur && cur.nb === first.id ? cur.pg : null);
}
async function loadTeacherNotebook(n, pgId) {
  await flushSave(); $('t-rename-box').hidden = true; resetTDel();
  nb = n;
  try { pages = (await R.pages(n.id).orderBy('n').get()).docs.map(d => ({ ...d.data(), id: d.id })); } catch (e) { pages = []; }
  resize();
  if (!pages.length) { showEmptyTeacher(); return; }
  const i = pages.findIndex(p => p.id === pgId);
  showPage(i >= 0 ? i : pages.length - 1);
  setSave('');
}
function showEmptyTeacher() {
  clearPageSubs(); strokes = []; base = []; overlay = []; seal = ''; ready = false;
  hint.hidden = false; hint.textContent = '이 학생은 아직 쓴 페이지가 없어요.';
  $('pageno').textContent = '0쪽'; $('prev').disabled = $('next').disabled = true;
  $('datestamp').textContent = ''; renderSeal(); redraw(); setSave('');
}
// teacher renames the open student notebook
function openRename(box, input, value) { box.hidden = false; input.value = value; input.focus(); input.select(); }
$('t-rename').addEventListener('click', () => { if (nb) openRename($('t-rename-box'), $('t-rename-input'), nb.name); });
$('t-rename-cancel').addEventListener('click', () => { $('t-rename-box').hidden = true; });
$('t-rename-box').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('t-rename-input').value.trim();
  if (!name || !nb) return;
  if (name === nb.name) { $('t-rename-box').hidden = true; return; }
  try {
    await R.books.doc(nb.id).update({ name });
    nb.name = name;
    const o = [...$('t-notebook').options].find(x => x.value === nb.id); if (o) o.textContent = name;
    for (const list of Object.values(colBooks)) for (const n of list) if (n.id === nb.id) n.name = name;
    $('t-rename-box').hidden = true; toast(`공책 이름을 "${name}"(으)로 바꿨어요`);
  } catch (err) { toast('이름을 바꾸지 못했어요. ' + errText(err)); }
});
// teacher deletes the open student notebook: two taps; pages, backgrounds and feedback go with it
let tDelTimer = null;
function resetTDel() { const b = $('t-delete'); clearTimeout(tDelTimer); b.dataset.armed = ''; b.textContent = '공책 지우기'; b.classList.remove('danger'); }
$('t-delete').addEventListener('click', async () => {
  const b = $('t-delete');
  if (!nb || !tStudent) return;
  if (b.dataset.armed !== '1') {
    b.dataset.armed = '1'; b.textContent = `"${nb.name}" 지울까요? 한 번 더 누르기`; b.classList.add('danger');
    clearTimeout(tDelTimer); tDelTimer = setTimeout(resetTDel, 3000); return;
  }
  resetTDel(); b.disabled = true;
  const book = nb, st = tStudent, refs = R;
  try {
    dirty = false; clearTimeout(saveTimer); clearPageSubs();
    const all = await refs.pages(book.id).get();
    for (const d of all.docs) {
      if (!d.id.endsWith('-bg')) await refs.fb(book.id, d.id).delete().catch(() => {});
      await refs.pages(book.id).doc(d.id).delete();
    }
    await refs.books.doc(book.id).delete();
    if (st.current && st.current.nb === book.id) await refs.student.update({ current: null }).catch(() => {});
    tNotebooks = tNotebooks.filter(x => x.id !== book.id);
    if (colBooks[st.id]) colBooks[st.id] = colBooks[st.id].filter(x => x.id !== book.id);
    const o = [...$('t-notebook').options].find(x => x.value === book.id); if (o) o.remove();
    toast(`${st.num}번 "${book.name}"을(를) 지웠어요`);
    if (tNotebooks[0]) { $('t-notebook').value = tNotebooks[0].id; await loadTeacherNotebook(tNotebooks[0], null); }
    else { pages = []; nb = null; resize(); showEmptyTeacher(); }
  } catch (err) { toast('지우지 못했어요. ' + errText(err)); }
  finally { b.disabled = false; }
});
$('t-notebook').addEventListener('change', e => { const n = tNotebooks.find(x => x.id === e.target.value); if (n) loadTeacherNotebook(n, null); });

function setEditorChrome() {
  const t = mode === 'teacher';
  $('back').textContent = t ? '← 우리 반' : '← 공책장';
  $('teacher-bar').hidden = !t;
  $('add-page').hidden = t;
  $('del-page').hidden = t;
  $('trash-btn').hidden = true; $('trash').hidden = true;
  $('paper').hidden = t;
  $('bg-btn').hidden = t;
  $('chat').hidden = true;
  $('chat-title').textContent = t ? '학생과 이야기' : '선생님과 이야기';
  hint.textContent = '오늘 배운 내용을 써 보세요.';
  const pick = t ? $('c-red') : $('c-black');
  color = pick.dataset.color; pressIn(swatches, pick); setTool('pen');
}

function showPage(i) {
  clearPageSubs(); resetDelPage();
  pi = Math.max(0, Math.min(i, pages.length - 1));
  const pg = pages[pi];
  sheet.className = pg.paper || '';
  $('paper').textContent = PAPERS[pg.paper || ''];
  $('datestamp').textContent = fmtDate(pg.created);
  $('pageno').textContent = `${pi + 1} / ${pages.length}쪽`;
  $('prev').disabled = pi === 0;
  $('next').disabled = pi === pages.length - 1;
  overlay = []; base = []; seal = ''; msgs = []; chatKey = ''; editingMsg = null; renderChat();
  $('bg-btn').textContent = pg.bg ? '배경 빼기' : '배경 넣기';
  ensureBg(pg);
  if (mode === 'student') {
    if (!pg._dec) pg._dec = (pg.strokes || []).map(decode);
    strokes = pg._dec; ready = true;
    hint.hidden = strokes.length > 0 || !!pg.bg;
    touchStudent({ current: { nb: nb.id, nbName: nb.name, pg: pg.id, n: pg.n }, updated: Date.now() });
    if (!ownBook) { markNoticeSeen(nb.id, pg.id); setTimeout(checkNotices, 0); }
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
      base = decodeMore(base, data.strokes || []);
      if (data.paper !== undefined && data.paper !== pg.paper) { pg.paper = data.paper; sheet.className = pg.paper; paperKey = ''; }
      if ((data.bg || 0) !== (pg.bg || 0)) { pg.bg = data.bg || 0; pg.bgSrc = data.bgSrc || ''; paperKey = ''; ensureBg(pg); }
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
let redrawTimer = null;
function safeRedraw() {
  if (current) { pendingRedraw = true; return; }
  if (redrawTimer) return;
  redrawTimer = setTimeout(() => { redrawTimer = null; if (current) pendingRedraw = true; else redraw(); }, 250);
}

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
// delete the page on screen: two taps, like deleting a notebook. The last page stays (delete the notebook instead).
let delPageTimer = null;
// An arm or palm resting on the screen can press buttons too. While palm rejection is on and this tablet
// has an S Pen, the buttons that throw writing away only answer to the pen (or a mouse).
let lastPtr = 'mouse';
document.addEventListener('pointerdown', e => { lastPtr = e.pointerType; }, true);
function handBlocked() {
  if (lastPtr === 'touch' && palmBlock && penSeen && mode === 'student') { toast('지우는 버튼은 S펜으로 눌러 주세요 (손바닥 차단 중)'); return true; }
  return false;
}
$('del-page').addEventListener('click', async () => {
  const btn = $('del-page');
  if (handBlocked()) return;
  if (pages.length <= 1) { toast('마지막 한 쪽은 지울 수 없어요. 공책을 통째로 지우려면 공책장에서 지워요.'); return; }
  if (btn.dataset.armed !== '1') {
    btn.dataset.armed = '1'; btn.textContent = '한 번 더 누르면 지워져요'; btn.classList.add('danger');
    clearTimeout(delPageTimer);
    delPageTimer = setTimeout(resetDelPage, 3000);
    return;
  }
  resetDelPage(); btn.disabled = true;
  try {
    await flushSave(); dirty = false; clearTimeout(saveTimer);
    const pg = pages[pi], book = nb, at = pi;
    clearPageSubs();
    // the page goes to the bin first ("<page id>-trash", without a page number so it is not listed),
    // its background picture stays, and 지운 쪽 can bring it back for 30 days
    const cur = await R.page(book.id, pg.id).get();
    const { n: _n, ...body } = cur.exists ? cur.data() : { paper: pg.paper, created: pg.created, strokes: [] };
    await R.page(book.id, pg.id + '-trash').set({ ...body, of: pg.id, tn: pg.n, deletedAt: Date.now() });
    await R.page(book.id, pg.id).delete();
    pages.splice(at, 1);
    // keep page numbers in a row so the teacher's board shows the right page number
    for (const p of pages.slice(at)) { p.n -= 1; R.page(book.id, p.id).update({ n: p.n }).catch(() => {}); }
    book.pages = pages.length; book.updated = today();
    await store.touchNotebook(book); book._savedPages = pages.length;
    toast(`${at + 1}쪽을 지웠어요. "지운 쪽"에서 되살릴 수 있어요`);
    showPage(Math.min(at, pages.length - 1));
    refreshTrash();
  } catch (err) { toast('지우지 못했어요. ' + errText(err)); showPage(pi); }
  finally { btn.disabled = false; }
});

/* ---------- 지운 쪽: the bin ---------- */
const TRASH_DAYS = 30;
let trash = [];
async function refreshTrash() {
  trash = [];
  $('trash-btn').hidden = true;
  if (mode !== 'student' || !nb) return;
  const book = nb;
  try {
    const q = await R.pages(book.id).orderBy('deletedAt').get();
    if (nb !== book) return;
    const old = Date.now() - TRASH_DAYS * 864e5;
    for (const d of q.docs) {
      const t = { ...d.data(), id: d.id };
      if (!t.deletedAt) continue;
      if (t.deletedAt < old) { R.pages(book.id).doc(d.id).delete().catch(() => {}); if (t.bg && !t.bgSrc) R.page(book.id, t.of + '-bg').delete().catch(() => {}); continue; }
      trash.push(t);
    }
  } catch (e) { /* the bin is optional */ }
  trash.sort((a, b) => b.deletedAt - a.deletedAt);
  $('trash-btn').hidden = !trash.length;
  $('trash-btn').textContent = `지운 쪽 (${trash.length})`;
  if (!$('trash').hidden) renderTrash();
}
function renderTrash() {
  { const e = $('trash-empty'); e.disabled = false; e.dataset.armed = ''; e.textContent = '모두 비우기'; e.classList.remove('danger'); }
  const box = $('trash-list'); box.textContent = '';
  if (!trash.length) { $('trash').hidden = true; return; }
  for (const t of trash) {
    const row = document.createElement('div'); row.className = 'trash-row';
    const cv = document.createElement('canvas'); cv.className = 'trash-thumb';
    const info = document.createElement('div'); info.className = 'small';
    const d = new Date(t.deletedAt);
    info.textContent = `${t.tn}쪽이었어요 · ${d.getMonth() + 1}월 ${d.getDate()}일 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}에 지움`;
    const btn = document.createElement('button'); btn.className = 'primary'; btn.textContent = '되살리기';
    btn.addEventListener('click', () => restorePage(t, btn));
    const kill = document.createElement('button'); kill.textContent = '완전히 지우기';
    kill.addEventListener('click', () => armThen(kill, '정말 지울까요?', () => purge([t])));
    const btns = document.createElement('div'); btns.className = 'trash-btns'; btns.append(btn, kill);
    row.append(cv, info, btns); box.append(row);
    cv.width = 96; cv.height = Math.round(96 * PAGE_H / PAGE_W);
    const g = cv.getContext('2d'); g.fillStyle = cssVar('--paper'); g.fillRect(0, 0, cv.width, cv.height);
    for (const o of t.strokes || []) drawStroke(g, decode(o), cv.width / PAGE_W);
    g.globalCompositeOperation = 'source-over';
  }
}
// two taps for anything that cannot be undone
function armThen(b, ask, run) {
  if (handBlocked()) return;
  if (b.dataset.armed !== '1') {
    const label = b.textContent; b.dataset.armed = '1'; b.textContent = ask; b.classList.add('danger');
    setTimeout(() => { if (b.isConnected) { b.dataset.armed = ''; b.textContent = label; b.classList.remove('danger'); } }, 3000);
    return;
  }
  b.disabled = true; run();
}
async function purge(list) {
  const book = nb;
  try {
    for (const t of list) {
      await R.pages(book.id).doc(t.id).delete();
      if (t.bg && !t.bgSrc) await R.page(book.id, t.of + '-bg').delete().catch(() => {});
    }
    toast(list.length > 1 ? `지운 쪽 ${list.length}개를 완전히 지웠어요` : '완전히 지웠어요');
  } catch (err) { toast('지우지 못했어요. ' + errText(err)); }
  await refreshTrash();
}
$('trash-empty').addEventListener('click', () => armThen($('trash-empty'), '정말 모두 비울까요?', () => purge(trash.slice())));
$('trash-btn').addEventListener('click', () => { $('trash').hidden = !$('trash').hidden; if (!$('trash').hidden) renderTrash(); });
$('trash-close').addEventListener('click', () => { $('trash').hidden = true; });
async function restorePage(t, btn) {
  btn.disabled = true;
  try {
    await flushSave(); dirty = false; clearTimeout(saveTimer);
    const book = nb;
    // back to where it was: page tn, the pages from there on move one later
    const at = Math.max(0, Math.min(pages.length, (t.tn || pages.length + 1) - 1));
    for (const p of pages.slice(at)) { p.n += 1; R.page(book.id, p.id).update({ n: p.n }).catch(() => {}); }
    const { id: _id, of, tn, deletedAt, ...body } = t;
    const pg = { ...body, id: of, n: at + 1 };
    await store.putPage(book.id, pg);
    await R.pages(book.id).doc(t.id).delete();
    pages.splice(at, 0, pg);
    book.pages = pages.length; book.updated = today();
    await store.touchNotebook(book); book._savedPages = pages.length;
    toast(`${at + 1}쪽으로 되살렸어요`);
    showPage(at);
    await refreshTrash();
  } catch (err) { toast('되살리지 못했어요. ' + errText(err)); btn.disabled = false; }
}
function resetDelPage() { const b = $('del-page'); clearTimeout(delPageTimer); b.dataset.armed = ''; b.textContent = '이 쪽 지우기'; b.classList.remove('danger'); }
$('back').addEventListener('click', async () => {
  await flushSave(); clearPageSubs(); $('chat').hidden = true;
  if (mode === 'teacher') {
    show('class'); students.forEach(updateCardText); layoutKids();
    // came from 모아보기: refresh that student's tile so the 피드백 함 mark shows
    if (browse && colItems[browse.i]) loadColTile(colItems[browse.i]);
  }
  else {
    show('shelf'); renderShelf();
    // pick up notebooks the teacher added meanwhile
    store.listNotebooks().then(list => { notebooks = list; renderShelf(); }).catch(() => {});
  }
});

/* ---------- chat ---------- */
// Unread = messages from the other person newer than the last time this page's chat was open on this
// tablet. Remembered per page, so messages already read don't light up the red badge again next time.
let msgs = [], chatKey = '';
let chatRead = lsGet('dn-chat-read') || {};
function markChatRead() {
  if (!chatKey || !msgs.length) return;
  const last = msgs[msgs.length - 1].at || 0;
  if ((chatRead[chatKey] || 0) >= last) return;
  chatRead[chatKey] = last;
  const keys = Object.keys(chatRead);
  if (keys.length > 400) keys.sort((a, b) => chatRead[a] - chatRead[b]).slice(0, keys.length - 400).forEach(k => delete chatRead[k]);
  lsPut('dn-chat-read', chatRead);
}
function subscribeChat(pg) {
  let first = true;
  chatKey = (mode === 'teacher' ? 't/' : 's/') + nb.id + '/' + pg.id; // per role: a teacher may also try the student side on the same tablet
  pageSubs.push(R.chat(nb.id, pg.id).orderBy('at').onSnapshot(snap => {
    const before = msgs.length;
    msgs = snap.docs.map(d => ({ ...d.data(), _id: d.id }));
    const mine = mode === 'teacher' ? 't' : 's';
    const fresh = msgs.slice(before).filter(m => m.from !== mine);
    if (!first && fresh.length) toast(mode === 'teacher' ? '학생이 메시지를 보냈어요' : '선생님이 메시지를 보냈어요');
    first = false;
    renderChat();
  }, () => {}));
}
function renderChat() {
  const box = $('msgs'); box.textContent = '';
  const mine = mode === 'teacher' ? 't' : 's';
  if (!msgs.length) { const p = document.createElement('p'); p.className = 'small'; p.textContent = '이 페이지에 대해 이야기를 나눠요.'; box.append(p); }
  const draft = editingMsg && $('msg-edit-input') ? $('msg-edit-input').value : null;
  for (const m of msgs) {
    const d = document.createElement('div'); d.className = 'msg ' + (m.from === mine ? 'mine' : 'theirs');
    const canEdit = mode === 'teacher' && m.from === 't';
    if (canEdit && editingMsg === m._id) { d.classList.add('editing'); d.append(msgEditForm(m, draft)); box.append(d); continue; }
    d.textContent = m.text;
    const t = document.createElement('time');
    t.textContent = (m.from === 't' ? '선생님 · ' : '학생 · ') + fmtTime(m.at) + (m.edited ? ' · 고침' : '');
    d.append(t);
    if (canEdit) { d.classList.add('editable'); d.title = '눌러서 고치기'; d.addEventListener('click', () => { editingMsg = m._id; renderChat(); const i = $('msg-edit-input'); if (i) { i.focus(); i.select(); } }); }
    box.append(d);
  }
  if (!editingMsg) box.scrollTop = box.scrollHeight;
  if (!$('chat').hidden) markChatRead();
  const readAt = chatRead[chatKey] || 0;
  const unread = msgs.filter(m => m.from !== mine && (m.at || 0) > readAt).length;
  const badge = $('chat-badge'); badge.hidden = unread === 0; badge.textContent = unread;
}
// the teacher can fix or remove a feedback message already sent: tap it
let editingMsg = null;
function msgEditForm(m, draft) {
  const f = document.createElement('form'); f.className = 'msg-edit';
  const i = document.createElement('input'); i.type = 'text'; i.id = 'msg-edit-input'; i.maxLength = 300; i.value = draft != null ? draft : m.text; i.setAttribute('aria-label', '메시지 고치기');
  i.addEventListener('focus', () => $('chat').classList.add('typing'));
  const row = document.createElement('div'); row.className = 'row';
  const save = document.createElement('button'); save.type = 'submit'; save.className = 'primary'; save.textContent = '저장';
  const del = document.createElement('button'); del.type = 'button'; del.textContent = '지우기';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '취소';
  row.append(save, del, cancel); f.append(i, row);
  const ref = () => R.chat(nb.id, pages[pi].id).doc(m._id);
  const done = () => { editingMsg = null; $('chat').classList.remove('typing'); renderChat(); };
  cancel.addEventListener('click', done);
  del.addEventListener('click', async () => {
    if (del.dataset.armed !== '1') { del.dataset.armed = '1'; del.textContent = '정말 지우기'; del.classList.add('danger'); return; }
    try { await ref().delete(); done(); } catch (err) { toast('지우지 못했어요. ' + errText(err)); }
  });
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const text = i.value.trim();
    if (!text) return;
    if (text === m.text) { done(); return; }
    try { await ref().update({ text, edited: Date.now() }); done(); } catch (err) { toast('고치지 못했어요. ' + errText(err)); }
  });
  return f;
}
$('chat-open').addEventListener('click', () => { $('chat').hidden = !$('chat').hidden; markChatRead(); renderChat(); if (mode === 'student' && nb && pages[pi]) markNoticeSeen(nb.id, pages[pi].id); if (!$('chat').hidden) $('chat-input').focus(); });
$('chat-close').addEventListener('click', () => { $('chat').hidden = true; });
// on-screen keyboard: while typing, the chat box moves to the top of the screen with the typing line
// first, so the keyboard (which rises from the bottom) never covers it, in a browser tab or full screen
$('chat-input').addEventListener('focus', () => { $('chat').classList.add('typing'); $('msgs').scrollTop = $('msgs').scrollHeight; });
$('chat-input').addEventListener('blur', () => { setTimeout(() => { if (document.activeElement !== $('chat-input')) $('chat').classList.remove('typing'); }, 150); });
$('chat-form').addEventListener('submit', async e => {
  e.preventDefault();
  const text = $('chat-input').value.trim();
  if (!text || !nb || !pages[pi]) return;
  $('chat-input').value = '';
  const at = Date.now();
  try {
    await R.chat(nb.id, pages[pi].id).add({ from: mode === 'teacher' ? 't' : 's', text, at });
    if (mode === 'teacher') notifyStudent(tStudent, R, 'chat', nb, pages[pi], text);
    if (mode === 'student') {
      touchStudent({ lastMsgAt: at, updated: at });
      // a message on a brand-new blank page: save the page too, or the teacher can't open it to read the message
      if (!pages[pi]._sent) { pages[pi]._sent = true; dirty = true; flushSave(); }
    }
  } catch (err) { toast('메시지를 보내지 못했어요'); $('chat-input').value = text; }
});


/* ---------- background picture or PDF ---------- */
// Pictures are shrunk to the page and saved as JPEG (about 150–300 KB) in a separate document
// next to the page ("<page id>-bg"), so the page itself stays small and pages without one cost nothing.
const BG_W = 1200, BG_H = Math.round(BG_W * PAGE_H / PAGE_W), BG_MAX = 850000, PDF_MAX_PAGES = 30;
const bgCache = {};
const bgRef = pg => R.page(nb.id, pg.id + '-bg');
async function ensureBg(pg) {
  if (!pg.bg || (bgCache[pg.id] && bgCache[pg.id].stamp === pg.bg)) return;
  try {
    const d = await (pg.bgSrc ? db.doc(pg.bgSrc) : bgRef(pg)).get();
    if (!d.exists) return;
    const data = d.data();
    const img = new Image(); img.src = data.data; await img.decode();
    bgCache[pg.id] = { stamp: pg.bg, img, w: data.w, h: data.h };
    if (pages[pi] === pg) { paperKey = ''; safeRedraw(); }
  } catch (e) { /* the page still works without its picture */ }
}
function toJpeg(src, sw, sh) {
  const k = Math.min(BG_W / sw, BG_H / sh, 1);
  const w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h); g.drawImage(src, 0, 0, w, h);
  let q = 0.8, data = c.toDataURL('image/jpeg', q);
  while (data.length > BG_MAX && q > 0.3) { q -= 0.15; data = c.toDataURL('image/jpeg', q); }
  if (data.length > BG_MAX) throw new Error('too-big');
  return { data, w, h };
}
async function loadImageFile(file) {
  if (window.createImageBitmap) {
    try { const b = await createImageBitmap(file, { imageOrientation: 'from-image' }); return { src: b, w: b.width, h: b.height }; } catch (e) {}
  }
  const url = URL.createObjectURL(file);
  try { const img = new Image(); img.src = url; await img.decode(); return { src: img, w: img.naturalWidth, h: img.naturalHeight }; }
  finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
let pdfLib = null;
function loadPdfJs() {
  if (pdfLib) return pdfLib;
  pdfLib = new Promise((ok, fail) => {
    const sc = document.createElement('script');
    sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    sc.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'; ok(window.pdfjsLib); };
    sc.onerror = () => { pdfLib = null; fail(new Error('pdfjs')); };
    document.head.append(sc);
  });
  return pdfLib;
}
// file → list of page pictures (one for an image, one per PDF page)
async function fileToPics(file, progress) {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    progress('PDF를 여는 중…');
    const lib = await loadPdfJs();
    const pdf = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
    const n = Math.min(pdf.numPages, PDF_MAX_PAGES), pics = [];
    for (let i = 1; i <= n; i++) {
      progress(`PDF ${i} / ${n}쪽 바꾸는 중…`);
      const page = await pdf.getPage(i);
      const v1 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: Math.min(BG_W / v1.width, BG_H / v1.height) });
      const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      pics.push(toJpeg(c, c.width, c.height));
    }
    pics.truncated = pdf.numPages > n;
    return pics;
  }
  if (file.type.startsWith('image/')) {
    progress('그림을 바꾸는 중…');
    const im = await loadImageFile(file);
    return [toJpeg(im.src, im.w, im.h)];
  }
  throw new Error('type');
}
const picErr = err => err && err.message === 'pdfjs' ? 'PDF 도구를 불러오지 못했어요. 인터넷 연결을 확인해 주세요'
  : err && err.message === 'type' ? '그림 파일이나 PDF만 넣을 수 있어요' : '파일을 넣지 못했어요';
async function setPageBg(pg, pic) {
  const stamp = Date.now();
  await bgRef(pg).set({ bgOf: pg.id, data: pic.data, w: pic.w, h: pic.h, at: stamp });
  pg.bg = stamp; pg.bgSrc = '';
  const img = new Image(); img.src = pic.data; await img.decode();
  bgCache[pg.id] = { stamp, img, w: pic.w, h: pic.h };
}
async function savePageNow(pg) {
  const enc = (pg._dec || []).map(encodeCached);
  await store.putPage(nb.id, { id: pg.id, n: pg.n, paper: pg.paper, created: pg.created, strokes: enc, w: PAGE_W, h: PAGE_H, bg: pg.bg || 0, bgSrc: pg.bg ? (pg.bgSrc || '') : '' });
}
$('bg-btn').addEventListener('click', async () => {
  const pg = pages[pi]; if (!pg || mode !== 'student') return;
  if (!pg.bg) { $('bg-file').value = ''; $('bg-file').click(); return; }
  const b = $('bg-btn');
  if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = '한 번 더 누르면 빠져요'; setTimeout(() => { b.dataset.armed = ''; if (pages[pi] === pg) b.textContent = pg.bg ? '배경 빼기' : '배경 넣기'; }, 2500); return; }
  b.dataset.armed = '';
  pg.bg = 0; delete bgCache[pg.id]; paperKey = ''; redraw(); b.textContent = '배경 넣기';
  hint.hidden = strokes.length > 0;
  markDirty();
  bgRef(pg).delete().catch(() => {});
});
$('bg-file').addEventListener('change', async e => {
  const file = e.target.files && e.target.files[0];
  if (!file || !nb) return;
  await flushSave();
  const btn = $('bg-btn'); btn.disabled = true;
  try {
    const pics = await fileToPics(file, t => setSave(t));
    let target = pages[pi];
    // an empty page takes the first picture; the rest become new pages at the end
    if (pics.length > 1 && (target._dec && target._dec.length || target.bg)) target = null;
    let firstIdx = -1;
    for (const pic of pics) {
      let pg = target; target = null;
      if (!pg) {
        const last = pages[pages.length - 1];
        pg = { id: newId(), n: last.n + 1, paper: '', created: today(), strokes: [], _dec: [] };
        pages.push(pg);
      }
      await setPageBg(pg, pic);
      await savePageNow(pg);
      if (firstIdx < 0) firstIdx = pages.indexOf(pg);
    }
    if (pics.length > 1) { nb.pages = pages.length; nb.updated = today(); await store.touchNotebook(nb); nb._savedPages = pages.length; }
    showPage(firstIdx);
    setSave(pics.truncated ? `앞 ${pics.length}쪽만 넣었어요` : pics.length > 1 ? `PDF ${pics.length}쪽을 넣었어요` : '배경을 넣었어요');
  } catch (err) { setSave(picErr(err), true); }
  finally { btn.disabled = false; }
});


/* ---------- handouts: one worksheet into many students' notebooks ---------- */
let membersSynced = '';
async function syncMembers() {
  // students enrolled before handouts existed get their membership record once
  if (membersSynced === classId) return;
  membersSynced = classId;
  for (const st of students) {
    if (!st.uid) continue;
    try { const m = db.doc(`classes/${classId}/members/${st.uid}`); if (!(await m.get()).exists) await m.set({ sid: st.id }); } catch (e) {}
  }
}
const handoutPick = {};
function renderHandoutKids() {
  const box = $('h-kids'); box.textContent = '';
  for (const st of students) {
    if (handoutPick[st.id] === undefined) handoutPick[st.id] = true;
    const l = document.createElement('label'); l.className = 'kid-pick';
    const c = document.createElement('input'); c.type = 'checkbox'; c.checked = handoutPick[st.id];
    c.addEventListener('change', () => { handoutPick[st.id] = c.checked; });
    l.append(c, document.createTextNode(`${st.num}번 ${st.name || ''}`));
    box.append(l);
  }
}
$('h-all').addEventListener('click', () => {
  const all = students.every(st => handoutPick[st.id]);
  students.forEach(st => { handoutPick[st.id] = !all; });
  renderHandoutKids();
});
$('handout-form').addEventListener('submit', async e => {
  e.preventDefault();
  const file = $('h-file').files && $('h-file').files[0];
  const nbName = $('h-nb').value.trim() || '학습지';
  const targets = students.filter(st => handoutPick[st.id]);
  const status = t => { $('h-status').textContent = t; };
  if (!file) { status('나눠 줄 파일을 골라 주세요.'); return; }
  if (!targets.length) { status('받을 학생을 골라 주세요.'); return; }
  $('h-go').disabled = true;
  try {
    const pics = await fileToPics(file, status);
    const hid = newId(), at = Date.now();
    await db.doc(`classes/${classId}/handouts/${hid}`).set({ title: file.name, nbName, pages: pics.length, created: at });
    for (let i = 0; i < pics.length; i++) {
      status(`학습지 저장 중 ${i + 1} / ${pics.length}`);
      await db.doc(`classes/${classId}/handouts/${hid}/pages/p${i}`).set({ data: pics[i].data, w: pics[i].w, h: pics[i].h });
    }
    let done = 0, failed = 0;
    for (const st of targets) {
      status(`학생 공책에 넣는 중 ${done + failed + 1} / ${targets.length}`);
      try {
        const refs = classRefs(classId, st.id);
        const books = (await refs.books.get()).docs.map(d => ({ ...d.data(), id: d.id }));
        let book = books.find(b => b.name === nbName);
        const now = today();
        if (!book) book = { id: newId(), name: nbName, color: '#4b5963', paper: '', created: now, updated: now, pages: 0 };
        const old = (await refs.pages(book.id).orderBy('n').get()).docs.map(d => d.data());
        let n = old.reduce((m, p) => Math.max(m, p.n || 0), 0);
        for (let i = 0; i < pics.length; i++) {
          const id = newId();
          await refs.page(book.id, id).set({ n: ++n, paper: '', created: now, strokes: [], w: PAGE_W, h: PAGE_H,
            bg: at, bgSrc: `classes/${classId}/handouts/${hid}/pages/p${i}`, handout: hid });
        }
        const { id, ...body } = book;
        await refs.books.doc(id).set({ ...body, pages: old.length + pics.length, updated: now });
        done++;
      } catch (err) { failed++; }
    }
    status(failed ? `${done}명에게 넣었고, ${failed}명은 실패했어요. 다시 눌러 주세요.`
      : `${done}명에게 ${pics.length}쪽을 넣었어요.${pics.truncated ? ' (PDF는 앞 30쪽만)' : ''}`);
    $('h-file').value = '';
  } catch (err) { status(picErr(err)); }
  finally { $('h-go').disabled = false; }
});

/* ---------- autosave ---------- */
let dirty = false, saveTimer = null, saving = Promise.resolve(), lastTouch = 0;
function setSave(text, err) { const el = $('save'); el.textContent = text; el.classList.toggle('err', !!err); }
function markDirty() { dirty = true; setSave('저장 중…'); clearTimeout(saveTimer); saveTimer = setTimeout(flushSave, 2500); }
function flushSave() {
  clearTimeout(saveTimer); saveTimer = null;
  if (!dirty || !nb || !pages[pi]) return saving;
  dirty = false;
  const pg = pages[pi], book = nb, enc = strokes.map(encodeCached), refs = R, who = mode;
  const r = sheet.getBoundingClientRect();
  let job;
  if (who === 'teacher') {
    const body = { strokes: enc, seal, updated: Date.now() };
    const st = tStudent;
    job = async () => { await refs.fb(book.id, pg.id).set(body); notifyStudent(st, refs, 'fb', book, pg); return sizeOf(enc); };
  } else {
    const body = { id: pg.id, n: pg.n, paper: pg.paper, created: pg.created, strokes: enc, w: PAGE_W, h: PAGE_H, bg: pg.bg || 0, bgSrc: pg.bg ? (pg.bgSrc || '') : '' };
    book.updated = today(); book.pages = pages.length;
    job = async () => {
      await store.putPage(book.id, body);
      const now = Date.now();
      if (book._savedPages !== pages.length || now - (book._savedAt || 0) > 10 * 60 * 1000) {
        await store.touchNotebook(book); book._savedPages = pages.length; book._savedAt = now;
      }
      if (now - lastTouch > 20000) { lastTouch = now; touchStudent({ current: { nb: book.id, nbName: book.name, pg: pg.id, n: pg.n }, updated: now }); }
      return sizeOf(enc);
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
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushSave();
  else repaintAll();
});
// Android Chrome may throw away canvas pictures to free memory (switching apps, sleep, low memory).
// The opaque writing canvas then shows black. Rebuild every layer when that happens or when the tab comes back.
function repaintAll() {
  if ($('book').hidden) { if (!$('class').hidden) layoutKids(); return; }
  for (const k of Object.keys(cssCache)) delete cssCache[k];
  resetLayers(); redraw();
}

/* ---------- drawing ---------- */
function resize() {
  dpr = window.devicePixelRatio || 1;
  const host = sheet.parentElement, cs = getComputedStyle(host);
  const availW = host.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const availH = host.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  if (availW <= 0 || availH <= 0) return;
  scale = Math.min(availW / PAGE_W, availH / PAGE_H);
  view = dpr * scale;
  sheet.style.width = (PAGE_W * scale) + 'px';
  sheet.style.height = (PAGE_H * scale) + 'px';
  sheet.style.setProperty('--s', scale);
  const W = Math.round(PAGE_W * view), H = Math.round(PAGE_H * view);
  // the browser bar or keyboard can fire resize without changing the page: keep the canvases then
  if (W === ink.width && H === ink.height) { redraw(); return; }
  for (const c of [ink, live, offBase, offEdit, frame]) { c.width = W; c.height = H; }
  resetLayers();
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
function seg(c, s, a, b, k = view) {
  c.strokeStyle = inkMode(c, s); c.lineCap = 'round'; c.lineJoin = 'round';
  c.lineWidth = widthFor(s, (a.p + b.p) / 2) * k;
  c.beginPath(); c.moveTo(a.x * k, a.y * k); c.lineTo(b.x * k, b.y * k); c.stroke();
}
function dotAt(c, s, a, k = view) {
  c.fillStyle = inkMode(c, s);
  c.beginPath(); c.arc(a.x * k, a.y * k, widthFor(s, a.p) * k / 2, 0, Math.PI * 2); c.fill();
}
function drawStroke(c, s, k = view) {
  if (s.hl) { drawHighlight(c, s, k); return; }
  const pts = s.pts; if (!pts.length) return;
  if (pts.length === 1) { dotAt(c, s, pts[0], k); return; }
  for (let i = 1; i < pts.length; i++) seg(c, s, pts[i - 1], pts[i], k);
}
// Layers: paper, the student's ink (base, teacher view), the editable ink, the teacher's marks (overlay).
// Finished strokes are added to their layer one at a time; a full rebuild happens only after undo,
// clear, page change or resize. Everything is put together on a hidden frame and copied to the screen
// in one step, because the low-latency screen canvas shows every half-drawn state (that was the flicker).
const frame = document.createElement('canvas'), fctx = frame.getContext('2d');
const paperC = document.createElement('canvas'), pctx = paperC.getContext('2d');
let paperKey = '';
const layers = { base: { c: offBase, g: bctx, len: 0, first: null }, edit: { c: offEdit, g: ectx, len: 0, first: null } };
function syncLayer(L, arr) {
  let n = arr.length;
  if (n && arr[n - 1] === current) n--;
  if (n < L.len || (L.len && arr[0] !== L.first)) { L.g.clearRect(0, 0, L.c.width, L.c.height); L.len = 0; }
  for (let i = L.len; i < n; i++) drawStroke(L.g, arr[i]);
  L.g.globalCompositeOperation = 'source-over';
  L.len = n; L.first = arr[0] || null;
}
function resetLayers() { for (const L of Object.values(layers)) { L.g.clearRect(0, 0, L.c.width, L.c.height); L.len = 0; L.first = null; } paperKey = ''; }
function paintPaper() {
  const W = frame.width, H = frame.height, kind = (pages[pi] && pages[pi].paper) || '';
  const bgPg = pages[pi], bg = bgPg && bgPg.bg ? bgCache[bgPg.id] : null;
  // the page id is part of the key: every page of one PDF carries the same stamp, so the stamp alone
  // made the next page reuse the previous page's picture
  const key = `${kind}|${W}x${H}|${bg && bg.stamp === bgPg.bg ? bgPg.id + ':' + bg.stamp : 0}`;
  if (key === paperKey) return;
  paperKey = key; paperC.width = W; paperC.height = H;
  const g = pctx;
  g.fillStyle = cssVar('--paper'); g.fillRect(0, 0, W, H);
  g.fillStyle = cssVar('--rule');
  const step = 48 * view, t = Math.max(1, Math.round(dpr));
  const hasBg = bg && bg.stamp === bgPg.bg;
  if (hasBg) { /* a worksheet brings its own lines */ }
  else if (kind === 'lined') {
    for (let y = 23 * view; y < H; y += step) g.fillRect(0, Math.round(y), W, t);
    g.fillStyle = cssVar('--margin'); g.fillRect(Math.round(63 * view), 0, Math.max(1, Math.round(2 * view)), H);
  } else if (kind === 'grid') {
    for (let y = 47 * view; y < H; y += step) g.fillRect(0, Math.round(y), W, t);
    for (let x = 47 * view; x < W; x += step) g.fillRect(Math.round(x), 0, t, H);
  }
  if (bg && bg.stamp === bgPg.bg) {
    // fit the picture inside the page, centred across and starting at the top
    const k = Math.min(PAGE_W / bg.w, PAGE_H / bg.h);
    const dw = bg.w * k, dh = bg.h * k;
    g.drawImage(bg.img, Math.round((PAGE_W - dw) / 2 * view), 0, Math.round(dw * view), Math.round(dh * view));
  }
}
function redraw() {
  pendingRedraw = false;
  syncLayer(layers.base, base);
  syncLayer(layers.edit, strokes);
  paintPaper();
  fctx.globalCompositeOperation = 'source-over';
  fctx.drawImage(paperC, 0, 0);
  if (base.length) fctx.drawImage(offBase, 0, 0);
  fctx.drawImage(offEdit, 0, 0);
  for (const s of overlay) drawStroke(fctx, s);
  fctx.globalCompositeOperation = 'source-over';
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(frame, 0, 0);
}
function pt(e) {
  const r = sheet.getBoundingClientRect();
  return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale, p: e.pointerType === 'pen' ? e.pressure : 0.5 };
}
function setStatus(type) {
  if (type === 'pen') { dot.classList.add('pen'); statusText.textContent = palmBlock ? 'S펜 인식됨 · 손 터치 무시 중' : 'S펜 인식됨'; }
  else if (type === 'touch') statusText.textContent = palmBlock && !penSeen ? '아직 S펜을 못 찾아서 손가락도 써져요 · S펜을 화면에 가까이 대 보세요' : '손가락으로 쓰는 중';
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
    notePen();
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
// the S Pen reports itself while hovering above the screen, before it touches
sheet.addEventListener('pointerover', e => { if (e.pointerType === 'pen') notePen(); });
sheet.addEventListener('pointermove', e => {
  if (e.pointerType === 'pen' && !penSeen) notePen();
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
  if (wasErase || pendingRedraw || overlay.some(o => o.hl)) redraw();
  else if (overlay.length) { for (const o of overlay) drawStroke(ctx, o); ctx.globalCompositeOperation = 'source-over'; }
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
let clearMark = null;
$('undo').addEventListener('click', () => {
  if (!ready) return;
  if (strokes.length) { strokes.pop(); redraw(); markDirty(); return; }
  // nothing left to take back on this page: undo 전체 지우기
  if (clearMark && clearMark.pg === pages[pi] && clearMark.prev.length) {
    strokes.push(...clearMark.prev); clearMark = null;
    hint.hidden = true; redraw(); markDirty();
  }
});
const clearBtn = $('clear');
let armed = null;
clearBtn.addEventListener('click', () => {
  if (!ready) return;
  if (handBlocked()) return;
  if (!armed) {
    clearBtn.textContent = '한 번 더 누르면 지워져요';
    armed = setTimeout(() => { armed = null; clearBtn.textContent = '전체 지우기'; }, 2500);
    return;
  }
  clearTimeout(armed); armed = null; clearBtn.textContent = '전체 지우기';
  // remember what was there, so 되돌리기 can bring the whole page back
  clearMark = { pg: pages[pi], prev: strokes.slice() };
  strokes.length = 0; redraw(); if (mode === 'student') hint.hidden = false; markDirty();
  toast('전체를 지웠어요. 되돌리기를 누르면 다시 나와요');
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
  statusText.textContent = palmBlock ? (penSeen ? '손바닥 차단 켜짐' : '손바닥 차단 켜짐 · S펜을 한 번 대면 시작돼요') : '손바닥 차단 꺼짐 · 손가락도 써져요';
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
window.addEventListener('orientationchange', () => setTimeout(resize, 250));
window.addEventListener('resize', () => { resize(); if (!$('class').hidden) layoutKids(); });

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js').catch(() => {});

// (after every canvas exists) rebuild the page when Chrome hands back a canvas it had emptied
for (const c of [ink, live, offBase, offEdit, frame, paperC]) c.addEventListener('contextrestored', () => setTimeout(repaintAll, 0));
window.addEventListener('pageshow', () => repaintAll());
