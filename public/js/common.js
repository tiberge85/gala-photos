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
    const brandName = (c.brand && c.brand.name) || '';
    if (!document.body.hasAttribute('data-keep-title')) {
      document.title = [base, c.eventName, brandName].filter(Boolean).join(' · ');
    }
    // Icône MEDIART dans l'onglet
    if (!document.querySelector('link[rel=icon]')) {
      const l = document.createElement('link'); l.rel = 'icon'; l.type = 'image/svg+xml'; l.href = '/img/mediart-icon.svg';
      document.head.appendChild(l);
    }
    G.$$('[data-brand-bar]').forEach(el => G.renderBrandBar(el));
    G.$$('[data-mediart-promo]').forEach(el => G.renderMediartPromo(el));
    return c;
  };

  /* ---------- Compte à rebours (J-…) ---------- */
  G.renderCountdown = function (el, schedule) {
    el = typeof el === 'string' ? G.$(el) : el;
    const items = (schedule || []).map(s => ({ ...s, s: new Date(s.start).getTime(), e: new Date(s.end || s.start).getTime() }))
      .filter(s => !isNaN(s.s)).sort((a, b) => a.s - b.s);
    if (!el || !items.length) return;
    const pad = n => String(n).padStart(2, '0');
    const fmtDate = t => new Date(t).toLocaleString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Abidjan' }).replace(':', 'h');
    const dayKey = t => new Date(t).toLocaleDateString('fr-CA', { timeZone: 'Africa/Abidjan' });
    let lastHtmlKey = '';
    function tick() {
      const now = Date.now();
      const live = items.find(x => now >= x.s && now < x.e);
      const next = items.find(x => now < x.s);
      let key, html;
      if (live) {
        key = 'live' + live.s;
        html = `<div class="cd-live"><span class="cd-dot"></span>En direct</div>
          <div class="cd-title">${G.esc(live.title)}</div>
          <div class="cd-sub">Les photos arrivent au fil de l’événement : faites votre selfie !</div>`;
      } else if (next) {
        const diff = next.s - now;
        const d = Math.floor(diff / 864e5), h = Math.floor(diff / 36e5) % 24, m = Math.floor(diff / 6e4) % 60, s = Math.floor(diff / 1e3) % 60;
        const today = dayKey(now) === dayKey(next.s);
        const jDays = Math.round((new Date(dayKey(next.s)) - new Date(dayKey(now))) / 864e5);
        const badge = today ? 'C’est aujourd’hui !' : `J-${jDays}`;
        key = 'next' + next.s;
        html = `<div class="cd-badge">${badge}</div>
          <div class="cd-title">${G.esc(next.title)}</div>
          <div class="cd-sub">${G.esc(fmtDate(next.s))}</div>
          <div class="cd-grid">
            ${d ? `<div><b>${d}</b><span>jour${d > 1 ? 's' : ''}</span></div>` : ''}
            <div><b>${pad(h)}</b><span>heures</span></div>
            <div><b>${pad(m)}</b><span>min</span></div>
            <div><b>${pad(s)}</b><span>sec</span></div>
          </div>`;
      } else {
        el.hidden = true; return;
      }
      el.hidden = false;
      if (key === lastHtmlKey && el.querySelector('.cd-grid')) {
        // mise à jour des chiffres seulement (pas de clignotement)
        const tmp = document.createElement('div'); tmp.innerHTML = html;
        el.querySelector('.cd-grid').innerHTML = tmp.querySelector('.cd-grid').innerHTML;
        el.querySelector('.cd-badge').textContent = tmp.querySelector('.cd-badge').textContent;
      } else { el.innerHTML = html; lastHtmlKey = key; }
    }
    tick();
    setInterval(tick, 1000);
  };

  /* ---------- Marque MEDIART ---------- */
  const fmtPhone = n => {
    const d = String(n || '').replace(/[^\d]/g, '');
    const local = d.startsWith('225') && d.length === 13 ? d.slice(3) : d;
    return (d.startsWith('225') ? '+225 ' : '') + local.replace(/(\d{2})(?=\d)/g, '$1 ').trim();
  };
  const intl = n => {
    const d = String(n || '').replace(/[^\d]/g, '');
    return d.length === 10 ? '225' + d : d;
  };
  G.brand = () => (G.config && G.config.brand) || {};
  G.brandLinks = () => {
    const b = G.brand();
    const msg = encodeURIComponent(`Bonjour ${b.company || 'MEDIART'}, j’ai découvert ${b.name || 'MEDIART Live'} et je souhaite l’avoir pour mon événement.`);
    return {
      whatsapp: b.whatsapp ? `https://wa.me/${intl(b.whatsapp)}?text=${msg}` : '',
      whatsappLabel: fmtPhone(b.whatsapp),
      tel: b.phone ? `tel:+${intl(b.phone)}` : '',
      telLabel: fmtPhone(b.phone),
      mail: b.email ? `mailto:${b.email}?subject=${encodeURIComponent((b.name || 'MEDIART Live') + ' pour mon événement')}` : '',
      facebook: b.facebook || '',
    };
  };
  // Logo texte : MEDI A(rouge) RT + pastille LIVE
  G.brandLogo = (cls = '') => {
    const b = G.brand();
    if (b.logo) return `<img class="ml-img ${cls}" src="${G.esc(b.logo)}" alt="${G.esc(b.name || 'MEDIART')}">`;
    const suffix = (b.name || 'MEDIART Live').replace(/^\s*mediart\s*/i, '');
    return `<span class="ml-logo ${cls}" aria-label="${G.esc(b.name || 'MEDIART Live')}">MEDI<span class="a">A</span>RT${suffix ? `<span class="live">${G.esc(suffix)}</span>` : ''}</span>`;
  };
  G.renderBrandBar = el => {
    el.innerHTML = `<a href="/mediart" class="brandbar-in">
      <img src="/img/mediart-icon.svg" alt="" class="ml-icon"><span class="pp">Propulsé par</span>${G.brandLogo('sm')}</a>`;
    el.hidden = false;
  };
  G.renderMediartPromo = el => {
    const b = G.brand(), L = G.brandLinks();
    el.innerHTML = `
      <div class="mp-head"><img src="/img/mediart-icon.svg" alt="" class="ml-icon lg">${G.brandLogo('md')}</div>
      <p class="mp-title">Vous organisez un événement ?</p>
      <p class="mp-text">Mariage, anniversaire, baptême, gala, conférence, séminaire… <strong>${G.esc(b.company || 'MEDIART')}</strong> installe ce même service pour vous :
        vos invités retrouvent <strong>leurs photos en temps réel</strong> avec un simple selfie, sans application.</p>
      <div class="mp-actions">
        ${L.whatsapp ? `<a class="btn btn-wa" href="${L.whatsapp}" target="_blank" rel="noopener">💬 WhatsApp ${G.esc(L.whatsappLabel)}</a>` : ''}
        ${L.tel ? `<a class="btn btn-ghost" href="${L.tel}">📞 ${G.esc(L.telLabel)}</a>` : ''}
      </div>
      <a class="mp-more" href="/mediart">Découvrir ${G.esc(b.name || 'MEDIART Live')} →</a>`;
    el.hidden = false;
  };

  /* ---------- Visuels du week-end qui défilent en fond ---------- */
  G.startBackground = function (list, every = 7000) {
    if (!list || !list.length) return;
    const box = document.createElement('div');
    box.className = 'bgfx';
    box.setAttribute('aria-hidden', 'true');
    box.innerHTML = '<img alt=""><img alt=""><div class="veil"></div>';
    document.body.prepend(box);
    const [a, b] = box.querySelectorAll('img');
    let i = 0, front = a;
    a.src = list[0]; a.classList.add('on');
    if (list.length < 2) return;
    setInterval(() => {
      i = (i + 1) % list.length;
      const back = front === a ? b : a;
      back.onload = () => { back.classList.add('on'); front.classList.remove('on'); front = back; };
      back.src = list[i];
    }, every);
  };

  /* ---------- Encart « Au programme ce week-end » ---------- */
  G.renderProgramme = function (el, list) {
    el = typeof el === 'string' ? G.$(el) : el;
    if (!el || !list || !list.length) return;
    el.innerHTML = `<span class="kicker">Au programme ce week-end</span>
      <div class="prog-track">${list.map(src => `<img src="${G.esc(src)}" alt="" loading="lazy">`).join('')}</div>
      ${list.length > 2 ? `<div class="prog-dots">${list.map((_, i) => `<span class="${i ? '' : 'on'}"></span>`).join('')}</div>` : ''}`;
    el.hidden = false;
    const track = el.querySelector('.prog-track');
    el.querySelectorAll('img').forEach((img, i) => {
      img.onclick = () => G.lightbox(list.map(src => ({ url: src, download: src, album: 'Programme du week-end' })), i);
    });
    // Défilement automatique quand il y a plus de visuels que de places
    if (list.length > 2) {
      let k = 0;
      setInterval(() => {
        k = (k + 1) % list.length;
        track.scrollTo({ left: track.children[k].offsetLeft - track.offsetLeft, behavior: 'smooth' });
        el.querySelectorAll('.prog-dots span').forEach((d, j) => d.classList.toggle('on', j === k));
      }, 4000);
    }
  };

  /* ---------- Bandeau des partenaires ---------- */
  G.renderPartners = async function (el) {
    el = typeof el === 'string' ? G.$(el) : el;
    if (!el) return [];
    let items = [];
    try { items = (await G.api('/api/partners')).items; } catch {}
    if (!items.length) { el.hidden = true; return items; }
    const card = p => {
      const inner = `<span class="plogo"><img src="${G.esc(p.logo)}" alt="${G.esc(p.name)}" loading="lazy"></span><span class="pname">${G.esc(p.name)}</span>`;
      return p.url ? `<a class="partner" href="${G.esc(p.url)}" target="_blank" rel="noopener sponsored">${inner}</a>` : `<div class="partner">${inner}</div>`;
    };
    const many = items.length > 2;
    const row = items.map(card).join('');
    el.innerHTML = `<p class="kicker">Nos partenaires</p>
      <div class="ptrack${many ? ' scroll' : ''}"><div class="prow">${row}${many ? row : ''}</div></div>`;
    if (many) el.querySelector('.prow').style.animationDuration = `${Math.max(18, items.length * 6)}s`;
    el.hidden = false;
    return items;
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
  G.uploadFile = function (url, fields, blob, { role, onProgress, field = 'photo' } = {}) {
    return new Promise((resolve, reject) => {
      const fd = new FormData();
      Object.entries(fields).forEach(([k, v]) => { if (v !== undefined && v !== null) fd.append(k, v); });
      fd.append(field, blob, (blob.name || 'photo.jpg'));
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
