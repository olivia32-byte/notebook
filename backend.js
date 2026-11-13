// Firebase connection. Exposes a small database API (doc / collection / get / set / onSnapshot)
// and the sign-in helpers the app needs, so app.js never touches Firebase directly.
const V = '10.12.2';
const base = `https://www.gstatic.com/firebasejs/${V}`;

export async function createBackend(config) {
  const { initializeApp } = await import(`${base}/firebase-app.js`);
  const fa = await import(`${base}/firebase-auth.js`);
  const fs = await import(`${base}/firebase-firestore.js`);

  const app = initializeApp(config);
  const auth = fa.getAuth(app);
  // offline cache: a tablet that loses Wi-Fi keeps writing and syncs when it is back
  let firestore;
  try { firestore = fs.initializeFirestore(app, { localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }) }); }
  catch (e) { firestore = fs.getFirestore(app); }

  const snap = s => ({ id: s.id, exists: s.exists(), data: () => s.data(), metadata: s.metadata });
  const qsnap = s => ({ docs: s.docs.map(snap), size: s.size, empty: s.empty, metadata: s.metadata });
  function wrapDoc(ref) {
    return {
      id: ref.id, path: ref.path,
      async get() { return snap(await fs.getDoc(ref)); },
      // the copy already on this tablet (no network); null when there is none
      async getCache() { try { return snap(await fs.getDocFromCache(ref)); } catch (e) { return null; } },
      set(d) { return fs.setDoc(ref, d); },
      update(d) { return fs.updateDoc(ref, d); },
      delete() { return fs.deleteDoc(ref); },
      collection(p) { return wrapCol(fs.collection(ref, p)); },
      onSnapshot(next, err) { return fs.onSnapshot(ref, s => next(snap(s)), err); },
    };
  }
  function wrapCol(ref, q = ref) {
    return {
      path: ref.path,
      doc(id) { return wrapDoc(id ? fs.doc(ref, id) : fs.doc(ref)); },
      async add(d) { return wrapDoc(await fs.addDoc(ref, d)); },
      orderBy(f, dir) { return wrapCol(ref, fs.query(q, fs.orderBy(f, dir))); },
      where(f, op, v) { return wrapCol(ref, fs.query(q, fs.where(f, op, v))); },
      limit(n) { return wrapCol(ref, fs.query(q, fs.limit(n))); },
      async get() { return qsnap(await fs.getDocs(q)); },
      onSnapshot(next, err) { return fs.onSnapshot(q, s => next(qsnap(s)), err); },
    };
  }
  const db = {
    doc: p => wrapDoc(fs.doc(firestore, p)),
    collection: p => wrapCol(fs.collection(firestore, p)),
  };

  // a second, separate sign-in slot so a teacher can create student accounts without being signed out
  let helperAuth = null;
  const helper = () => helperAuth || (helperAuth = fa.getAuth(initializeApp(config, 'enroll')));

  const toUser = u => u && { uid: u.uid, email: u.email || '', name: u.displayName || '', isGoogle: u.providerData.some(p => p.providerId === 'google.com') };

  return {
    db,
    onAuth(cb) { return fa.onAuthStateChanged(auth, u => cb(toUser(u))); },
    async teacherLogin() {
      const provider = new fa.GoogleAuthProvider();
      try { await fa.signInWithPopup(auth, provider); }
      catch (e) {
        if (e && (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment')) await fa.signInWithRedirect(auth, provider);
        else throw e;
      }
    },
    async studentLogin(email, pin) { await fa.signInWithEmailAndPassword(auth, email, pin); },
    async createStudentAccount(email, pin) {
      const h = helper();
      const cred = await fa.createUserWithEmailAndPassword(h, email, pin);
      const uid = cred.user.uid;
      await fa.signOut(h);
      return uid;
    },
    logout() { return fa.signOut(auth); },
  };
}
