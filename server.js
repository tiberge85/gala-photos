require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const compression = require('compression');
const multer = require('multer');
const QRCode = require('qrcode');
const { ZipArchive } = require('archiver');
const { createStorage } = require('./lib/storage');

/* ------------------------------------------------------------------ */
/* Configuration (variables d'environnement)                           */
/* ------------------------------------------------------------------ */
const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const CONFIG = {
  port: Number(env('PORT', 3000)),
  eventName: env('EVENT_NAME', 'Gala de la Jeunesse'),
  eventSubtitle: env('EVENT_SUBTITLE', 'Un selfie suffit pour retrouver vos photos de la soirée'),
  eventSlug: env('EVENT_SLUG', 'gala-ebpa').toLowerCase().replace(/[^a-z0-9-]/g, '-'),
  organizer: env('ORGANIZER', ''),
  publicUrl: env('PUBLIC_URL', '').replace(/\/$/, ''),
  albums: env('ALBUMS', 'Accueil,Cérémonie,Soirée').split(',').map(s => s.trim()).filter(Boolean),
  adminPassword: env('ADMIN_PASSWORD', env('MODERATOR_PASSWORD', 'admin')),
  photographerPassword: env('PHOTOGRAPHER_PASSWORD', 'photographe'),
  secret: env('APP_SECRET', 'change-moi-' + env('ADMIN_PASSWORD', env('MODERATOR_PASSWORD', ''))),
  publicGallery: env('PUBLIC_GALLERY', 'true') !== 'false',
  // Distance maximale entre deux empreintes pour considérer que c'est la même personne.
  // Plus petit = plus strict (moins de fausses photos, mais risque d'en manquer).
  matchThreshold: Number(env('FACE_MATCH_THRESHOLD', 0.5)),
  // Visages un peu au-delà du seuil : proposés à l'invité (« Est-ce vous ? »).
  candidateMargin: Number(env('FACE_CANDIDATE_MARGIN', 0.1)),
  primaryColor: env('PRIMARY_COLOR', '#1a3a5c'),
  accentColor: env('ACCENT_COLOR', '#F29F2F'),
  maxUploadMb: Number(env('MAX_UPLOAD_MB', 12)),
  searchesPer15Min: Number(env('SEARCH_LIMIT', 120)),
  dataDir: env('DATA_DIR', path.join(__dirname, 'data')),
};

const storage = createStorage({ slug: CONFIG.eventSlug, dataDir: CONFIG.dataDir });

/* ------------------------------------------------------------------ */
/* Index en mémoire                                                    */
/* ------------------------------------------------------------------ */
const photos = new Map(); // id -> item (faces converties en Float32Array)
let version = 0;
const stats = { searches: 0, searchesWithResults: 0 };
const bump = () => { version += 1; };

// Une entrée de "faces" est { d: empreinte, b: [x, y, l, h] } (ou une simple empreinte, ancien format).
function addToIndex(item) {
  const faces = item.faces || [];
  item.vectors = faces.map(f => Float32Array.from(Array.isArray(f) ? f : f.d));
  item.boxes = faces.map(f => (Array.isArray(f) ? null : f.b || null));
  photos.set(item.id, item);
}
const faceKey = (id, i) => `${id}|${i}`;
function faceFromKey(key) {
  const k = String(key); const cut = k.lastIndexOf('|');
  const p = photos.get(k.slice(0, cut)); const i = Number(k.slice(cut + 1));
  return p && Number.isInteger(i) && p.vectors[i] ? { p, i } : null;
}

const byNewest = (a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0);
const publicView = it => ({
  id: it.id, album: it.album, createdAt: it.createdAt, width: it.width, height: it.height,
  url: it.url, thumb: it.thumb, download: it.download,
});

function distance(a, b) {
  let s = 0;
  for (let i = 0; i < 128; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}

function validDescriptor(d) {
  return Array.isArray(d) && d.length === 128 && d.every(x => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) < 10);
}
function validFace(f) {
  if (Array.isArray(f)) return validDescriptor(f);
  return f && validDescriptor(f.d) && Array.isArray(f.b) && f.b.length === 4
    && f.b.every(x => typeof x === 'number' && Number.isFinite(x) && x > -1 && x < 2);
}

