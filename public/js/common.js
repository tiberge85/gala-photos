/* Fonctions partagées par toutes les pages */
(function () {
  const G = (window.Gala = {});

  G.esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  G.$ = (sel, root = document) => root.querySelector(sel);
  G.$$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  /* ---------- Configuration de l'événement ---------- */
  G.config = null;
  G.loadConfig = async function () {
    const r = await fetch('/api/config');
    const c = await r.json();
    G.config = c;
    const root = document.documentElement.style;
    root.setProperty('--primary', c.primaryColor);
    root.setProperty('--accent', c.accentColor);
    G.$$('[data-event-name]').forEach(el => { el.textContent = c.eventName; });
    G.$$('[data-event-subtitle]').forEach(el => { el.textContent = c.eventSubtitle; });
    G.$$('[data-organizer]').forEach(el => { el.textContent = c.organizer; el.hidden = !c.organizer; });
    G.$$('[data-logo]').forEach(el => { if (c.logo) { el.src = c.logo; el.hidden = false; } });
    const base = document.title;
    document.title = base ? `${base} · ${c.eventName}` : c.eventName;
    return c;
  };

  /* ---------- Messages ---------- */
  let toastTimer;
  G.toast = function (msg, ms = 3200) {
    let el = G.$('.toast');
    if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
    el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  };

  /* ---------- Authentification (modérateur / photographe) ---------- */
  G.token = role => { try { return localStorage.getItem('gala_token_' + role) || ''; } catch { return ''; } };
  G.setToken = (role, t) => { try { t ? localStorage.setItem('gala_token_' + role, t) : localStorage.removeItem('gala_token_' + role); } catch {} };

  G.api = async function (url, { method = 'GET', body, role } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (role) headers['x-auth-token'] = G.token(role);
    const r = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    let data = {};
    try { data = await r.json(); } catch {}
    if (!r.ok) {
      const err = new Error(data.error || `Erreur ${r.status}`);
      err.status = r.status;
      throw err;
    }
    return data;
  };

  // Branche un formulaire de connexion ; appelle onReady() une fois connecté.
  G.setupLogin = function (role, onReady) {
    const form = G.$('#login');
    const app = G.$('#app');
    const show = () => { form.hidden = true; app.hidden = false; onReady(); };
    if (G.token(role)) return show();
    form.hidden = false; app.hidden = true;
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const btn = form.querySelector('button');
      btn.disabled = true;
      try {
        const { token } = await G.api('/api/login', { method: 'POST', body: { role, password: form.password.value } });
        G.setToken(role, token);
        show();
      } catch (err) {
        G.toast(err.message);
      } finally { btn.disabled = false; }
    });
  };
  G.logout = role => { G.setToken(role, ''); location.reload(); };

  /* ---------- Compression des photos sur le téléphone ---------- */
  async function decode(file) {
    if ('createImageBitmap' in window) {
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch {}
    }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      return img;
    } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }

  // Redimensionne et ré-encode en JPEG. Si le navigateur ne sait pas lire le fichier,
  // renvoie l'original (le serveur décidera s'il l'accepte).
  G.compressImage = async function (file, maxDim = 2000, quality = 0.82) {
    try {
      const src = await decode(file);
      const w0 = src.width, h0 = src.height;
      const scale = Math.min(1, maxDim / Math.max(w0, h0));
      const w = Math.round(w0 * scale), h = Math.round(h0 * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, 0, 0, w, h);
      if (src.close) src.close();
      const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
      if (!blob) throw new Error('toBlob');
      // Si la "compression" grossit le fichier d'une petite photo, on garde l'original.
      if (scale === 1 && blob.size > file.size && /jpe?g/i.test(file.type)) return { blob: file, width: w, height: h };
      return { blob, width: w, height: h };
    } catch {
      return { blob: file, width: null, height: null };
    }
  };

  /* ---------- Envoi avec progression ---------- */
  G.uploadFile = function (url, fields, blob, { role, onProgress } = {}) {
    return new Promise((resolve, reject) => {
      const fd = new FormData();
      Object.entries(fields).forEach(([k, v]) => { if (v !== undefined && v !== null) fd.append(k, v); });
      fd.append('photo', blob, (blob.name || 'photo.jpg'));
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      if (role) xhr.setRequestHeader('x-auth-token', G.token(role));
      xhr.timeout = 120000;
      xhr.upload.onprogress = e => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else { const e = new Error(data.error || `Erreur ${xhr.status}`); e.status = xhr.status; reject(e); }
      };
      xhr.onerror = () => { const e = new Error('Connexion perdue'); e.network = true; reject(e); };
      xhr.ontimeout = () => { const e = new Error('Délai dépassé'); e.network = true; reject(e); };
      xhr.send(fd);
    });
  };

  // Exécute des tâches avec un nombre limité en parallèle.
  G.runPool = async function (tasks, concurrency) {
    let i = 0;
    const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
      while (i < tasks.length) { const t = tasks[i++]; await t(); }
    });
    await Promise.all(workers);
  };

  G.sleep = ms => new Promise(r => setTimeout(r, ms));

  G.timeAgo = function (iso) {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'à l’instant';
    if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
    if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
    return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  };

  /* ---------- Visionneuse plein écran ---------- */
  G.lightbox = function (items, index, { extraButtons } = {}) {
    let i = index;
    const el = document.createElement('div');
    el.className = 'lightbox';
    el.innerHTML = `
      <div class="lb-img"><img alt=""></div>
      <button class="lb-nav lb-prev" aria-label="Précédente">‹</button>
      <button class="lb-nav lb-next" aria-label="Suivante">›</button>
      <div class="lb-meta"></div>
      <div class="lb-bar">
        <a class="btn btn-primary lb-dl" download>⬇ Télécharger</a>
        <button class="btn lb-share" hidden>Partager</button>
        <button class="btn btn-ghost lb-close">Fermer</button>
      </div>`;
    document.body.appendChild(el);
    document.body.style.overflow = 'hidden';
    const img = el.querySelector('img');
    const shareBtn = el.querySelector('.lb-share');
    if (navigator.share) shareBtn.hidden = false;

    function render() {
      const it = items[i];
      img.src = it.url;
      el.querySelector('.lb-dl').href = it.download;
      el.querySelector('.lb-meta').textContent = [it.album, `${i + 1} / ${items.length}`].filter(Boolean).join(' · ');
      el.querySelector('.lb-prev').hidden = i === 0;
      el.querySelector('.lb-next').hidden = i === items.length - 1;
      if (extraButtons) extraButtons(el.querySelector('.lb-bar'), it, close);
    }
    function close() {
      el.remove(); document.body.style.overflow = ''; document.removeEventListener('keydown', onKey);
    }
    function go(d) { const n = i + d; if (n >= 0 && n < items.length) { i = n; render(); } }
    function onKey(e) {
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowLeft') go(-1);
      if (e.key === 'ArrowRight') go(1);
    }
    el.querySelector('.lb-prev').onclick = () => go(-1);
    el.querySelector('.lb-next').onclick = () => go(1);
    el.querySelector('.lb-close').onclick = close;
    shareBtn.onclick = async () => {
      try { await navigator.share({ title: G.config?.eventName, url: items[i].url }); } catch {}
    };
    // Balayage gauche/droite sur mobile
    let x0 = null;
    el.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; }, { passive: true });
    el.addEventListener('touchend', e => {
      if (x0 === null) return;
      const dx = e.changedTouches[0].clientX - x0;
      if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
      x0 = null;
    });
    el.querySelector('.lb-img').addEventListener('click', e => { if (e.target === e.currentTarget) close(); });
    document.addEventListener('keydown', onKey);
    render();
    return { close };
  };
})();
