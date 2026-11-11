// Stockage des photos du photographe : Cloudinary en production, disque local pour les tests.
// Chaque photo est décrite par un objet "item" :
// { id, album, createdAt, width, height, url, thumb, download, faces: number[][] }
// "faces" contient une empreinte (128 nombres) par visage détecté sur la photo.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function newId() {
  return Date.now().toString(36) + '-' + crypto.randomBytes(5).toString('hex');
}

/* ------------------------------------------------------------------ */
/* Stockage local (développement / test)                               */
/* ------------------------------------------------------------------ */
function createLocalStorage({ dataDir }) {
  const mediaDir = path.join(dataDir, 'media');
  const indexFile = path.join(dataDir, 'index.json');
  fs.mkdirSync(mediaDir, { recursive: true });

  let saveTimer = null;
  let items = [];

  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      fs.writeFileSync(indexFile + '.tmp', JSON.stringify(items));
      fs.renameSync(indexFile + '.tmp', indexFile);
    }, 200);
  }

  function withUrls(item) {
    const file = `/media/${item.file}`;
    return { ...item, url: file, thumb: file, download: file + '?download=1' };
  }

  return {
    kind: 'local',
    mediaDir,
    async init() {
      if (fs.existsSync(indexFile)) items = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
      return items.map(withUrls);
    },
    async save({ buffer, mimetype, meta, faces }) {
      const id = newId();
      const ext = mimetype === 'image/png' ? 'png' : mimetype === 'image/webp' ? 'webp' : 'jpg';
      const file = `${id}.${ext}`;
      fs.writeFileSync(path.join(mediaDir, file), buffer);
      const item = {
        id, file, album: meta.album, createdAt: new Date().toISOString(),
        width: meta.width || null, height: meta.height || null, faces,
      };
      items.push(item);
      persist();
      return withUrls(item);
    },
    async remove(ids) {
      for (const it of items.filter(i => ids.includes(i.id))) {
        fs.rmSync(path.join(mediaDir, it.file), { force: true });
      }
      items = items.filter(i => !ids.includes(i.id));
      persist();
    },
    // Lecture d'un fichier pour le ZIP
    async read(item) {
      return fs.createReadStream(path.join(mediaDir, item.file));
    },

    /* ---- Documents d'état (votes…) et images diverses ---- */
    async loadState(name) {
      const f = path.join(dataDir, `state-${name}.json`);
      return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
    },
    async saveState(name, obj) {
      const f = path.join(dataDir, `state-${name}.json`);
      fs.writeFileSync(f + '.tmp', JSON.stringify(obj));
      fs.renameSync(f + '.tmp', f);
    },
    async saveImage(buffer, mimetype) {
      const id = 'img-' + newId();
      const file = `${id}.${mimetype === 'image/png' ? 'png' : mimetype === 'image/webp' ? 'webp' : 'jpg'}`;
      fs.writeFileSync(path.join(mediaDir, file), buffer);
      return { id: file, url: `/media/${file}` };
    },
    async removeImage(id) {
      fs.rmSync(path.join(mediaDir, path.basename(id)), { force: true });
    },

    /* ---- Partenaires ---- */
    async listPartners() {
      const f = path.join(dataDir, 'partners.json');
      const list = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : [];
      return list.map(p => ({ ...p, logo: `/media/${p.file}` }));
    },
    async savePartner({ buffer, mimetype, meta }) {
      const f = path.join(dataDir, 'partners.json');
      const list = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : [];
      const id = 'partner-' + newId();
      const ext = mimetype === 'image/png' ? 'png' : mimetype === 'image/webp' ? 'webp' : mimetype === 'image/svg+xml' ? 'svg' : 'jpg';
      const file = `${id}.${ext}`;
      fs.writeFileSync(path.join(mediaDir, file), buffer);
      const p = { id, file, ...meta, createdAt: new Date().toISOString() };
      list.push(p);
      fs.writeFileSync(f, JSON.stringify(list));
      return { ...p, logo: `/media/${file}` };
    },
    async removePartner(id) {
      const f = path.join(dataDir, 'partners.json');
      const list = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : [];
      const p = list.find(x => x.id === id);
      if (p) fs.rmSync(path.join(mediaDir, p.file), { force: true });
      fs.writeFileSync(f, JSON.stringify(list.filter(x => x.id !== id)));
    },
  };
}