/* ------------------------------------------------------------------ */
/* Authentification simple par rôle                                    */
/* ------------------------------------------------------------------ */
const ROLES = {
  admin: () => CONFIG.adminPassword,
  photographer: () => CONFIG.photographerPassword,
};
const tokenFor = role =>
  role + '.' + crypto.createHmac('sha256', CONFIG.secret).update(role + ':' + ROLES[role]()).digest('hex').slice(0, 40);

function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function roleFromReq(req) {
  const t = req.get('x-auth-token') || '';
  const role = t.split('.')[0];
  if (!ROLES[role]) return null;
  return safeEqual(t, tokenFor(role)) ? role : null;
}
const requireRole = (...allowed) => (req, res, next) => {
  const role = roleFromReq(req);
  if (!role || !allowed.includes(role)) return res.status(401).json({ error: 'Accès refusé. Reconnectez-vous.' });
  req.role = role;
  next();
};

/* ------------------------------------------------------------------ */
/* Limitation du nombre de recherches par appareil                     */
/* ------------------------------------------------------------------ */
function limiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (!v.some(t => now - t < windowMs)) hits.delete(k);
  }, 5 * 60 * 1000).unref();
  return (req, res, next) => {
    const now = Date.now();
    const list = (hits.get(req.ip) || []).filter(t => now - t < windowMs);
    if (list.length >= max) return res.status(429).json({ error: 'Trop de recherches en peu de temps. Réessayez dans quelques minutes.' });
    list.push(now);
    hits.set(req.ip, list);
    next();
  };
}
const searchLimit = limiter(CONFIG.searchesPer15Min, 15 * 60 * 1000);
const zipLimit = limiter(20, 15 * 60 * 1000);

/* ------------------------------------------------------------------ */
/* Réception des fichiers                                              */
/* ------------------------------------------------------------------ */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CONFIG.maxUploadMb * 1024 * 1024, files: 1, fieldSize: 2 * 1024 * 1024 },
});

function detectImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const cleanText = (s, max) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);

/* ------------------------------------------------------------------ */
/* Application                                                         */
/* ------------------------------------------------------------------ */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(compression());
app.use(express.json({ limit: '50kb' }));

app.get('/healthz', (req, res) => res.json({ ok: true, photos: photos.size, storage: storage.kind }));

app.get('/api/config', (req, res) => {
  res.json({
    eventName: CONFIG.eventName,
    eventSubtitle: CONFIG.eventSubtitle,
    organizer: CONFIG.organizer,
    albums: CONFIG.albums,
    publicGallery: CONFIG.publicGallery,
    primaryColor: CONFIG.primaryColor,
    accentColor: CONFIG.accentColor,
    publicUrl: CONFIG.publicUrl || `${req.protocol}://${req.get('host')}`,
    photoCount: photos.size,
    storage: storage.kind,
  });
});

// Toutes les photos (galerie publique et écran) — réservé à l'admin si PUBLIC_GALLERY=false
app.get('/api/photos', (req, res, next) => {
  if (CONFIG.publicGallery) return next();
  return requireRole('admin')(req, res, next);
}, (req, res) => {
  const v = Number(req.query.v);
  res.set('Cache-Control', 'no-store');
  if (v && v === version) return res.json({ version, unchanged: true });
  res.json({ version, items: [...photos.values()].sort(byNewest).map(publicView) });
});

// Recherche par selfie : le navigateur envoie uniquement l'empreinte du visage (128 nombres),
// jamais la photo du selfie. "confirmed" / "rejected" : visages que l'invité a validés ou refusés
// (« Est-ce vous ? »). Les visages confirmés servent de références supplémentaires.
app.post('/api/search', searchLimit, (req, res) => {
  const body = req.body || {};
  if (!validDescriptor(body.descriptor)) return res.status(400).json({ error: 'Empreinte de visage invalide.' });
  const keys = v => (Array.isArray(v) ? v.slice(0, 200).map(String) : []);
  const confirmed = keys(body.confirmed).map(faceFromKey).filter(Boolean);
  const rejected = new Set(keys(body.rejected));
  const queries = [Float32Array.from(body.descriptor), ...confirmed.slice(0, 30).map(c => c.p.vectors[c.i])];
  const confirmedPhotos = new Set(confirmed.map(c => c.p.id));
  const T = CONFIG.matchThreshold;
  const W = CONFIG.candidateMargin;

  const results = [];
  const candidates = [];
  for (const p of photos.values()) {
    let best = Infinity;
    const dists = p.vectors.map(v => {
      let m = Infinity;
      for (const q of queries) { const d = distance(q, v); if (d < m) m = d; }
      if (m < best) best = m;
      return m;
    });
    if (best <= T || confirmedPhotos.has(p.id)) { results.push(p); continue; }
    dists.forEach((d, i) => {
      const key = faceKey(p.id, i);
      if (d <= T + W && !rejected.has(key)) candidates.push({ d, key, p, i });
    });
  }
  results.sort(byNewest);
  candidates.sort((a, b) => a.d - b.d);
  // Un seul visage proposé par photo, 6 maximum à la fois
  const seen = new Set();
  const proposals = [];
  for (const c of candidates) {
    if (seen.has(c.p.id)) continue;
    seen.add(c.p.id);
    proposals.push({ key: c.key, box: c.p.boxes[c.i], photo: publicView(c.p) });
    if (proposals.length >= 6) break;
  }
  stats.searches += 1;
  if (results.length) stats.searchesWithResults += 1;
  res.set('Cache-Control', 'no-store');
  res.json({
    count: results.length,
    total: photos.size,
    version,
    items: results.slice(0, 500).map(publicView),
    candidates: proposals,
  });
});

