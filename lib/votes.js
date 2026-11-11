// Votes des nominations (Meilleurs Responsables de Tribu, Roi / Reine de la soirée…)
//
// - Les catégories et les nominés sont gérés depuis /admin.
// - Un vote par personne et par catégorie : chaque électeur est reconnu par son
//   appareil (jeton gardé sur le téléphone) ou, à défaut, par l'empreinte de son selfie.
//   S'il revote, son nouveau choix remplace l'ancien.
// - Les résultats restent secrets (admin uniquement) jusqu'à la proclamation sur l'écran.
// - Tout l'état est gardé dans un seul document JSON (Cloudinary en production),
//   sauvegardé 2 secondes après chaque changement et à l'arrêt du serveur.

const crypto = require('crypto');

const SAME_PERSON = 0.42; // distance max entre deux selfies de la même personne

const DEFAULT_CATEGORIES = [
  ['Meilleurs Responsables de Tribu 2026', '12 tribus en compétition'],
  ['Le jeune le plus dynamique 2026', ''],
  ['Meilleur nouveau membre actif 2026', ''],
  ['Le Roi de la soirée', 'Éclat des Émeraudes'],
  ['La Reine de la soirée', 'Éclat des Émeraudes'],
];

const newId = p => p + '-' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');

function distance(a, b) {
  let s = 0;
  for (let i = 0; i < 128; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}

function createVotes({ storage }) {
  let state = null;
  let saveTimer = null;
  let saving = Promise.resolve();
  let dirty = false;

  function fresh() {
    return {
      categories: DEFAULT_CATEGORIES.map(([title, subtitle], i) => ({
        id: newId('cat'), title, subtitle, status: 'draft', order: i,
      })),
      nominees: [],
      voters: [],
      reveal: null,
    };
  }

  async function load() {
    state = (await storage.loadState('votes')) || fresh();
    state.categories ||= []; state.nominees ||= []; state.voters ||= []; state.reveal ||= null;
    // index des empreintes pour la reconnaissance des électeurs
    state.voters.forEach(v => { v.vec = v.d ? Float32Array.from(v.d) : null; });
  }

  function serialize() {
    return {
      ...state,
      voters: state.voters.map(({ vec, ...v }) => v),
    };
  }

  function save() {
    dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 2000);
  }
  function flush() {
    clearTimeout(saveTimer);
    if (!dirty) return saving;
    dirty = false;
    const snapshot = serialize();
    saving = saving.then(() => storage.saveState('votes', snapshot)).catch(e => {
      console.error('Sauvegarde des votes impossible :', e.message || e);
      dirty = true;
      saveTimer = setTimeout(flush, 5000);
    });
    return saving;
  }

  const cat = id => state.categories.find(c => c.id === id);
  const sortedCats = () => [...state.categories].sort((a, b) => a.order - b.order);
  const nomineesOf = id => state.nominees.filter(n => n.categoryId === id);
  const publicNominee = n => ({ id: n.id, name: n.name, detail: n.detail, photo: n.photo || null });

  function counts(catId) {
    const c = {};
    for (const v of state.voters) {
      const n = v.votes && v.votes[catId];
      if (n) c[n] = (c[n] || 0) + 1;
    }
    return c;
  }

  function ranking(catId) {
    const c = counts(catId);
    const total = Object.values(c).reduce((s, x) => s + x, 0);
    return {
      total,
      items: nomineesOf(catId)
        .map(n => ({ ...publicNominee(n), votes: c[n.id] || 0 }))
        .sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name, 'fr')),
    };
  }

  // Retrouve l'électeur : par appareil d'abord, sinon par visage, sinon nouvel électeur.
  function findVoter({ device, descriptor }, create) {
    let v = device ? state.voters.find(x => x.devices && x.devices.includes(device)) : null;
    const q = descriptor ? Float32Array.from(descriptor) : null;
    if (!v && q) {
      let best = Infinity;
      for (const x of state.voters) {
        if (!x.vec) continue;
        const d = distance(q, x.vec);
        if (d < best) { best = d; if (d <= SAME_PERSON) v = x; }
      }
    }
    if (!v && create) {
      v = { id: newId('v'), d: descriptor || null, vec: q, devices: [], votes: {}, at: new Date().toISOString() };
      state.voters.push(v);
    }
    if (v && device && !v.devices.includes(device)) v.devices.push(device);
    if (v && q && !v.vec) { v.vec = q; v.d = descriptor; }
    return v;
  }

  return {
    load,
    flush,

    /* ---------- Côté invité ---------- */
    // Catégories ouvertes avec au moins 2 nominés
    openCategories() {
      return sortedCats()
        .filter(c => c.status === 'open' && nomineesOf(c.id).length >= 2)
        .map(c => ({ id: c.id, title: c.title, subtitle: c.subtitle, nominees: nomineesOf(c.id).map(publicNominee) }));
    },
    myVotes(who) {
      const v = findVoter(who, false);
      return v ? { ...v.votes } : {};
    },
    vote(who, choices) {
      const v = findVoter(who, true);
      let changed = 0;
      for (const [catId, nomineeId] of Object.entries(choices || {})) {
        const c = cat(catId);
        if (!c || c.status !== 'open') continue;
        if (!state.nominees.some(n => n.id === nomineeId && n.categoryId === catId)) continue;
        v.votes[catId] = nomineeId;
        changed += 1;
      }
      v.at = new Date().toISOString();
      if (changed) save();
      return { ok: true, counted: changed, votes: { ...v.votes } };
    },

    /* ---------- Côté écran (proclamation) ---------- */
    live() {
      const r = state.reveal;
      let reveal = null;
      if (r && cat(r.catId)) {
        const c = cat(r.catId);
        const { total, items } = ranking(c.id);
        reveal = { at: r.at, category: { id: c.id, title: c.title, subtitle: c.subtitle }, total, podium: items.slice(0, 3) };
      }
      return { voters: state.voters.filter(v => Object.keys(v.votes).length).length, reveal };
    },

    /* ---------- Administration ---------- */
    adminView() {
      return {
        voters: state.voters.filter(v => Object.keys(v.votes).length).length,
        reveal: state.reveal,
        categories: sortedCats().map(c => ({ ...c, ...ranking(c.id) })),
      };
    },
    saveCategory({ id, title, subtitle }) {
      if (id) {
        const c = cat(id); if (!c) throw new Error('Catégorie introuvable.');
        c.title = title; c.subtitle = subtitle;
      } else {
        state.categories.push({ id: newId('cat'), title, subtitle, status: 'draft', order: state.categories.length });
      }
      save();
    },
    async deleteCategory(id) {
      const c = cat(id); if (!c) throw new Error('Catégorie introuvable.');
      for (const n of nomineesOf(id)) if (n.photoId) await storage.removeImage(n.photoId).catch(() => {});
      state.nominees = state.nominees.filter(n => n.categoryId !== id);
      state.categories = state.categories.filter(x => x.id !== id);
      state.voters.forEach(v => { delete v.votes[id]; });
      if (state.reveal && state.reveal.catId === id) state.reveal = null;
      save();
    },
    setStatus(id, status) {
      const c = cat(id); if (!c) throw new Error('Catégorie introuvable.');
      if (!['draft', 'open', 'closed'].includes(status)) throw new Error('Statut invalide.');
      c.status = status; save();
    },
    moveCategory(id, dir) {
      const list = sortedCats();
      const i = list.findIndex(c => c.id === id);
      const j = i + (dir < 0 ? -1 : 1);
      if (i < 0 || j < 0 || j >= list.length) return;
      [list[i].order, list[j].order] = [list[j].order, list[i].order];
      save();
    },
    async addNominee({ categoryId, name, detail, image }) {
      if (!cat(categoryId)) throw new Error('Catégorie introuvable.');
      const n = { id: newId('nom'), categoryId, name, detail, photo: null, photoId: null };
      if (image) { const img = await storage.saveImage(image.buffer, image.mimetype); n.photo = img.url; n.photoId = img.id; }
      state.nominees.push(n); save();
      return n;
    },
    async deleteNominee(id) {
      const n = state.nominees.find(x => x.id === id); if (!n) throw new Error('Nominé introuvable.');
      if (n.photoId) await storage.removeImage(n.photoId).catch(() => {});
      state.nominees = state.nominees.filter(x => x.id !== id);
      state.voters.forEach(v => { if (v.votes[n.categoryId] === id) delete v.votes[n.categoryId]; });
      save();
    },
    reveal(catId) {
      if (catId && !cat(catId)) throw new Error('Catégorie introuvable.');
      state.reveal = catId ? { catId, at: Date.now() } : null;
      save();
    },
    resetVotes(catId) {
      state.voters.forEach(v => { if (catId) delete v.votes[catId]; else v.votes = {}; });
      save();
    },
  };
}

module.exports = { createVotes };
