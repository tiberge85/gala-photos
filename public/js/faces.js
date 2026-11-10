/* Reconnaissance faciale dans le navigateur (bibliothèque @vladmandic/face-api).
   - Photographe : détecte tous les visages d'une photo et calcule leur empreinte (128 nombres).
   - Invité : calcule l'empreinte du visage de son selfie.
   Les images ne quittent jamais l'appareil pour cette étape : seules les empreintes sont envoyées. */
(function () {
  const F = (window.Gala.faces = {});
  const MODELS = '/vendor/face-models';
  let libPromise = null;
  const loaded = {};

  function loadLib() {
    if (window.faceapi) return Promise.resolve(window.faceapi);
    if (!libPromise) {
      libPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = '/vendor/face-api/face-api.js';
        s.onload = () => resolve(window.faceapi);
        s.onerror = () => reject(new Error('Impossible de charger la reconnaissance faciale.'));
        document.head.appendChild(s);
      });
    }
    return libPromise;
  }

  async function loadNet(api, name) {
    if (!loaded[name]) loaded[name] = api.nets[name].loadFromUri(MODELS);
    return loaded[name];
  }

  // kind : 'photographer' (détecteur précis SSD) ou 'guest' (détecteur léger, plus rapide sur mobile)
  F.load = async function (kind) {
    const api = await loadLib();
    try { await api.tf.setBackend('webgl'); } catch {}
    await api.tf.ready();
    if (api.tf.getBackend() !== 'webgl') { try { await api.tf.setBackend('cpu'); await api.tf.ready(); } catch {} }
    await Promise.all([
      loadNet(api, kind === 'photographer' ? 'ssdMobilenetv1' : 'tinyFaceDetector'),
      loadNet(api, 'faceLandmark68Net'),
      loadNet(api, 'faceRecognitionNet'),
    ]);
    return api;
  };

  const round = d => Array.from(d, x => Math.round(x * 1e5) / 1e5);

  function iou(a, b) {
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.width, b.x + b.width), y2 = Math.min(a.y + a.height, b.y + b.height);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    return inter / (a.width * a.height + b.width * b.height - inter);
  }

  function cropCanvas(src, x, y, w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(src, x, y, w, h, 0, 0, w, h);
    return c;
  }

  // Détecte tous les visages d'une photo (canvas). Avec "tiles", la photo est aussi analysée
  // en 4 morceaux qui se chevauchent pour trouver les petits visages des photos de groupe.
  F.describeAll = async function (canvas, { tiles = true } = {}) {
    const api = window.faceapi;
    const opts = new api.SsdMobilenetv1Options({ minConfidence: 0.45, maxResults: 100 });
    const found = []; // { box (coordonnées globales), score, descriptor }

    async function run(input, ox, oy) {
      const res = await api.detectAllFaces(input, opts).withFaceLandmarks().withFaceDescriptors();
      for (const r of res) {
        const b = r.detection.box;
        if (b.width < 24 || b.height < 24) continue; // trop petit pour être fiable
        found.push({ box: { x: b.x + ox, y: b.y + oy, width: b.width, height: b.height }, score: r.detection.score, descriptor: r.descriptor });
      }
    }

    await run(canvas, 0, 0);
    if (tiles && Math.max(canvas.width, canvas.height) >= 1200) {
      const W = canvas.width, H = canvas.height;
      const tw = Math.round(W * 0.58), th = Math.round(H * 0.58);
      for (const [x, y] of [[0, 0], [W - tw, 0], [0, H - th], [W - tw, H - th]]) {
        await run(cropCanvas(canvas, x, y, tw, th), x, y);
      }
    }

    // Fusion des doublons (même visage trouvé sur l'image entière et sur un morceau)
    found.sort((a, b) => b.score - a.score);
    const kept = [];
    for (const f of found) if (!kept.some(k => iou(k.box, f.box) > 0.3)) kept.push(f);
    // d : empreinte ; b : cadre du visage en proportions de l'image [x, y, largeur, hauteur]
    const W = canvas.width, H = canvas.height, r4 = v => Math.round(v * 1e4) / 1e4;
    return kept.map(k => ({
      d: round(k.descriptor),
      b: [r4(k.box.x / W), r4(k.box.y / H), r4(k.box.width / W), r4(k.box.height / H)],
    }));
  };

  // Selfie : renvoie l'empreinte du plus grand visage, ou null si aucun visage n'est trouvé.
  // Ajoute une marge grise autour de l'image : aide quand le visage remplit tout le cadre (gros plan).
  function padCanvas(src, ratio) {
    const p = Math.round(Math.max(src.width, src.height) * ratio);
    const c = document.createElement('canvas');
    c.width = src.width + 2 * p; c.height = src.height + 2 * p;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(src, p, p);
    return { canvas: c, pad: p };
  }

  F.describeSelfie = async function (canvas) {
    const api = window.faceapi;
    const tiny = s => new api.TinyFaceDetectorOptions({ inputSize: s, scoreThreshold: 0.35 });
    const attempts = [
      { pad: 0, opt: () => tiny(416) },
      { pad: 0.35, opt: () => tiny(416) },
      { pad: 0, opt: () => tiny(608) },
      // Secours : détecteur précis (chargé seulement si besoin, ~5 Mo)
      { pad: 0, ssd: true }, { pad: 0.35, ssd: true },
    ];
    for (const a of attempts) {
      if (a.ssd) await loadNet(api, 'ssdMobilenetv1');
      const { canvas: input, pad } = a.pad ? padCanvas(canvas, a.pad) : { canvas, pad: 0 };
      const opt = a.ssd ? new api.SsdMobilenetv1Options({ minConfidence: 0.35 }) : a.opt();
      const res = await api.detectAllFaces(input, opt).withFaceLandmarks().withFaceDescriptors();
      if (!res.length) continue;
      res.sort((x, y) => y.detection.box.area - x.detection.box.area);
      const b = res[0].detection.box;
      return {
        descriptor: round(res[0].descriptor), count: res.length,
        box: { x: b.x - pad, y: b.y - pad, width: b.width, height: b.height },
      };
    }
    return null;
  };

  // Charge un fichier image dans un canvas (dimension max), en respectant l'orientation EXIF.
  F.fileToCanvas = async function (file, maxDim) {
    let src;
    try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch {
      const url = URL.createObjectURL(file);
      src = new Image(); src.src = url; await src.decode();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    const scale = Math.min(1, maxDim / Math.max(src.width, src.height));
    const c = document.createElement('canvas');
    c.width = Math.round(src.width * scale); c.height = Math.round(src.height * scale);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, c.width, c.height);
    if (src.close) src.close();
    return c;
  };

  F.canvasToJpeg = (canvas, quality = 0.9) => new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
})();