/* ------------------------------------------------------------------ */
/* Cloudinary (production)                                             */
/* ------------------------------------------------------------------ */
// Image : gala/<slug>/<id>          (tag <slug>_photo, context album/createdAt)
// Visages : gala/<slug>/faces/<id>.json (fichier "raw", tag <slug>_faces)
// L'API d'administration (limitée en nombre d'appels) n'est utilisée qu'au démarrage
// pour reconstruire l'index en mémoire.
function createCloudinaryStorage({ slug }) {
  const cloudinary = require('cloudinary').v2;
  cloudinary.config({ secure: true }); // lit CLOUDINARY_URL
  const folder = `gala/${slug}`;
  const photoTag = `${slug}_photo`;
  const facesTag = `${slug}_faces`;
  const facesIdFor = id => `${folder}/faces/${id.split('/').pop()}.json`;

  const tr = (url, t) => url.replace('/upload/', `/upload/${t}/`);
  function toItem(r, faces) {
    const c = (r.context && (r.context.custom || r.context)) || {};
    return {
      id: r.public_id,
      album: c.album || '',
      createdAt: c.createdAt || r.created_at,
      width: r.width, height: r.height,
      url: tr(r.secure_url, 'c_limit,w_1920,h_1920,q_auto,f_auto'),
      thumb: tr(r.secure_url, 'c_limit,w_640,h_640,q_auto,f_auto'),
      download: tr(r.secure_url, 'fl_attachment'),
      original: r.secure_url,
      faces: faces || [],
    };
  }

  async function listByTag(tag, resourceType) {
    const out = [];
    let cursor;
    do {
      const res = await cloudinary.api.resources_by_tag(tag, {
        resource_type: resourceType, context: true, max_results: 500, next_cursor: cursor,
      });
      out.push(...res.resources);
      cursor = res.next_cursor;
    } while (cursor);
    return out;
  }

  function uploadBuffer(buffer, options) {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(options, (err, r) => (err ? reject(err) : resolve(r)));
      stream.end(buffer);
    });
  }

  async function fetchJson(url) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const r = await fetch(url);
        if (r.ok) return await r.json();
      } catch {}
      await new Promise(res => setTimeout(res, 500 * attempt));
    }
    return null;
  }

  const clean = s => String(s || '').replace(/[|=]/g, ' ').slice(0, 80);

  return {
    kind: 'cloudinary',
    async init() {
      const [images, faceFiles] = await Promise.all([listByTag(photoTag, 'image'), listByTag(facesTag, 'raw')]);
      // Récupère les empreintes (20 téléchargements en parallèle)
      const facesById = new Map();
      let i = 0;
      await Promise.all(Array.from({ length: 20 }, async () => {
        while (i < faceFiles.length) {
          const f = faceFiles[i++];
          const data = await fetchJson(f.secure_url);
          if (data && data.id) facesById.set(data.id, data.faces || []);
        }
      }));
      return images.map(r => toItem(r, facesById.get(r.public_id)));
    },
    async save({ buffer, meta, faces }) {
      const createdAt = new Date().toISOString();
      const r = await uploadBuffer(buffer, {
        folder, resource_type: 'image', tags: [photoTag],
        context: { album: clean(meta.album), createdAt },
      });
      await uploadBuffer(Buffer.from(JSON.stringify({ id: r.public_id, faces })), {
        public_id: facesIdFor(r.public_id), resource_type: 'raw', tags: [facesTag], overwrite: true,
      });
      r.context = { custom: { album: meta.album, createdAt } };
      return toItem(r, faces);
    },
    async remove(ids) {
      await Promise.all(ids.map(async id => {
        await cloudinary.uploader.destroy(id, { invalidate: true });
        await cloudinary.uploader.destroy(facesIdFor(id), { resource_type: 'raw', invalidate: true }).catch(() => {});
      }));
    },
    async read(item) {
      const r = await fetch(item.original);
      if (!r.ok) throw new Error('Téléchargement Cloudinary impossible');
      const { Readable } = require('stream');
      return Readable.fromWeb(r.body);
    },

    /* ---- Documents d'état (votes…) : fichiers « raw » JSON réécrits à chaque sauvegarde ---- */
    async loadState(name) {
      let r;
      try {
        r = await cloudinary.api.resource(`${folder}/state/${name}.json`, { resource_type: 'raw' });
      } catch (e) {
        const code = e && (e.error ? e.error.http_code : e.http_code);
        if (code === 404) return null;
        throw new Error((e.error && e.error.message) || e.message || 'Cloudinary indisponible');
      }
      const data = await fetchJson(r.secure_url);
      if (!data) throw new Error('Lecture de l’état impossible');
      return data;
    },
    async saveState(name, obj) {
      await uploadBuffer(Buffer.from(JSON.stringify(obj)), {
        public_id: `${folder}/state/${name}.json`, resource_type: 'raw', overwrite: true, invalidate: true,
      });
    },
    async saveImage(buffer) {
      const r = await uploadBuffer(buffer, { folder: `${folder}/votes`, resource_type: 'image' });
      return { id: r.public_id, url: tr(r.secure_url, 'c_fill,g_auto,w_400,h_400,q_auto,f_auto') };
    },
    async removeImage(id) {
      await cloudinary.uploader.destroy(id, { invalidate: true });
    },

    /* ---- Partenaires : images taguées <slug>_partner, infos dans le context ---- */
    async listPartners() {
      const res = await listByTag(`${slug}_partner`, 'image');
      return res.map(r => {
        const c = (r.context && (r.context.custom || r.context)) || {};
        return {
          id: r.public_id, name: c.name || '', url: c.url || '', message: c.message || '',
          createdAt: c.createdAt || r.created_at,
          logo: tr(r.secure_url, 'c_limit,w_600,h_300,q_auto,f_auto'),
        };
      });
    },
    async savePartner({ buffer, meta }) {
      const createdAt = new Date().toISOString();
      const r = await uploadBuffer(buffer, {
        folder: `${folder}/partenaires`, resource_type: 'image', tags: [`${slug}_partner`],
        context: { name: clean(meta.name), url: String(meta.url || '').replace(/[|=]/g, m => encodeURIComponent(m)).slice(0, 200), message: clean(meta.message), createdAt },
      });
      return { id: r.public_id, ...meta, createdAt, logo: tr(r.secure_url, 'c_limit,w_600,h_300,q_auto,f_auto') };
    },
    async removePartner(id) {
      await cloudinary.uploader.destroy(id, { invalidate: true });
    },
  };
}

function createStorage(opts) {
  if (process.env.CLOUDINARY_URL) return createCloudinaryStorage(opts);
  return createLocalStorage(opts);
}

module.exports = { createStorage };