// Téléchargement groupé en ZIP
app.get('/api/zip', zipLimit, async (req, res) => {
  try {
  const ids = String(req.query.ids || '').split(',').filter(id => photos.has(id)).slice(0, 300);
  if (!ids.length) return res.status(400).json({ error: 'Aucune photo à télécharger.' });
  const slug = CONFIG.eventSlug;
  res.attachment(`${slug}-mes-photos.zip`);
  const zip = new ZipArchive({ store: true });
  zip.on('error', err => { console.error('ZIP :', err.message); res.destroy(err); });
  zip.pipe(res);
  let n = 0;
  for (const id of ids) {
    const it = photos.get(id);
    if (!it) continue;
    try {
      const stream = await storage.read(it);
      n += 1;
      await new Promise((resolve, reject) => {
        stream.on('error', reject);
        stream.on('end', resolve);
        zip.append(stream, { name: `${slug}-${String(n).padStart(3, '0')}.jpg` });
      });
    } catch (e) {
      console.error('ZIP, photo ignorée :', id, e.message);
    }
  }
  zip.finalize();
  } catch (e) {
    console.error('ZIP :', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Téléchargement impossible.' }); else res.destroy();
  }
});

// Connexion admin / photographe
app.post('/api/login', (req, res) => {
  const { role, password } = req.body || {};
  if (!ROLES[role]) return res.status(400).json({ error: 'Rôle inconnu.' });
  const ok = safeEqual(password || '', ROLES[role]())
    || (role === 'photographer' && safeEqual(password || '', CONFIG.adminPassword));
  if (!ok) return res.status(401).json({ error: 'Mot de passe incorrect.' });
  res.json({ token: tokenFor(role), role });
});

// Envoi par le photographe. Le navigateur du photographe a déjà calculé
// l'empreinte de chaque visage présent sur la photo (champ "faces").
app.post('/api/photographer/upload', requireRole('photographer', 'admin'), (req, res) => {
  upload.single('photo')(req, res, async err => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `Photo trop lourde (max ${CONFIG.maxUploadMb} Mo).` : 'Envoi invalide.';
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: 'Aucune photo reçue.' });
    const mimetype = detectImage(req.file.buffer);
    if (!mimetype) return res.status(415).json({ error: 'Format non pris en charge (JPEG, PNG ou WebP).' });
    let faces = [];
    try { faces = JSON.parse(req.body.faces || '[]'); } catch { faces = null; }
    if (!Array.isArray(faces) || faces.length > 200 || !faces.every(validFace)) {
      return res.status(400).json({ error: 'Données de visages invalides.' });
    }
    const r5 = x => Math.round(x * 1e5) / 1e5;
    faces = faces.map(f => (Array.isArray(f) ? { d: f.map(r5), b: null } : { d: f.d.map(r5), b: f.b.map(r5) }));
    const meta = {
      album: cleanText(req.body.album, 40) || 'Photographe',
      width: Number(req.body.width) || null,
      height: Number(req.body.height) || null,
    };
    try {
      const item = await storage.save({ buffer: req.file.buffer, mimetype, meta, faces });
      addToIndex(item);
      bump();
      res.json({ ok: true, id: item.id, faces: faces.length });
    } catch (e) {
      console.error('Échec de l’enregistrement :', e.message || e);
      res.status(502).json({ error: 'Le stockage n’a pas répondu. Réessayez.' });
    }
  });
});

