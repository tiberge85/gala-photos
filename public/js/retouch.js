/* Retouche automatique des photos du photographe — MEDIART Live
   Uniquement des réglages globaux (comme dans Lightroom) : rien ne redessine les visages.
   - Niveaux automatiques (points noir / blanc) et exposition : les photos sombres de soirée sont remontées
   - Ombres débouchées et contraste doux en « S »
   - Couleurs plus gaies : vibrance (sans saturer les tons chair) et légère chaleur
   - Netteté légère
   - Recadrage léger guidé par les visages (jamais de visage coupé)                                    */
(function () {
  const R = (window.Gala.retouch = {});

  // Intensités proposées au photographe
  R.LEVELS = { 0: 'Aucune', 0.6: 'Légère', 1: 'Normale', 1.4: 'Forte' };

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  /* ---------- Analyse ---------- */
  function analyze(data) {
    const hist = new Uint32Array(256);
    let n = 0;
    // échantillonne 1 pixel sur 4 (largement suffisant)
    for (let i = 0; i < data.length; i += 16) {
      const l = (data[i] * 54 + data[i + 1] * 183 + data[i + 2] * 19) >> 8;
      hist[l]++; n++;
    }
    const pct = p => { let acc = 0; const target = n * p; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= target) return v; } return 255; };
    let sum = 0; for (let v = 0; v < 256; v++) sum += v * hist[v];
    return { low: pct(0.005), high: pct(0.995), median: pct(0.5), mean: sum / n / 255 };
  }

  /* ---------- Courbe de tons (table de 256 valeurs) ---------- */
  function toneLUT(stats, k) {
    // points noir/blanc limités pour ne jamais « brûler » l'image
    const black = Math.min(stats.low, 28) * k * 0.9;
    const white = 255 - Math.min(255 - stats.high, 40) * k * 0.9;
    // exposition : vise une luminosité moyenne agréable pour une soirée (≈ 0,47)
    const m = clamp(stats.mean, 0.05, 0.95);
    let gamma = Math.log(0.47) / Math.log(m);
    gamma = clamp(1 + (gamma - 1) * k, 0.62, 1.25); // < 1 éclaircit
    const shadows = 0.10 * k;  // débouche les ombres
    const contrast = 0.12 * k; // S doux
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) {
      let x = clamp((v - black) / Math.max(1, white - black), 0, 1);
      x = Math.pow(x, gamma);
      x = x + shadows * x * Math.pow(1 - x, 3) * 2.2;           // remonte surtout les tons sombres
      x = x + contrast * (x - 0.5) * (1 - Math.abs(2 * x - 1));  // courbe en S autour du milieu
      lut[v] = Math.round(clamp(x, 0, 1) * 255);
    }
    return lut;
  }

  /* ---------- Application ---------- */
  // Modifie le canvas sur place. k : intensité (0 = rien, 1 = normale).
  R.apply = function (canvas, k = 1) {
    if (!k) return { applied: false };
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const { width: W, height: H } = canvas;
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data;
    const stats = analyze(d);
    const lut = toneLUT(stats, k);
    const vib = 0.28 * k;   // vibrance
    const warmR = 1 + 0.025 * k, warmB = 1 - 0.03 * k; // légère chaleur

    for (let i = 0; i < d.length; i += 4) {
      let r = lut[d[i]], g = lut[d[i + 1]], b = lut[d[i + 2]];
      // vibrance : renforce les couleurs ternes, épargne celles déjà vives et les tons chair
      const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
      const sat = max ? (max - min) / max : 0;
      if (max > 12) {
        // tons chair : rouge > vert > bleu (toutes carnations) → effet réduit de 70 %
        const skin = r > g && g > b && (r - b) > 15 && sat < 0.6;
        const amt = vib * (1 - sat) * (skin ? 0.3 : 1);
        const avg = (r + g + b) / 3;
        r += (r - avg) * amt; g += (g - avg) * amt; b += (b - avg) * amt;
      }
      d[i] = r * warmR; d[i + 1] = g; d[i + 2] = b * warmB; // Uint8Clamped borne tout seul
    }
    ctx.putImageData(img, 0, 0);
    sharpen(canvas, 0.35 * k);
    return { applied: true, stats };
  };

  // Netteté douce (masque flou) : image + force × (image − image floutée)
  function sharpen(canvas, amount) {
    if (amount <= 0) return;
    const { width: W, height: H } = canvas;
    const blur = document.createElement('canvas');
    blur.width = W; blur.height = H;
    const bctx = blur.getContext('2d', { willReadFrequently: true });
    bctx.filter = `blur(${Math.max(0.8, Math.min(W, H) / 1600)}px)`;
    bctx.drawImage(canvas, 0, 0);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const a = ctx.getImageData(0, 0, W, H), b = bctx.getImageData(0, 0, W, H);
    const da = a.data, db = b.data;
    for (let i = 0; i < da.length; i += 4) {
      da[i] = da[i] + (da[i] - db[i]) * amount;
      da[i + 1] = da[i + 1] + (da[i + 1] - db[i + 1]) * amount;
      da[i + 2] = da[i + 2] + (da[i + 2] - db[i + 2]) * amount;
    }
    ctx.putImageData(a, 0, 0);
  }

  /* ---------- Recadrage léger guidé par les visages ---------- */
  // faces : [{ b: [x, y, l, h] en proportions }]. Retourne { canvas, faces } (cadres recalculés).
  // Resserre de 3 à 8 % maximum, garde le format d'origine, ne coupe jamais un visage.
  R.smartCrop = function (canvas, faces, maxTrim = 0.08) {
    const boxes = (faces || []).map(f => f.b).filter(Boolean);
    if (!boxes.length) return { canvas, faces, cropped: false };
    const W = canvas.width, H = canvas.height;
    // zone à protéger : tous les visages + une marge (corps, cheveux) proportionnelle à leur taille
    let x1 = 1, y1 = 1, x2 = 0, y2 = 0;
    for (const [x, y, w, h] of boxes) {
      x1 = Math.min(x1, x - w * 0.9); x2 = Math.max(x2, x + w * 1.9);
      y1 = Math.min(y1, y - h * 0.9); y2 = Math.max(y2, y + h * 2.2);
    }
    x1 = clamp(x1, 0, 1); y1 = clamp(y1, 0, 1); x2 = clamp(x2, 0, 1); y2 = clamp(y2, 0, 1);
    // plus grand resserrement possible (même proportion sur les deux axes)
    let t = maxTrim;
    for (; t > 0.02; t -= 0.01) {
      const cw = 1 - 2 * t, ch = 1 - 2 * t;
      if (cw < x2 - x1 || ch < y2 - y1) continue;
      // centre la fenêtre sur les visages, sans sortir de l'image
      const cx = clamp((x1 + x2) / 2 - cw / 2, Math.max(0, x2 - cw), Math.min(1 - cw, x1));
      const cy = clamp((y1 + y2) / 2 - ch / 2, Math.max(0, y2 - ch), Math.min(1 - ch, y1));
      if (cx < 0 || cy < 0 || cx > 1 - cw || cy > 1 - ch) continue;
      const out = document.createElement('canvas');
      out.width = Math.round(W * cw); out.height = Math.round(H * ch);
      out.getContext('2d').drawImage(canvas, cx * W, cy * H, cw * W, ch * H, 0, 0, out.width, out.height);
      const r4 = v => Math.round(v * 1e4) / 1e4;
      const moved = faces.map(f => f.b ? { ...f, b: [r4((f.b[0] - cx) / cw), r4((f.b[1] - cy) / ch), r4(f.b[2] / cw), r4(f.b[3] / ch)] } : f);
      return { canvas: out, faces: moved, cropped: true, trim: t };
    }
    return { canvas, faces, cropped: false };
  };
})();