// Administration
app.get('/api/admin/photos', requireRole('admin'), (req, res) => {
  const all = [...photos.values()].sort(byNewest);
  res.set('Cache-Control', 'no-store');
  res.json({
    version,
    items: all.map(p => ({ ...publicView(p), faceCount: p.vectors.length })),
    stats: {
      photos: all.length,
      faces: all.reduce((s, p) => s + p.vectors.length, 0),
      noFace: all.filter(p => !p.vectors.length).length,
      searches: stats.searches,
      searchesWithResults: stats.searchesWithResults,
      threshold: CONFIG.matchThreshold,
      candidateMargin: CONFIG.candidateMargin,
    },
  });
});

app.post('/api/admin/delete', requireRole('admin'), async (req, res) => {
  const ids = (Array.isArray(req.body && req.body.ids) ? req.body.ids.map(String) : [])
    .filter(id => photos.has(id)).slice(0, 1000);
  if (!ids.length) return res.json({ ok: true, count: 0 });
  try {
    await storage.remove(ids);
    ids.forEach(id => photos.delete(id));
    bump();
    res.json({ ok: true, count: ids.length });
  } catch (e) {
    console.error(e); res.status(502).json({ error: 'Échec de la suppression. Réessayez.' });
  }
});

// QR code (SVG) pointant vers une page de l'application
app.get('/api/qr.svg', async (req, res) => {
  const base = CONFIG.publicUrl || `${req.protocol}://${req.get('host')}`;
  const p = String(req.query.path || '/');
  const target = /^\/[a-z0-9\-_/]*$/i.test(p) ? base + p : base + '/';
  const svg = await QRCode.toString(target, {
    type: 'svg', errorCorrectionLevel: 'M', margin: 1, color: { dark: '#000000', light: '#00000000' },
  });
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=300').send(svg);
});

// Bibliothèque de reconnaissance faciale et ses modèles (servis par notre propre serveur)
const faceApiDir = path.dirname(require.resolve('@vladmandic/face-api/package.json'));
app.use('/vendor/face-api', express.static(path.join(faceApiDir, 'dist'), { maxAge: '30d' }));
app.use('/vendor/face-models', express.static(path.join(faceApiDir, 'model'), { maxAge: '30d' }));

// Fichiers stockés en local (mode test)
if (storage.kind === 'local') {
  app.use('/media', (req, res, next) => {
    if (req.query.download) {
      const file = path.join(storage.mediaDir, path.basename(req.path));
      return res.download(file, err => { if (err && !res.headersSent) res.status(404).end(); });
    }
    next();
  }, express.static(storage.mediaDir, { maxAge: '7d', immutable: true }));
}

// Pages
const pub = path.join(__dirname, 'public');
const pages = {
  '/': 'index.html', '/galerie': 'galerie.html', '/admin': 'admin.html',
  '/photographe': 'photographe.html', '/ecran': 'ecran.html', '/qr': 'qr.html',
};
for (const [route, file] of Object.entries(pages)) {
  app.get(route, (req, res) => res.sendFile(path.join(pub, file)));
}
app.get('/moderation', (req, res) => res.redirect('/admin'));
app.use(express.static(pub, { maxAge: '1h' }));
app.use((req, res) => res.status(404).sendFile(path.join(pub, 'index.html')));

/* ------------------------------------------------------------------ */
/* Démarrage                                                           */
/* ------------------------------------------------------------------ */
process.on('unhandledRejection', e => console.error('Erreur non gérée :', e && e.message));

(async () => {
  for (let attempt = 1; ; attempt++) {
    try {
      const items = await storage.init();
      items.forEach(addToIndex);
      break;
    } catch (e) {
      console.error(`Chargement de l’index impossible (tentative ${attempt}) :`, e.message || e);
      if (attempt >= 5) process.exit(1);
      await new Promise(r => setTimeout(r, 3000 * attempt));
    }
  }
  bump();
  app.listen(CONFIG.port, () => {
    const faces = [...photos.values()].reduce((s, p) => s + p.vectors.length, 0);
    console.log(`${CONFIG.eventName} — ${photos.size} photo(s), ${faces} visage(s) — stockage : ${storage.kind}`);
    console.log(`Prêt sur http://localhost:${CONFIG.port}`);
    if (CONFIG.adminPassword === 'admin') console.warn('⚠ Mot de passe admin par défaut : définissez ADMIN_PASSWORD.');
  });
})();
