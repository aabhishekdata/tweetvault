// Tweet Vault web page (v3 "calm with character"). Plain JS. All page text goes in through textContent (never innerHTML).
'use strict';

(() => {
  const app = document.getElementById('app');

  // ---------- tiny DOM helper ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'indeterminate') el.indeterminate = !!v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

  // ---------- icons (one stroke family, 24px grid) ----------
  const SVGNS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
    bookmark: ['M6 3.5h12a1 1 0 0 1 1 1V21l-7-4.5L5 21V4.5a1 1 0 0 1 1-1z'],
    search: ['M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13z', 'M15.5 15.5 20 20'],
    inbox: ['M3.5 13.5h5l1.5 2.5h4l1.5-2.5h5', 'M5.5 5.5h13l2 8v4a1.5 1.5 0 0 1-1.5 1.5h-14A1.5 1.5 0 0 1 3.5 17.5v-4z'],
    layers: ['M12 3.5 21 8l-9 4.5L3 8z', 'M3 12l9 4.5 9-4.5', 'M3 16l9 4.5 9-4.5'],
    star: ['M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.3-4.1 5.9-.9z'],
    archive: ['M3.5 4.5h17v4h-17z', 'M5 8.5v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-10', 'M10 12.5h4'],
    trash: ['M4 6.5h16', 'M9 6.5V4.5h6v2', 'M6 6.5l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13', 'M10 10.5v6', 'M14 10.5v6'],
    plus: ['M12 5v14', 'M5 12h14'],
    play: ['M4 5.5h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1z', 'M10 9.2v5.6l4.6-2.8z'],
    video: ['M3.5 7h11a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z', 'M15.5 10.5 21 7.5v9l-5.5-3'],
    tag: ['M3.5 4.5v6.6l9.4 9.4 7.6-7.6-9.4-9.4H4.5a1 1 0 0 0-1 1z', 'M8 8.2h.01'],
    tagplus: ['M3.5 4.5v6.6l9.4 9.4 3-3', 'M3.5 4.5a1 1 0 0 1 1-1h6.6l6 6', 'M8 8.2h.01', 'M19 13v6', 'M16 16h6'],
    folder: ['M3.5 6.5a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z'],
    gear: ['M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6z', 'M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z'],
    user: ['M12 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8z', 'M4.5 20.5c1-3.6 4-5.5 7.5-5.5s6.5 1.9 7.5 5.5'],
    logout: ['M9.5 20.5h-4a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1h4', 'M15.5 16.5 20 12l-4.5-4.5', 'M20 12H9.5'],
    more: [],
    ext: ['M8 16 16.5 7.5', 'M9.5 7.5h7v7'],
    chevdown: ['M6.5 9.5 12 15l5.5-5.5'],
    chevup: ['M6.5 14.5 12 9l5.5 5.5'],
    left: ['M19 12H5.5', 'M11 6l-6 6 6 6'],
    copy: ['M9.5 8.5h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z', 'M15.5 8.5V4.5a1 1 0 0 0-1-1h-9a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3'],
    pencil: ['M15.5 4.5l4 4L8.5 19.5H4.5v-4z', 'M13 7l4 4'],
    check: ['M5 12.5l4.5 4.5L19 7.5'],
    checkcircle: ['M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17z', 'M8.5 12.2l2.4 2.4 4.7-4.9'],
    alert: ['M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17z', 'M12 8v5', 'M12 16.2h.01'],
    x: ['M6.5 6.5l11 11', 'M17.5 6.5l-11 11'],
    phone: ['M8 2.8h8a1.5 1.5 0 0 1 1.5 1.5v15.4a1.5 1.5 0 0 1-1.5 1.5H8a1.5 1.5 0 0 1-1.5-1.5V4.3A1.5 1.5 0 0 1 8 2.8z', 'M11 18h2'],
    key: ['M8 11a4 4 0 1 1 0 8 4 4 0 0 1 0-8z', 'M10.8 12.2 19 4', 'M15.5 7.5l2.5 2.5', 'M17.5 5.5 20 8'],
    monitor: ['M4 4.5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z', 'M9 20.5h6', 'M12 16.5v4'],
    clock: ['M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17z', 'M12 7.5V12l3 2'],
    shield: ['M12 3l7.5 3v5.5c0 4.5-3.2 8-7.5 9.5-4.3-1.5-7.5-5-7.5-9.5V6z'],
    refresh: ['M19.5 12a7.5 7.5 0 1 1-2.2-5.3', 'M19.5 4.5v4h-4'],
    up: ['M12 19V5.5', 'M6 11.5l6-6 6 6'],
    down: ['M12 5v13.5', 'M6 12.5l6 6 6-6'],
    undo: ['M9 14.5 4.5 10 9 5.5', 'M4.5 10H15a5 5 0 0 1 0 10h-3'],
    filter: ['M4 6h16', 'M7 12h10', 'M10 18h4'],
    note: ['M6 3.5h8.5l4 4V20a.5.5 0 0 1-.5.5H6a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5z', 'M14 3.5v4.5h4.5', 'M8.5 12.5h7', 'M8.5 16h5'],
    mic: ['M12 3.5a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0v-5a3 3 0 0 1 3-3z', 'M5.5 11a6.5 6.5 0 0 0 13 0', 'M12 17.5v3.5', 'M8.5 21h7'],
    theme: ['M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17z', 'M12 3.5v17', 'M12 3.5a8.5 8.5 0 0 1 0 17z'],
  };
  function icon(name, cls = '') {
    const s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('class', `ico ${cls}`.trim());
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    if (name === 'more') {
      for (const cx of [5.5, 12, 18.5]) {
        const c = document.createElementNS(SVGNS, 'circle');
        c.setAttribute('cx', cx); c.setAttribute('cy', 12); c.setAttribute('r', 1.5);
        c.setAttribute('fill', 'currentColor'); c.setAttribute('stroke', 'none');
        s.append(c);
      }
      return s;
    }
    if (name === 'bookmarkfill') {
      s.setAttribute('class', `ico fill ${cls}`.trim());
      const p = document.createElementNS(SVGNS, 'path');
      p.setAttribute('d', 'M6 2.5h12a1.5 1.5 0 0 1 1.5 1.5v18l-7.5-5-7.5 5V4A1.5 1.5 0 0 1 6 2.5z');
      s.append(p);
      return s;
    }
    for (const d of ICONS[name] || []) {
      const p = document.createElementNS(SVGNS, 'path');
      p.setAttribute('d', d);
      s.append(p);
    }
    return s;
  }

  // ---------- feedback ----------
  let toastTimer = null;
  let toastMs = 0;
  const toastEl = () => document.getElementById('toast');
  const hideToastLater = () => { clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastEl().className = ''; }, toastMs); };
  // the toast stays while the pointer or keyboard focus is on it, so Undo can be reached
  toastEl().addEventListener('mouseenter', () => clearTimeout(toastTimer));
  toastEl().addEventListener('focusin', () => clearTimeout(toastTimer));
  toastEl().addEventListener('mouseleave', () => { if (!toastEl().contains(document.activeElement)) hideToastLater(); });
  toastEl().addEventListener('focusout', (e) => { if (!toastEl().contains(e.relatedTarget)) hideToastLater(); });
  // toast(msg, bad, {label, fn}) — an optional action button such as Undo
  function toast(msg, bad = false, action = null) {
    const t = toastEl();
    clear(t);
    t.append(icon(bad ? 'alert' : 'checkcircle'), h('span', { text: msg }));
    if (action) {
      t.append(h('button', { class: 'toastbtn', text: action.label, onclick: async () => {
        t.className = '';
        try { await action.fn(); } catch (e) { toast(e.message || `${action.label} didn't work`, true); }
      } }));
    }
    t.className = `show${bad ? ' bad' : ''}`;
    toastMs = action ? 8000 : (bad ? 5000 : 2600);
    hideToastLater();
  }

  // Small modal dialogs instead of the browser's prompt/confirm, so they match the app and keep focus sane.
  let dlgSeq = 0;
  function dialogBox(build, { cls = '' } = {}) {
    return new Promise((resolve) => {
      const back = document.activeElement;
      const id = `dlg${++dlgSeq}`;
      const dlg = h('dialog', { class: `dlg ${cls}`.trim(), 'aria-labelledby': `${id}-t` });
      const body = h('div', { class: 'dlgbody' });
      dlg.append(body);
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        dlg.close();
        dlg.remove();
        if (back && document.body.contains(back)) back.focus();
        resolve(v);
      };
      dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(null); });
      // only a press and release both outside the box count as a backdrop click
      const outside = (e) => { const r = dlg.getBoundingClientRect(); return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom; };
      let downOut = false;
      dlg.addEventListener('pointerdown', (e) => { downOut = e.target === dlg && outside(e); });
      dlg.addEventListener('click', (e) => { if (downOut && e.target === dlg && outside(e)) finish(null); downOut = false; });
      build(body, finish, id);
      if (body.querySelector(`#${id}-d`)) dlg.setAttribute('aria-describedby', `${id}-d`);
      document.body.append(dlg);
      dlg.showModal();
      const f = dlg.querySelector('[autofocus]') || dlg.querySelector('input, button');
      if (f) f.focus();
    });
  }

  function askText({ title, label, value = '', ok = 'Save', hint = null }) {
    return dialogBox((dlg, finish, id) => {
      const input = h('input', { type: 'text', id: `${id}-in`, value, maxlength: 200, autocomplete: 'off', autofocus: true });
      dlg.append(h('form', { method: 'dialog', onsubmit: (e) => { e.preventDefault(); finish(input.value.trim() || null); } },
        h('h2', { id: `${id}-t`, text: title }),
        hint ? h('p', { id: `${id}-d`, text: hint }) : null,
        h('label', { class: 'lbl', for: `${id}-in`, text: label }), input,
        h('div', { class: 'btnrow' },
          h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: () => finish(null) }),
          h('button', { type: 'submit', class: 'btn primary', text: ok }))));
      setTimeout(() => input.select(), 0);
    });
  }

  // Write a new note, or edit one you wrote (x). These are the only items whose text can be changed
  // (server: sync.js). What is typed is kept until it is saved, so closing the box by accident loses
  // nothing. Resolves with the saved item, or null.
  // A kept draft remembers which version of the note it was started from (base). It is saved against that
  // version, not against the note as it is when the box is opened again, so a change made on the phone in
  // between is still noticed.
  const noteDrafts = new Map();   // 'new' or an item id -> { title, text, base }
  async function noteEditor(x) {
    const key = x ? x.id : 'new';
    let cur = { title: '', text: '', version: null };
    if (x) {
      try {
        const r = await api('GET', `/api/items/${x.id}`);
        cur = { title: r.item.title || '', text: r.item.text || '', version: r.item.note_version };
      } catch (e) { toast(e.message, true); return null; }
    }
    const draft = noteDrafts.get(key);
    return dialogBox((dlg, finish, id) => {
      const title = h('input', { type: 'text', id: `${id}-ti`, value: draft ? draft.title : cur.title, maxlength: 200, autocomplete: 'off', placeholder: 'Optional' });
      const ta = h('textarea', { id: `${id}-tx`, class: 'notearea', rows: 10, autofocus: true, value: draft ? draft.text : cur.text });
      const err = h('p', { class: 'cerr', role: 'alert' });
      const latest = h('div');
      const save = h('button', { type: 'submit', class: 'btn primary', text: 'Save' });
      let base = draft ? draft.base : cur.version;
      const keep = () => {
        if (base === cur.version && title.value === cur.title && ta.value === cur.text) noteDrafts.delete(key);
        else noteDrafts.set(key, { title: title.value, text: ta.value, base });
      };
      // the note changed somewhere else while this draft was waiting: say so before anything is typed
      const showOther = (c) => {
        clear(latest).append(h('p', { class: 'lbl', text: 'The version saved somewhere else:' }), h('pre', { class: 'notelatest', text: c.title ? `${c.title}\n\n${c.text}` : c.text }));
        err.textContent = 'This note changed somewhere else. Copy what you need from the version below into yours, then save again to replace it.';
      };
      if (draft && x && draft.base !== cur.version) { base = cur.version; showOther(cur); keep(); }
      title.addEventListener('input', keep);
      ta.addEventListener('input', keep);
      ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save.click(); } });
      dlg.append(h('form', { method: 'dialog', onsubmit: async (e) => {
        e.preventDefault();
        if (save.disabled) return;
        err.textContent = '';
        if (!ta.value.trim()) { err.textContent = 'Write something first.'; ta.focus(); return; }
        save.disabled = true;
        try {
          const body = { title: title.value, text: ta.value };
          const r = x ? await api('PATCH', `/api/notes/${x.id}`, { ...body, base_version: base }) : await api('POST', '/api/notes', body);
          noteDrafts.delete(key);
          finish(r.item);
        } catch (ex) {
          if (ex.status === 409 && ex.data && ex.data.current) {
            // saved somewhere else (the phone) since this box opened: show that version, and let a second Save replace it
            base = ex.data.current.note_version;
            showOther(ex.data.current);
            keep();
          } else err.textContent = ex.message;
          save.disabled = false;
        }
      } },
      h('h2', { id: `${id}-t`, text: x ? 'Edit note' : 'New note' }),
      h('label', { class: 'lbl', for: `${id}-ti`, text: 'Title' }), title,
      h('label', { class: 'lbl', for: `${id}-tx`, text: 'Note' }), ta,
      err, latest,
      h('div', { class: 'btnrow' },
        h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: () => finish(null) }),
        save)));
    }, { cls: 'reader' });
  }

  // a destructive confirm starts on Cancel, so a stray Enter never deletes anything
  function confirmBox({ title, body, ok = 'Continue', danger = false }) {
    return dialogBox((dlg, finish, id) => {
      dlg.append(h('h2', { id: `${id}-t`, text: title }), body ? h('p', { id: `${id}-d`, text: body }) : null,
        h('div', { class: 'btnrow' },
          h('button', { type: 'button', class: 'btn', text: 'Cancel', autofocus: danger, onclick: () => finish(false) }),
          h('button', { type: 'button', class: `btn ${danger ? 'danger' : 'primary'}`, text: ok, autofocus: !danger, onclick: () => finish(true) })));
    }).then((v) => v === true);
  }

  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}-web`);

  function ago(ts) {
    if (!ts) return '';
    const s = Math.max(0, Date.now() / 1000 - ts);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
    return new Date(ts * 1000).toISOString().slice(0, 10);
  }
  const when = (ts) => (ts ? new Date(ts * 1000).toLocaleString() : '');
  const fmtNum = (n) => (n == null ? '' : Number(n).toLocaleString('en-US'));
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;

  // ---------- API ----------
  async function api(method, path, body) {
    const opts = { method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('application/json') ? await res.json() : await res.text();
    if (!res.ok) {
      const err = new Error((data && data.message) || `Request failed (${res.status})`);
      err.status = res.status;
      err.code = data && data.error;
      err.data = data;
      if (data && data.error === 'signed_out') { state.me = null; route(); }
      if (data && data.error === 'mfa_setup_required') { showMfaSetup(); }
      throw err;
    }
    return data;
  }

  async function copyText(text, what) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = h('textarea', { class: 'offscreen' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast(`Copied ${what}`);
  }

  // ---------- state ----------
  const state = {
    me: null,
    tab: 'inbox',
    voiceId: null,      // the voice note page that is open (tab 'voice'), or null for the list
    q: '',
    groups: [],
    selected: new Set(),
    selecting: false,   // "Select items" mode shows checkboxes and the selection toolbar
    expanded: new Set(), // conversation keys whose replies are shown
    merge: null,        // {groups:[{key, fixed:[dto], replies:[dto]}], title, slug?}
    timer: null,
    inboxSeq: 0,
    secSeq: 0,
    capDraft: '',       // what's typed in the capture box survives page rebuilds
    bundles: [],        // merged items, for "Add to merged…"
    org: { counts: {}, categories: [], tags: [] },
    filter: { category: null, tag: null, priority: 0 },
    sort: 'saved_desc',
    bsort: 'updated',
    filtersOpen: false,
    shell: null,        // header, sidebar and main stay put between views
    view: null,         // the list page parts that survive refreshes
    secOpen: { mfa: true, phones: true, browsers: false, activity: false },
    recipes: null,      // prompt recipes for the "Copy with…" menus (null until loaded)
    recSeq: 0,
    recDraft: { name: '', prompt: '' },   // the half-typed new recipe survives page rebuilds
    recEdits: new Map(),  // recipe id -> {name, prompt, saved}: card edits not saved yet survive page rebuilds
  };
  const safeHref = (u) => (/^https?:\/\//i.test(String(u || '')) ? u : null);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window */ } },
  };

  // ---------- theme: follows the system unless the viewer picks Light or Dark (kept per browser) ----------
  const THEMES = [['system', 'Match system'], ['light', 'Light'], ['dark', 'Dark']];
  const darkQ = window.matchMedia('(prefers-color-scheme: dark)');
  const themeChoice = () => { const t = store.get('tv.theme'); return t === 'light' || t === 'dark' ? t : 'system'; };
  function applyTheme() {
    const t = themeChoice();
    if (t === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    const dark = t === 'dark' || (t === 'system' && darkQ.matches);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#0E1317' : '#FBFDFA');
  }
  function setTheme(t) {
    store.set('tv.theme', t);
    applyTheme();
    toast(t === 'system' ? 'Theme follows your system' : `${t === 'dark' ? 'Dark' : 'Light'} theme on`);
  }
  applyTheme();
  darkQ.addEventListener('change', applyTheme);

  // ---------- menus (More / Organize) ----------
  // items: [{label, icon, onClick, danger, on, sub:[items], sep:true, hint}]
  let openMenu = null; // {close}
  function closeMenus() { if (openMenu) openMenu.close(false); }
  // a menu is open inside one of these roots, so redrawing them would pull it away
  const menuIn = (...roots) => !!(openMenu && document.body.contains(openMenu.wrap) && roots.some((r) => r && r.contains(openMenu.wrap)));
  document.addEventListener('pointerdown', (e) => { if (openMenu && !openMenu.wrap.contains(e.target)) openMenu.close(false); });

  // the menu is placed with position:fixed next to its trigger, so no card or sidebar can clip it
  function placeMenu(menu, trigger, align) {
    const r = trigger.getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    let left = align === 'left' ? r.left : r.right - mw;
    left = Math.max(8, Math.min(left, vw - mw - 8));
    let top = r.bottom + 6;
    if (top + mh > vh - 8 && r.top - mh - 6 > 8) top = r.top - mh - 6;
    menu.style.left = `${left}px`;
    menu.style.top = `${Math.max(8, top)}px`;
  }
  window.addEventListener('resize', () => closeMenus());
  // scrolling the page (not the menu itself) closes an open menu, as native menus do
  document.addEventListener('scroll', (e) => { if (openMenu && !(e.target instanceof Node && openMenu.wrap.contains(e.target))) closeMenus(); }, true);

  function menuButton(trigger, getItems, { align = 'right', onClose } = {}) {
    const wrap = h('span', { class: 'menuwrap' }, trigger);
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    let menu = null;
    const items = () => [...menu.querySelectorAll('.mi')].filter((x) => x.offsetParent !== null);
    const close = (refocus = true) => {
      if (!menu) return;
      menu.remove();
      menu = null;
      trigger.setAttribute('aria-expanded', 'false');
      if (openMenu && openMenu.wrap === wrap) openMenu = null;
      if (refocus) trigger.focus();
      if (onClose) onClose();
      // a refresh that arrived while the menu was open is painted now (focus is kept by key)
      const v = state.view;
      if (v && v.dirty && v.kind === 'list') setTimeout(() => { if (!openMenu && state.view === v) renderInbox(true); }, 0);
      // the same for a collection's source rows
      const m = state.merge;
      if (m && m.srcDirty && m.redrawSources) setTimeout(() => { if (!openMenu && state.merge === m && m.srcDirty) m.redrawSources(); }, 0);
    };
    const build = (list, parent) => {
      for (const it of list.filter(Boolean)) {
        if (it.sep) { parent.append(h('div', { class: 'msep', role: 'separator' })); continue; }
        if (it.hint) { parent.append(h('div', { class: 'mhint', text: it.hint })); continue; }
        if (it.sub) {
          const group = h('div', { class: 'msub', role: 'group', 'aria-label': it.label, hidden: true });
          const btn = h('button', { type: 'button', class: 'mi', role: 'menuitem', 'aria-expanded': 'false',
            onclick: () => {
              const show = group.hidden;
              group.hidden = !show;
              btn.setAttribute('aria-expanded', String(show));
              if (show) { const f = group.querySelector('.mi'); if (f) f.focus(); }
            } },
          it.icon ? icon(it.icon) : null, h('span', { class: 'mlabel', text: it.label }), icon('chevdown', 'sm chev'));
          parent.append(btn, group);
          build(it.sub, group);
          continue;
        }
        parent.append(h('button', {
          type: 'button', class: `mi${it.danger ? ' danger' : ''}${it.on ? ' on' : ''}`, role: 'menuitem',
          onclick: async () => {
            close(!it.keepFocus);
            try { await it.onClick(); } catch (x) { toast(x.message, true); }
          },
        }, it.icon ? icon(it.icon, it.tone ? `c-${it.tone}` : '') : null, h('span', { class: 'mlabel', text: it.label })));
      }
    };
    // submenus open in place, so the menu may grow: keep it on screen
    const reflow = () => { if (menu) placeMenu(menu, trigger, align); };
    const open = () => {
      closeMenus();
      menu = h('div', { class: 'menu', role: 'menu', 'aria-label': trigger.getAttribute('aria-label') || trigger.textContent.trim() });
      build(getItems(), menu);
      if (!menu.querySelector('.mi')) menu.append(h('div', { class: 'mhint', text: 'Nothing to do here' }));
      menu.addEventListener('click', () => setTimeout(reflow, 0));
      wrap.append(menu);
      placeMenu(menu, trigger, align);
      trigger.setAttribute('aria-expanded', 'true');
      openMenu = { wrap, close };
      const first = items()[0];
      if (first) first.focus();
    };
    trigger.addEventListener('click', (e) => { e.stopPropagation(); if (menu) close(); else open(); });
    trigger.addEventListener('keydown', (e) => {
      // stop here, or the wrap handler below would move past the first item at once
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !menu) { e.preventDefault(); e.stopPropagation(); open(); }
    });
    wrap.addEventListener('keydown', (e) => {
      if (!menu) return;
      const list = items();
      const i = list.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); (list[i + 1] || list[0]).focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); (list[i - 1] || list[list.length - 1]).focus(); }
      else if (e.key === 'Home') { e.preventDefault(); list[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); list[list.length - 1].focus(); }
      else if (e.key === 'Tab') close(false);
    });
    return wrap;
  }
  const moreBtn = (name, getItems, opts = {}) => menuButton(
    h('button', { type: 'button', class: 'ibtn more', 'aria-label': `More actions for ${name}`, title: 'More actions', 'data-fkey': opts.fkey || null }, icon('more')), getItems, opts);

  // Re-renders replace DOM nodes. Controls carry a stable data-fkey so keyboard focus comes back to
  // the same control afterwards, instead of dropping to the top of the page.
  const focusKey = () => {
    const a = document.activeElement;
    return a && a !== document.body && a.dataset ? a.dataset.fkey || null : null;
  };
  function restoreFocus(key) {
    if (!key || (document.activeElement && document.activeElement !== document.body && document.body.contains(document.activeElement))) return;
    const el = [...document.querySelectorAll('[data-fkey]')].find((x) => x.dataset.fkey === key);
    if (el) el.focus();
  }

  // ---------- sign in ----------
  function brandBlock() {
    return h('div', { class: 'brand' }, icon('bookmarkfill', 'mark'),
      h('span', { class: 'words' }, h('span', { class: 'name', text: 'Tweet Vault' }), h('span', { class: 'by', text: 'by The Tech Leverage' })));
  }
  function authScreen(...kids) {
    // leaving the signed-in app: stop polling and invalidate any request still in flight
    clearTimeout(state.timer);
    state.inboxSeq += 1;
    state.secSeq += 1;
    closeMenus();
    clear(app);
    state.shell = null;
    state.view = null;
    app.append(h('main', { class: 'center' }, ...kids));
  }

  function showLogin() {
    const pw = h('input', { type: 'password', id: 'pw', autocomplete: 'current-password', required: true, autofocus: true });
    const err = h('p', { class: 'err', role: 'alert' });
    const btn = h('button', { type: 'submit', class: 'btn primary', text: 'Sign in' });
    const form = h('form', { class: 'card narrow', onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      btn.disabled = true;
      try {
        const r = await api('POST', '/api/login', { password: pw.value });
        if (r.mfa_required) showCode();
        else await boot();
      } catch (x) { err.textContent = x.message; pw.select(); btn.disabled = false; }
    } },
    brandBlock(),
    h('h1', { text: 'Sign in' }),
    h('label', { class: 'lbl', for: 'pw', text: 'Password' }), pw,
    btn, err);
    authScreen(form);
    pw.focus();
  }

  function showCode() {
    let useRecovery = false;
    const input = h('input', { id: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, pattern: '[0-9]{6}', required: true });
    const label = h('label', { class: 'lbl', for: 'code', text: 'Code from Google Authenticator' });
    const trust = h('input', { type: 'checkbox', id: 'trust', checked: true });
    const err = h('p', { class: 'err', role: 'alert' });
    const toggle = h('button', { type: 'button', class: 'tbtn', text: 'Use a recovery code instead', onclick: () => {
      useRecovery = !useRecovery;
      label.textContent = useRecovery ? 'Recovery code (like abcd-2345)' : 'Code from Google Authenticator';
      input.removeAttribute('pattern');
      input.setAttribute('maxlength', useRecovery ? '9' : '6');
      input.setAttribute('inputmode', useRecovery ? 'text' : 'numeric');
      if (!useRecovery) input.setAttribute('pattern', '[0-9]{6}');
      toggle.textContent = useRecovery ? 'Use the authenticator code instead' : 'Use a recovery code instead';
      input.value = '';
      input.focus();
    } });
    const go1 = h('button', { type: 'submit', class: 'btn primary', text: 'Continue' });
    const form = h('form', { class: 'card narrow', onsubmit: async (e) => {
      e.preventDefault();
      if (go1.disabled) return;
      err.textContent = '';
      go1.disabled = true;
      try {
        const body = useRecovery ? { recovery_code: input.value, trust: trust.checked } : { code: input.value, trust: trust.checked };
        const r = await api('POST', '/api/login/mfa', body);
        // boot() may be leaving for the consent page (connecting Claude): then nothing more happens here
        if (await boot() === 'next') return;
        if (useRecovery) {
          toast(`Signed in. ${r.recovery_left} recovery codes left.`);
          go({ tab: 'security' });
        }
      } catch (x) { err.textContent = x.message; input.select(); go1.disabled = false; }
    } },
    brandBlock(),
    h('h1', { text: 'Two-step sign-in' }),
    label, input,
    h('label', { class: 'check' }, trust, ' Keep me signed in on this computer for 30 days'),
    go1, toggle, err);
    authScreen(form);
    input.focus();
  }

  async function showMfaSetup(currentCode) {
    const box = h('div', { class: 'card narrow' }, brandBlock(), h('h1', { text: 'Set up two-step sign-in' }), h('p', { text: 'Loading…' }));
    authScreen(box);
    let s;
    try { s = await api('POST', '/api/mfa/setup', currentCode ? { code: currentCode } : {}); } catch (x) {
      if (x.code === 'signed_out' || !document.body.contains(box)) return;
      box.lastChild.replaceWith(h('p', { class: 'err', role: 'alert', text: x.message }),
        h('button', { type: 'button', class: 'btn', text: 'Try again', onclick: () => showMfaSetup(currentCode) }));
      return;
    }
    if (!document.body.contains(box)) return;
    clear(box);
    const input = h('input', { id: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, pattern: '[0-9]{6}', required: true });
    const keep = h('input', { type: 'checkbox', id: 'keep', checked: true });
    const err = h('p', { class: 'err', role: 'alert' });
    const turnOn = h('button', { type: 'submit', class: 'btn primary', text: 'Turn on two-step sign-in' });
    const form = h('form', { onsubmit: async (e) => {
      e.preventDefault();
      if (turnOn.disabled) return;
      err.textContent = '';
      turnOn.disabled = true;
      try {
        const r = await api('POST', '/api/mfa/confirm', { code: input.value, trust: keep.checked });
        showRecoveryCodes(r.recovery_codes, true);
      } catch (x) { err.textContent = x.message; input.select(); turnOn.disabled = false; }
    } }, h('label', { class: 'lbl', for: 'code', text: '3. Type the 6-digit code it shows' }), input,
    h('label', { class: 'check' }, keep, ' Keep me signed in on this computer for 30 days'),
    turnOn, err);
    box.append(
      brandBlock(),
      h('h1', { text: 'Set up two-step sign-in' }),
      h('p', { text: '1. Open Google Authenticator on your phone and tap + then "Scan a QR code".' }),
      h('img', { class: 'qr', src: s.qr, alt: 'QR code for Google Authenticator', width: 240, height: 240 }),
      h('p', { class: 'muted', text: "2. Can't scan? Choose \"Enter a setup key\" and type this key:" }),
      h('p', { class: 'mono key', text: s.secret }),
      form,
    );
    input.focus();
  }

  function showRecoveryCodes(codes, firstTime) {
    const text = codes.join('\n');
    const ok = h('input', { type: 'checkbox', id: 'saved' });
    const goBtn = h('button', { class: 'btn primary', disabled: true, text: 'Continue to the vault', onclick: () => boot() });
    ok.addEventListener('change', () => { goBtn.disabled = !ok.checked; });
    authScreen(h('div', { class: 'card narrow' },
      brandBlock(),
      h('h1', { text: firstTime ? 'Two-step sign-in is on' : 'New recovery codes' }),
      h('p', { text: 'Save these 8 recovery codes somewhere safe (a password manager is ideal). Each works once if you lose your phone.' }),
      h('pre', { class: 'codes', text }),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => copyText(text, 'recovery codes') }, icon('copy'), 'Copy codes'),
        h('button', { class: 'btn', text: 'Download .txt', onclick: () => {
          const a = h('a', { href: URL.createObjectURL(new Blob([`Tweet Vault recovery codes\n\n${text}\n`], { type: 'text/plain' })), download: 'tweet-vault-recovery-codes.txt' });
          document.body.append(a); a.click(); a.remove();
        } })),
      h('label', { class: 'check' }, ok, ' I saved my recovery codes'),
      goBtn));
  }

  // ---------- shell: header + sidebar ----------
  const PRIORITY = { 3: 'High', 2: 'Medium', 1: 'Low', 0: 'None' };
  const SORTS = [['saved_desc', 'Newest saved'], ['saved_asc', 'Oldest saved'], ['posted_desc', 'Newest posted'], ['priority', 'Priority'], ['likes', 'Most liked']];
  const BSORTS = [['updated', 'Recently updated'], ['saved_desc', 'Newest merged'], ['saved_asc', 'Oldest merged'], ['posted_desc', 'Newest posted'], ['priority', 'Priority'], ['likes', 'Most liked']];
  const TAB_NAMES = { inbox: 'Inbox', bundles: 'Merged', archived: 'Archived', trashed: 'Trash', security: 'Security', recipes: 'Prompt recipes', voice: 'Voice notes' };
  const catOf = (id) => (state.org.categories || []).find((x) => x.id === id) || null;
  const catName = (id) => { const c = catOf(id); return c ? c.name : null; };
  // Categories as a tree, in sidebar order: each top-level one, then its subcategories. `path` is the
  // name with its parent ("Claude AI › Claude tips"); `depth` is 0 or 1.
  function catTree() {
    const all = state.org.categories || [];
    const ids = new Set(all.map((c) => c.id));
    const out = [];
    for (const c of all) {
      if (c.parent_id && ids.has(c.parent_id)) continue;
      out.push({ ...c, depth: 0, path: c.name });
      for (const k of all) if (k.parent_id === c.id) out.push({ ...k, depth: 1, path: `${c.name} › ${k.name}` });
    }
    return out;
  }
  const catPath = (id) => { const c = catOf(id); const p = c && c.parent_id ? catOf(c.parent_id) : null; return c ? (p ? `${p.name} › ${c.name}` : c.name) : null; };
  const catOption = (c) => `${c.depth ? '\u2003' : ''}${c.name}`;   // a subcategory is indented in a dropdown

  // Category cue: a small icon and colour per category, always next to its name.
  function catTone(cat) {
    if (!cat) return { icon: 'tag', tone: 'gold' };
    const n = cat.name.toLowerCase();
    if (/youtube|\byt\b/.test(n)) return { icon: 'play', tone: 'blue' };
    if (/video|reel|short/.test(n)) return { icon: 'video', tone: 'burgundy' };
    return { icon: 'folder', tone: ['teal', 'blue', 'burgundy', 'gold'][cat.id % 4] };
  }
  // byAi: the daily AI run chose it (the owner did not), shown as a small "AI" after the name
  function catMark(id, byAi) {
    const c = catOf(id);
    if (!c) return null;
    const t = catTone(c);
    return h('span', { class: `catmark t-${t.tone}`, title: byAi ? 'Filed by the daily AI run. Change it any time.' : null },
      icon(t.icon, `sm c-${t.tone}`), h('span', { text: catPath(id) }), byAi ? h('span', { class: 'aimark', text: 'AI' }) : null);
  }
  function prioChip(p) {
    if (!p) return null;
    return h('span', { class: `chip ${p === 3 ? 'high' : p === 2 ? 'gold' : 'low'}` }, p === 3 ? icon('star', 'xs') : null, `${PRIORITY[p]} priority`);
  }

  function filterQuery(sort) {
    const f = state.filter;
    const p = new URLSearchParams();
    if (f.category !== null) p.set('category', String(f.category));
    if (f.tag) p.set('tag', f.tag);
    if (f.priority) p.set('priority', String(f.priority));
    p.set('sort', sort || state.sort);
    return p.toString();
  }
  const scoped = () => state.filter.category !== null || state.filter.priority === 3;
  const anyFilter = () => state.filter.category !== null || !!state.filter.tag || !!state.filter.priority;

  async function go(changes) {
    const key = focusKey();
    const fromDrawer = !!(state.shell && state.shell.layout.classList.contains('drawer'));
    Object.assign(state, changes);
    state.merge = null;
    state.view = null;          // rebuild the page so the sidebar highlight and filter chips update
    state.selected.clear();
    if (!('selecting' in changes)) state.selecting = false;
    closeDrawer(false);
    await route();
    // after choosing in the drawer, land on the new page's heading; otherwise keep focus on the same control
    if (fromDrawer) { const t = document.querySelector('#main h1'); if (t) { t.setAttribute('tabindex', '-1'); t.focus(); } }
    else restoreFocus(key);
  }

  function setFilter(changes) {
    state.filter = { ...state.filter, ...changes };
    if (state.tab === 'security' || state.tab === 'recipes' || state.tab === 'voice') state.tab = 'inbox';
    go({});
  }
  // a sidebar view: plain list, no scope filters
  const openView = (tab) => go({ tab, voiceId: null, filter: { category: null, tag: null, priority: 0 } });
  const openScope = (f) => {
    const tab = state.tab === 'bundles' || state.tab === 'inbox' ? state.tab : 'inbox';
    go({ tab, filter: { category: null, tag: null, priority: 0, ...f } });
  };

  let lastOrg = '';
  async function refreshSidebar() {
    let o;
    try { o = await api('GET', '/api/organize'); } catch { return; }
    const sig = JSON.stringify(o);
    state.org = o;
    // rebuild only when something changed, so an open menu isn't closed by a refresh
    if (sig === lastOrg) return;
    if (state.shell && document.body.contains(state.shell.side)) {
      if (openMenu && state.shell.side.contains(openMenu.wrap)) return;   // try again on the next refresh
      fillSidebar();
    }
    lastOrg = sig;
  }

  function fillSidebar() {
    const side = clear(state.shell.side);
    const o = state.org;
    const c = o.counts || {};
    const f = state.filter;
    const onMerged = state.tab === 'bundles' || !!state.merge;
    const plain = !scoped() && !state.merge;
    const navBtn = ({ on, ic, tone, label, n, title, onclick }) => h('div', { class: 'navrow' },
      h('button', { type: 'button', class: `navbtn${on ? ' on' : ''}`, 'aria-current': on ? 'page' : null, title, onclick },
        icon(ic, `c-${tone}`), h('span', { class: 'label', text: label }), n !== undefined && n !== null ? h('span', { class: 'count', text: String(n) }) : null));
    const view = (k, ic, tone, label, n) => navBtn({ on: (state.tab === k && plain) || (k === 'bundles' && !!state.merge), ic, tone, label, n, onclick: () => openView(k) });

    const catRow = (cat) => {
      const t = catTone(cat);
      const on = f.category === cat.id && !state.merge;
      const row = navBtn({ on, ic: t.icon, tone: t.tone, label: cat.name, n: onMerged ? cat.merged : cat.items,
        title: `${plural(cat.items, 'Inbox item')}, ${plural(cat.merged, 'collection')}`,
        onclick: () => openScope({ category: cat.id }) });
      if (cat.depth) row.classList.add('sub');
      row.append(h('span', { class: 'rowmore' }, moreBtn(cat.name, () => catActions(cat), { fkey: `catmore:${cat.id}` })));
      return row;
    };

    side.append(...[
      h('nav', { 'aria-label': 'Views' },
        view('inbox', 'inbox', 'teal', 'Inbox', c.inbox),
        view('bundles', 'layers', 'blue', 'Merged', c.merged),
        navBtn({ on: state.tab === 'voice' && !state.merge, ic: 'mic', tone: 'burgundy', label: 'Voice notes', onclick: () => openView('voice') }),
        navBtn({ on: f.priority === 3 && f.category === null && !state.merge, ic: 'star', tone: 'gold', label: 'High priority',
          n: onMerged ? c.high_merged : c.high_items,
          title: `${plural(c.high_items || 0, 'Inbox item')}, ${plural(c.high_merged || 0, 'collection')}`,
          onclick: () => openScope({ priority: 3 }) }),
        view('archived', 'archive', 'muted', 'Archived', c.archived),
        view('trashed', 'trash', 'burgundy', 'Trash', c.trashed)),
      h('div', { class: 'sidesep' }),
      h('div', { class: 'sidehead' }, h('span', { id: 'cathead', text: 'Categories' }),
        h('button', { type: 'button', class: 'ibtn sm', 'aria-label': 'New category', title: 'New category', onclick: async () => {
          const name = await askText({ title: 'New category', label: 'Name', ok: 'Add category' });
          if (!name) return;
          try { await api('POST', '/api/categories', { name }); await refreshSidebar(); toast('Category added'); } catch (x) { toast(x.message, true); }
        } }, icon('plus'))),
      h('nav', { 'aria-labelledby': 'cathead' },
        catTree().map(catRow),
        navBtn({ on: f.category === 'none' && !state.merge, ic: 'tag', tone: 'gold', label: 'Uncategorized', onclick: () => openScope({ category: 'none' }) })),
      h('div', { class: 'sidefoot' },
        h('div', { class: 'sidesep' }),
        navBtn({ on: state.tab === 'security' && !state.merge, ic: 'gear', tone: 'muted', label: 'Security', onclick: () => openView('security') }),
        navBtn({ on: state.tab === 'recipes' && !state.merge, ic: 'note', tone: 'muted', label: 'Prompt recipes', onclick: () => openView('recipes') }),
        navBtn({ on: false, ic: 'logout', tone: 'muted', label: 'Sign out', onclick: signOut })),
    ].flat(Infinity).filter(Boolean));
  }

  // rename / delete a category (sidebar row menu and the category page header)
  function catActions(cat) {
    const after = async (msg) => {
      lastOrg = '';
      await refreshSidebar();
      toast(msg);
      if (state.merge) route(); else go({});   // page title and chips show the change
    };
    const all = state.org.categories || [];
    const isSub = !!cat.parent_id;
    const hasSubs = all.some((c) => c.parent_id === cat.id);
    const move = async (parent_id, msg) => {
      try { await api('PATCH', `/api/categories/${cat.id}`, { parent_id }); await after(msg); } catch (x) { toast(x.message, true); }
    };
    // a category with subcategories stays at the top level, so it gets no "Move under"
    const targets = hasSubs ? [] : all.filter((c) => !c.parent_id && c.id !== cat.id && c.id !== cat.parent_id);
    return [
      !isSub ? { label: 'New subcategory', icon: 'plus', onClick: async () => {
        const name = await askText({ title: `New subcategory in ${cat.name}`, label: 'Name', ok: 'Add subcategory' });
        if (!name) return;
        try { await api('POST', '/api/categories', { name, parent_id: cat.id }); await after('Subcategory added'); } catch (x) { toast(x.message, true); }
      } } : null,
      targets.length ? { label: 'Move under', icon: 'folder', sub: targets.map((c) => ({ label: c.name, onClick: () => move(c.id, `Moved under ${c.name}`) })) } : null,
      isSub ? { label: 'Move to top level', icon: 'folder', onClick: () => move(null, 'Moved to the top level') } : null,
      { label: 'Rename category', icon: 'pencil', onClick: async () => {
        const name = await askText({ title: 'Rename category', label: 'Name', value: cat.name });
        if (!name || name === cat.name) return;
        try { await api('PATCH', `/api/categories/${cat.id}`, { name }); await after('Category renamed'); } catch (x) { toast(x.message, true); }
      } },
      { sep: true },
      { label: 'Delete category', icon: 'trash', danger: true, onClick: async () => {
        if (!await confirmBox({ title: `Delete "${cat.name}"?`, body: hasSubs ? 'The items in it stay. They just won\'t have a category. Its subcategories move to the top level.' : 'The items in it stay. They just won\'t have a category.', ok: 'Delete category', danger: true })) return;
        try {
          await api('DELETE', `/api/categories/${cat.id}`);
          if (state.filter.category === cat.id) state.filter.category = null;
          await after('Category deleted');
        } catch (x) { toast(x.message, true); }
      } },
    ].filter(Boolean);
  }

  async function signOut() {
    await api('POST', '/api/logout', {}).catch(() => {});
    state.me = null;
    state.shell = null;
    route();
  }

  // sidebar: expanded/hidden on desktop (remembered), an overlay drawer below 800px
  const mobileQ = window.matchMedia('(max-width: 800px)');
  const isMobile = () => mobileQ.matches;
  function syncBurger() {
    const s = state.shell;
    if (!s) return;
    const shown = isMobile() ? s.layout.classList.contains('drawer') : !s.layout.classList.contains('collapsed');
    s.burger.setAttribute('aria-expanded', String(shown));
    const label = shown ? 'Hide sidebar' : 'Show sidebar';
    s.burger.setAttribute('aria-label', label);
    s.burger.title = label;
  }
  function closeDrawer(refocus = true) {
    const s = state.shell;
    if (!s || !s.layout.classList.contains('drawer')) return;
    s.layout.classList.remove('drawer');
    syncBurger();
    if (refocus) s.burger.focus();
  }
  function toggleSidebar() {
    const s = state.shell;
    if (isMobile()) {
      const open = !s.layout.classList.contains('drawer');
      s.layout.classList.toggle('drawer', open);
      syncBurger();
      if (open) { const f = s.side.querySelector('.navbtn'); if (f) f.focus(); }
      return;
    }
    const collapsed = !s.layout.classList.contains('collapsed');
    s.layout.classList.toggle('collapsed', collapsed);
    store.set('tv.sidebar', collapsed ? 'hidden' : 'shown');
    syncBurger();
  }
  mobileQ.addEventListener('change', () => { if (state.shell) state.shell.layout.classList.remove('drawer'); syncBurger(); });
  document.addEventListener('keydown', (e) => {
    const s = state.shell;
    if (document.querySelector('dialog[open]')) return;   // a modal handles its own keys
    if (e.key === 'Escape' && s && s.layout.classList.contains('drawer') && !openMenu) { closeDrawer(); return; }
    // keep focus inside the open drawer
    if (e.key === 'Tab' && s && s.layout.classList.contains('drawer') && !openMenu) {
      const f = [s.burger, ...s.side.querySelectorAll('button')].filter((x) => x.offsetParent !== null || x === s.burger);
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
    }
    if (e.key === '/' && s && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) && !document.querySelector('dialog[open]')) {
      e.preventDefault(); s.search.focus();
    }
  });

  function buildShell() {
    clear(app);
    const burger = h('button', { type: 'button', class: 'ibtn burger', 'aria-controls': 'primary-sidebar', onclick: toggleSidebar }, icon('menu'));
    const search = h('input', { type: 'search', id: 'gq', placeholder: 'Search your vault', value: state.q, autocomplete: 'off' });
    let deb = null;
    search.addEventListener('input', () => {
      clearTimeout(deb);
      deb = setTimeout(() => {
        state.q = search.value;
        if (state.merge || state.tab === 'security' || state.tab === 'recipes' || state.tab === 'voice') { go({ tab: state.merge ? 'bundles' : 'inbox' }); return; }
        if (state.tab === 'bundles') {
          const bq = document.getElementById('bq');
          if (bq) bq.value = search.value;
          renderBundles().catch(() => {});
          return;
        }
        loadInbox().catch(() => {});
      }, 300);
    });
    const header = h('header', { class: 'top' },
      burger,
      h('a', { class: 'brand', href: '/', 'aria-label': 'Tweet Vault, go to Inbox', onclick: (e) => { e.preventDefault(); openView('inbox'); } },
        icon('bookmarkfill', 'mark'),
        h('span', { class: 'words' }, h('span', { class: 'name', text: 'Tweet Vault' }), h('span', { class: 'by', text: 'by The Tech Leverage' }))),
      h('div', { class: 'gsearch', role: 'search' }, icon('search'), h('label', { for: 'gq', class: 'sr', text: 'Search your vault' }), search),
      menuButton(h('button', { type: 'button', class: 'avatar', 'aria-label': 'Account', title: 'Account' }, icon('user')), () => [
        { label: 'Security', icon: 'gear', onClick: () => openView('security') },
        { label: 'Prompt recipes', icon: 'note', onClick: () => openView('recipes') },
        { label: 'Theme', icon: 'theme', sub: THEMES.map(([v, l]) => ({ label: l, on: themeChoice() === v, onClick: () => setTheme(v) })) },
        canTranslate() ? { label: 'Auto-translate', icon: 'refresh', sub: [['on', 'On: Chinese, Japanese and other scripts'], ['off', 'Off: translate on request']].map(([v, l]) => ({
          label: l, on: (autoTr() ? 'on' : 'off') === v,
          onClick: () => { store.set('tv.autotr', v); autoStopped = false; toast(v === 'on' ? 'Auto-translate on' : 'Auto-translate off'); if (v === 'on') autoTranslate(); },
        })) } : null,
        { sep: true },
        { label: 'Sign out', icon: 'logout', onClick: signOut },
      ]));
    const side = h('aside', { class: 'side', id: 'primary-sidebar', 'aria-label': 'Navigate and organize' });
    // a click on a nav item closes the mobile drawer
    side.addEventListener('click', (e) => { if (e.target.closest('.navbtn') && isMobile()) closeDrawer(false); });
    const inner = h('div', { class: 'inner' });
    const main = h('main', { class: 'page', id: 'main' }, inner);
    const layout = h('div', { class: `layout${store.get('tv.sidebar') === 'hidden' ? ' collapsed' : ''}` },
      side, h('div', { class: 'backdrop', onclick: () => closeDrawer() }), main);
    app.append(header, layout);
    state.shell = { header, side, main, inner, layout, burger, search };
    syncBurger();
    lastOrg = '';
  }

  // Returns the (emptied) page area. Header and sidebar stay, so typing in search is never interrupted.
  function shell() {
    if (!state.shell || !document.body.contains(state.shell.layout)) buildShell();
    closeMenus();
    state.view = null;
    if (state.shell.search.value !== state.q && document.activeElement !== state.shell.search) state.shell.search.value = state.q;
    fillSidebar();
    refreshSidebar();
    return clear(state.shell.inner);
  }

  // ---------- shared bits ----------
  const tabTitle = () => {
    if (state.filter.category !== null) return state.filter.category === 'none' ? 'Uncategorized' : (catName(state.filter.category) || 'Category');
    if (state.filter.priority === 3) return 'High priority';
    return TAB_NAMES[state.tab] || 'Inbox';
  };

  function pageHead(title, countText, action) {
    const count = h('span', { class: 'scount', text: countText || '' });
    // a category page offers Rename / Delete right in its header (not only in the sidebar)
    const cat = typeof state.filter.category === 'number' ? catOf(state.filter.category) : null;
    const act = action || (cat ? moreBtn(`the ${cat.name} category`, () => catActions(cat), { fkey: 'catpage' }) : null);
    return { el: h('div', { class: 'phead' }, h('h1', { text: title }), count, act ? h('span', { class: 'act' }, act) : null), count };
  }

  function sortSelect(list, current, onPick) {
    return h('select', { class: 'sel', 'aria-label': 'Sort by', 'data-fkey': 'sort', onchange: (e) => onPick(e.target.value) },
      list.map(([v, l]) => h('option', { value: v, text: l, selected: current === v ? 'selected' : null })));
  }

  function filtersToggle() {
    const n = (state.filter.tag ? 1 : 0) + (state.filter.priority && state.filter.priority !== 3 ? 1 : 0) + (state.filter.category !== null && !scoped() ? 1 : 0);
    // opens and closes in place: no page rebuild, so the selection and a typed draft stay
    const btn = h('button', { type: 'button', class: 'btn compact', 'aria-expanded': String(state.filtersOpen), 'aria-controls': 'fpanel', 'data-fkey': 'filters',
      onclick: () => {
        state.filtersOpen = !state.filtersOpen;
        btn.setAttribute('aria-expanded', String(state.filtersOpen));
        const p = document.getElementById('fpanel');
        if (p) p.replaceWith(filtersPanel());
      } },
    icon('filter', 'sm'), n ? `Filters (${n})` : 'Filters');
    return btn;
  }

  // the Filters disclosure: category, priority and tag in one quiet panel (always in the page, hidden when closed)
  function filtersPanel() {
    const f = state.filter;
    return h('div', { class: 'fpanel', id: 'fpanel', hidden: !state.filtersOpen },
      h('label', {}, 'Category', h('select', { class: 'sel', 'data-fkey': 'fcat', onchange: (e) => { const v = e.target.value; setFilter({ category: v === '' ? null : v === 'none' ? 'none' : Number(v) }); } },
        h('option', { value: '', text: 'Any category' }),
        catTree().map((c) => h('option', { value: String(c.id), text: catOption(c), selected: f.category === c.id ? 'selected' : null })),
        h('option', { value: 'none', text: 'Uncategorized', selected: f.category === 'none' ? 'selected' : null }))),
      h('label', {}, 'Priority', h('select', { class: 'sel', 'data-fkey': 'fprio', onchange: (e) => setFilter({ priority: Number(e.target.value) }) },
        [[0, 'Any priority'], [3, 'High'], [2, 'Medium or higher'], [1, 'Low or higher']].map(([v, l]) => h('option', { value: String(v), text: l, selected: f.priority === v ? 'selected' : null })))),
      h('label', {}, 'Tag', h('select', { class: 'sel', 'data-fkey': 'ftag', onchange: (e) => setFilter({ tag: e.target.value || null }) },
        h('option', { value: '', text: (state.org.tags || []).length ? 'Any tag' : 'No tags yet' }),
        (state.org.tags || []).map((t) => h('option', { value: t.name, text: `#${t.name} (${state.tab === 'bundles' ? t.merged : t.items})`, selected: f.tag && f.tag.toLowerCase() === t.name.toLowerCase() ? 'selected' : null })))));
  }

  // applied filters as removable chips, plus Clear filters
  function appliedChips() {
    const f = state.filter;
    const chips = [];
    if (f.category !== null) {
      const c = catOf(f.category);
      const t = catTone(c);
      chips.push(h('span', { class: 'fchip' }, icon(t.icon, `sm c-${t.tone}`), f.category === 'none' ? 'Uncategorized' : (c ? c.name : 'Category'),
        h('button', { type: 'button', 'aria-label': 'Remove category filter', title: 'Remove', onclick: () => setFilter({ category: null }) }, icon('x', 'xs'))));
    }
    if (f.priority) {
      chips.push(h('span', { class: `fchip${f.priority === 3 ? ' high' : ''}` }, icon('star', 'sm'), f.priority === 3 ? 'High priority' : `${PRIORITY[f.priority]} priority or higher`,
        h('button', { type: 'button', 'aria-label': 'Remove priority filter', title: 'Remove', onclick: () => setFilter({ priority: 0 }) }, icon('x', 'xs'))));
    }
    if (f.tag) {
      chips.push(h('span', { class: 'fchip' }, icon('tag', 'sm c-teal'), `#${f.tag}`,
        h('button', { type: 'button', 'aria-label': `Remove tag filter ${f.tag}`, title: 'Remove', onclick: () => setFilter({ tag: null }) }, icon('x', 'xs'))));
    }
    if (!chips.length) return [];
    return [...chips, h('button', { type: 'button', class: 'tbtn', text: 'Clear filters', onclick: () => setFilter({ category: null, tag: null, priority: 0 }) })];
  }

  function scopeSelect() {
    return h('select', { class: 'sel', 'aria-label': 'Show', 'data-fkey': 'scope', onchange: (e) => go({ tab: e.target.value }) },
      [['inbox', 'Inbox items'], ['bundles', 'Merged collections'], ['archived', 'Archived items'], ['trashed', 'Trash']]
        .map(([v, l]) => h('option', { value: v, text: l, selected: state.tab === v ? 'selected' : null })));
  }

  function emptyCard({ ic, tone, title, text, links = [], start = false }) {
    const ls = links.filter(Boolean);
    return h('div', { class: `card empty${start ? ' start' : ''}` },
      h('div', { class: `eicon ${tone || ''}` }, icon(ic)),
      h('h2', { text: title }),
      text ? h('p', { text }) : null,
      ls.length ? h('div', { class: 'links' }, ls.map((l, i) => [i ? h('span', { class: 'bar', 'aria-hidden': 'true' }) : null,
        h('button', { type: 'button', class: 'tbtn', onclick: l.onClick }, l.label, l.ext ? icon('ext', 'sm') : null)])) : null);
  }

  // category + priority pickers used in the editor's details
  function catSelect(current, onPick) {
    return h('select', { class: 'sel', 'aria-label': 'Category', onchange: async (e) => {
      const v = e.target.value;
      if (v === '__new') {
        e.target.value = current ? String(current) : 'none';
        const name = await askText({ title: 'New category', label: 'Name', ok: 'Add category' });
        if (!name) return;
        try { const r = await api('POST', '/api/categories', { name }); await refreshSidebar(); onPick(r.id); } catch (x) { toast(x.message, true); }
        return;
      }
      onPick(v === 'none' ? null : Number(v));
    } },
    catTree().map((c) => h('option', { value: String(c.id), text: catOption(c), selected: current === c.id ? 'selected' : null })),
    h('option', { value: 'none', text: 'No category', selected: !(state.org.categories || []).some((c) => c.id === current) ? 'selected' : null }),
    h('option', { value: '__new', text: '+ New category…' }));
  }

  function prioSelect(current, onPick) {
    return h('select', { class: 'sel', 'aria-label': 'Priority', onchange: (e) => onPick(Number(e.target.value)) },
      [3, 2, 1, 0].map((p) => h('option', { value: String(p), text: p ? `${PRIORITY[p]} priority` : 'No priority', selected: current === p ? 'selected' : null })));
  }

  async function askTags() {
    const v = await askText({ title: 'Add tags', label: 'Tags, separated by commas', hint: 'For example: agents, script-ideas', ok: 'Add tags' });
    if (!v) return null;
    const list = v.split(',').map((s) => s.trim().replace(/^#+/, '')).filter(Boolean);
    return list.length ? list : null;
  }

  function metaLine(x, { onRemoveTag } = {}) {
    const bits = [];
    if (x.priority) bits.push(prioChip(x.priority));
    if (x.category_id && catName(x.category_id)) bits.push(catMark(x.category_id, x.category_by === 'ai'));
    for (const t of x.tags || []) {
      bits.push(h('span', { class: 'tagchip' }, `#${t}`, onRemoveTag
        ? h('button', { type: 'button', title: `Remove #${t}`, 'aria-label': `Remove tag ${t}`, text: '×', onclick: () => onRemoveTag(t) }) : null));
    }
    return bits.length ? h('div', { class: 'metaline' }, bits) : null;
  }

  // ---------- identity cues ----------
  // first grapheme of a word, so Devanagari, emoji-free fancy text etc. aren't cut mid-character
  const seg = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  const firstChar = (w) => (seg ? (seg.segment(w)[Symbol.iterator]().next().value || { segment: '' }).segment : [...w][0] || '');
  function initialsOf(s) {
    // NFKC folds "𝐉𝐨𝐡𝐧"-style letters to plain ones; combining marks (\p{M}) stay part of their word
    const words = String(s || '').normalize('NFKC').replace(/^@/, '').replace(/[^\p{L}\p{M}\p{N}\s_]/gu, ' ').split(/[\s_]+/).filter(Boolean);
    if (!words.length) return '·';
    if (words.length === 1) {
      const w = words[0];
      return (/^[A-Z]{3,}$/.test(w) ? w.slice(0, 2) : firstChar(w)).toUpperCase();
    }
    return (firstChar(words[0]) + firstChar(words[1])).toUpperCase();
  }
  const TONES = ['blue', 'teal', 'burgundy', 'gold'];
  function toneOf(s) {
    let n = 0;
    for (const ch of String(s || '')) n = (n * 31 + ch.codePointAt(0)) >>> 0;
    return TONES[n % TONES.length];
  }
  const initials = (seed, label) => h('span', { class: `initials v-${toneOf(seed)}`, 'aria-hidden': 'true', text: initialsOf(label || seed) });
  // an author gets tinted initials; a note or link gets a small matching icon instead
  const avatarFor = (x) => (x.author_handle || x.author_name
    ? initials(x.author_handle || x.author_name, x.author_name || x.author_handle)
    : h('span', { class: `initials ${x.kind === 'text' ? 'v-gold' : 'v-teal'}`, 'aria-hidden': 'true' }, icon(x.kind === 'text' ? 'note' : 'ext', 'sm')));

  // ---------- capture ----------
  function captureBox() {
    const ta = h('textarea', { id: 'cap', rows: 1, placeholder: 'Paste a link or write a note…', 'aria-describedby': 'caperr', value: state.capDraft });
    const err = h('p', { class: 'cerr', id: 'caperr', role: 'alert' });
    const btn = h('button', { type: 'button', class: `btn ${state.selecting ? '' : 'primary'}`, text: 'Save', onclick: async () => {
      if (btn.disabled) return;
      const v = ta.value.trim();
      err.textContent = '';
      if (!v) { err.textContent = 'Paste a link or type a note first.'; ta.focus(); return; }
      btn.disabled = true;
      const w = btn.offsetWidth;
      btn.style.width = `${w}px`;
      clear(btn).append(h('span', { class: 'spin', 'aria-hidden': 'true' }), h('span', { class: 'sr', text: 'Saving' }));
      try {
        await api('POST', '/api/captures', { input: v, client_id: uuid(), source_app: 'web' });
        ta.value = '';
        state.capDraft = '';
        grow();
        toast('Saved');
        await loadInbox();
      } catch (x) { err.textContent = x.message; }
      btn.disabled = false;
      btn.style.width = '';
      clear(btn).append('Save');
    } });
    // a longer note with a title, which stays editable (noteEditor); the box above saves text as it is
    const writeBtn = h('button', { type: 'button', class: 'btn', onclick: async () => {
      const saved = await noteEditor(null);
      if (saved) { toast('Note saved'); await loadInbox(); }
    } }, icon('pencil', 'sm'), 'Write a note');
    const grow = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(220, Math.max(44, ta.scrollHeight + 2))}px`; ta.style.overflow = ta.scrollHeight > 220 ? 'auto' : 'hidden'; };
    ta.addEventListener('input', () => { state.capDraft = ta.value; grow(); });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) btn.click(); });
    if (state.capDraft) setTimeout(grow, 0);
    const sec = h('section', { class: 'capture', 'aria-labelledby': 'caph' },
      h('div', { class: 'chead' },
        h('h2', { id: 'caph' }, 'Found something ', h('span', { class: 'goldline', text: 'worth keeping' }), '?'),
        h('span', { class: 'types', text: 'Links · Posts · Notes' })),
      h('div', { class: 'crow' }, h('label', { for: 'cap', class: 'sr', text: 'Paste a link or write a note' }), ta, btn, writeBtn),
      err);
    return { el: sec, btn };
  }

  // ---------- inbox ----------
  // A row can be ticked when it's one of yours in this list, or an unsaved context post (e.g. the
  // article above replies you saved). Saved rows shown only as context (archived, filtered out,
  // already merged) can't, so bulk actions never touch them by accident.
  const canPick = (x) => x && (!x.context || (!x.saved && !(x.merged_in || []).length));
  const allIds = (g) => [g.root, ...g.thread, ...g.replies].filter(canPick).map((x) => x.id);
  const LIST_TABS = { inbox: 'inbox', archived: 'archived', trashed: 'trashed' };
  // (leaving the app for a sign-in screen also bumps inboxSeq, so polls already in flight stop too)
  const signedIn = () => !!state.me;

  async function loadInbox() {
    // only list views poll, and only while signed in
    if (!LIST_TABS[state.tab] || state.merge || !signedIn()) return;
    const st = LIST_TABS[state.tab];
    const seq = ++state.inboxSeq;
    const tab = state.tab;
    let pending = false;
    try {
      const [r, b] = await Promise.all([
        api('GET', `/api/inbox?state=${st}&q=${encodeURIComponent(state.q)}&${filterQuery()}`),
        api('GET', '/api/bundles').catch(() => ({ bundles: state.bundles })),
        refreshSidebar(),   // cards need the category names
      ]);
      // a slow answer must not paint over another view or a newer answer
      if (seq !== state.inboxSeq || state.merge || state.tab !== tab || !signedIn()) return;
      state.groups = r.groups;
      state.bundles = b.bundles;
      dropStaleTranslations(trCache, state.groups, seq);
      const valid = new Set(state.groups.flatMap(allIds));
      for (const id of [...state.selected]) if (!valid.has(id)) state.selected.delete(id);
      renderInbox();
      pending = state.groups.some((g) => [g.root, ...g.thread, ...g.replies].some((x) => x && (x.fetch_status === 'pending' || x.thread_status === 'queued')));
    } finally {
      // keep refreshing even after a failed poll (network blip, server restart), but never once signed out
      if (seq === state.inboxSeq && signedIn()) {
        clearTimeout(state.timer);
        state.timer = setTimeout(() => { if (!state.merge && LIST_TABS[state.tab] && signedIn()) loadInbox().catch(() => {}); }, pending ? 4000 : 30000);
      }
    }
  }

  async function setItemState(x, to, msg) {
    const from = x.state || 'inbox';
    try {
      await api('PATCH', `/api/items/${x.id}`, { state: to });
      // Undo refreshes whatever view you're on by then
      toast(msg, false, { label: 'Undo', fn: async () => { try { await api('PATCH', `/api/items/${x.id}`, { state: from }); } finally { route(); } } });
    } catch (e) { toast(e.message, true); }
    loadInbox();
  }

  function statusChip(x) {
    const map = { pending: ['Loading…', 'wait'], oembed: ['Basic text only', 'warn'], unavailable: ['Unavailable', 'bad'], failed: ['Failed', 'bad'] };
    // a re-read that failed but kept the text from before: a calm note, the reason in its tooltip
    const kept = x.kind === 'link' && x.link_has_text && x.fetch_error && (x.fetch_status === 'ok' || x.fetch_status === 'failed');
    const m = kept ? ['Old text kept', 'kept'] : map[x.fetch_status]
      || (x.kind === 'link' && x.link_type === 'web' && x.fetch_status === 'link_only' && x.fetch_error ? ['No article text', 'warn'] : null);
    return m ? h('span', { class: `chip ${m[1]}`, title: x.fetch_error || '', text: m[0] }) : null;
  }
  // ---- web articles (a shared page whose text the server read): they read like X articles ----
  const isWebArticle = (x) => !!(x && x.kind === 'link' && x.link_has_text);
  // articles, read web pages and video transcripts are long: they open in the reader instead of growing the card
  const opensInReader = (x) => x.kind === 'article' || isWebArticle(x) || !!x.video;
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./i, ''); } catch { return ''; } };
  const linkTitle = (x) => x.link_title || hostOf(x.url) || 'Article';
  // a page can be read again when it is an ordinary web page (not X itself, not a short link still being expanded)
  const canReadLink = (x) => !!(x && x.kind === 'link' && !x.context && safeHref(x.url) && x.fetch_status !== 'pending' && !x.note
    && !/^(x|twitter|mobile\.x|mobile\.twitter|www\.x|www\.twitter)\.com$/i.test(hostOf(x.url)));
  async function readLinkAgain(x) {
    try { await api('POST', `/api/items/${x.id}/read-link`, {}); fullCache.delete(x.id); toast('Getting the article text again'); } catch (e) { toast(e.message, true); }
    loadInbox();
  }
  function kindChip(x) {
    if (x.kind === 'article') return h('span', { class: 'chip article', text: 'Article' });
    if (x.kind === 'text' && x.voice_id) return h('span', { class: 'chip note' }, icon('mic'), 'Voice note');
    if (x.kind === 'text') return h('span', { class: 'chip note', text: x.book ? 'Quote' : 'Note' });
    if (x.video) return h('span', { class: 'chip link', text: 'Video' });
    if (x.kind === 'link') return h('span', { class: 'chip link', text: 'Link' });
    if (x.is_self_thread) return h('span', { class: 'chip thread', text: 'Thread' });
    return h('span', { class: 'chip post', text: 'Post' });
  }
  const kindName = (x) => (x.kind === 'article' ? 'Article' : x.kind === 'text' ? (x.voice_id ? 'Voice note' : x.book ? 'Quote' : 'Note') : x.kind === 'link' ? 'Link' : x.is_self_thread ? 'Thread' : 'Post');

  // Posts have no title: lead with the first line or sentence when it's short, the rest is the excerpt.
  function splitTitle(x) {
    if (x.kind === 'article') return [x.title || 'Article', x.preview || ''];
    // a voice note's text starts with its bold title: show the title once, then the notes
    if (x.voice_id && x.title) {
      return [x.title, String(x.preview || '').replace(/^\*\*[^\n]*\*\*\s*/, '').replace(/^#{1,6}\s+/gm, '')
        .replace(/^- \[[ x]\] /gm, '- ').replace(/\*\*|(^|\s)\*(?=\S)|(?<=\S)\*(\s|$)/g, '$1$2').replace(/\n{3,}/g, '\n\n')];
    }
    if (isWebArticle(x)) return [linkTitle(x), x.preview || ''];
    if (x.video && x.video.title) return [x.video.title, ''];
    // a note you wrote with a title: the title, then the whole note
    if (x.own_note && x.title) return [x.title, x.preview || ''];
    const raw = String(x.preview || (x.fetch_status === 'pending' ? 'Loading…' : x.url || '')).trim();
    if (!raw) return ['', ''];
    const nl = raw.indexOf('\n');
    const firstLine = nl >= 0 ? raw.slice(0, nl) : raw;
    let cut = firstLine.length;
    const m = /^(.{12,110}?[.!?…:])(\s|$)/u.exec(firstLine);
    if (m) cut = m[1].length;
    if (cut > 110) return ['', raw];
    return [raw.slice(0, cut).trim(), raw.slice(cut).trim()];
  }

  async function copyItems(ids, withSources, english = false) {
    try {
      const r = await api('POST', '/api/render', { item_ids: ids, title: '', english });
      copyText(withSources ? r.text_sources : r.text, `${english ? 'English ' : ''}${withSources ? 'with sources' : 'text'}`);
    } catch (x) { toast(x.message, true); }
  }

  // ---- full text: cards show a clamped preview (the server sends at most 600 characters);
  // "Show full text" loads the whole item and shows it in place. Kept across refreshes.
  const textOpen = new Set();
  const fullCache = new Map();

  // ---- translation (Claude Haiku on the server; the key never reaches this page) ----
  // The server sends x.lang (the detected non-Latin language) and x.translation (cached English) with each item.
  const trCache = new Map();      // id -> {text, lang, seq} made in this visit; seq = state.inboxSeq when made
  const showOrig = new Set();     // ids where the reader chose the original
  const trPending = new Set();
  const trFailed = new Map();     // id -> message; not retried automatically
  let autoStopped = false;        // daily cap reached, or translation unavailable: stop auto-translating
  const canTranslate = () => !!(state.me && state.me.translate);
  const autoTr = () => store.get('tv.autotr') !== 'off';
  const trOf = (x) => trCache.get(x.id) || x.translation || null;
  const shownTr = (x) => { const t = trOf(x); return t && !showOrig.has(x.id) ? t : null; };

  // A translation made on this page only bridges the gap until the next list load that started after it.
  // From then on the server's copy wins: x.translation, or none at all when the post's text has changed
  // (Fetch again, an edit elsewhere), so English of the old text is never shown for the new one.
  function dropStaleTranslations(cache, groups, seq) {
    for (const g of groups) {
      for (const x of [g.root, ...g.thread, ...g.replies]) {
        const e = x && cache.get(x.id);
        if (e && !(e.seq >= seq)) cache.delete(x.id);
      }
    }
  }

  // Translations finish in the background, maybe after you've moved on. Only repaint (or start more)
  // while an Inbox, Archived or Trash list is the page showing; otherwise renderInbox() would wipe
  // a merge, the Merged list or Security and put a stale list in its place.
  const listShowing = () => !!(LIST_TABS[state.tab] && !state.merge && state.view && state.view.kind === 'list');

  // the text is about to change: the English made for the old text no longer applies
  function forgetTranslation(id) {
    trCache.delete(id);
    showOrig.delete(id);
    trFailed.delete(id);
  }

  async function translateItem(x, { quiet = false } = {}) {
    if (trPending.has(x.id)) return;
    trPending.add(x.id);
    trFailed.delete(x.id);
    if (listShowing()) renderInbox();
    try {
      const r = await api('POST', `/api/items/${x.id}/translate`, {});
      trCache.set(x.id, { text: r.text, lang: r.lang || x.lang || null, seq: state.inboxSeq });
      showOrig.delete(x.id);
    } catch (e) {
      trFailed.set(x.id, e.message);
      if (['translate_cap', 'translate_off', 'translate_auth', 'rate_limited'].includes(e.code)) autoStopped = true;
      if (!quiet || autoStopped) toast(e.message, true);
    } finally {
      trPending.delete(x.id);
      if (listShowing()) renderInbox();
    }
  }

  // translate what's on screen that isn't English, two at a time; each item at most once per visit
  let autoRunning = 0;
  function autoTranslate() {
    // state.groups outlives the list page, so check the list is what's on screen
    if (!canTranslate() || !autoTr() || autoStopped || !listShowing()) return;
    const todo = state.groups.flatMap((g) => [g.root, ...g.thread, ...g.replies])
      .filter((x) => x && x.lang && !trOf(x) && !trPending.has(x.id) && !trFailed.has(x.id));
    while (autoRunning < 2 && todo.length) {
      const x = todo.shift();
      autoRunning += 1;
      translateItem(x, { quiet: true }).finally(() => { autoRunning -= 1; setTimeout(autoTranslate, 0); });
    }
  }

  // the language toggle shown on a card or reply
  function trControl(x) {
    if (trPending.has(x.id)) return h('span', { class: 'chip wait', role: 'status', text: 'Translating…' });
    const t = trOf(x);
    if (t) {
      const orig = showOrig.has(x.id);
      return h('button', { type: 'button', class: 'tbtn', 'data-fkey': `tr:${x.id}`, onclick: () => {
        if (orig) showOrig.delete(x.id); else showOrig.add(x.id);
        renderInbox(true);
      } }, icon('theme', 'sm'), orig ? 'Show English' : 'Show original');
    }
    if (canTranslate() && (x.lang || trFailed.has(x.id))) {
      return h('button', { type: 'button', class: 'tbtn', 'data-fkey': `tr:${x.id}`, title: trFailed.get(x.id) || 'Translate to English', onclick: () => translateItem(x) },
        icon('theme', 'sm'), trFailed.has(x.id) ? 'Try translating again' : 'Translate to English');
    }
    return null;
  }
  const trChip = (x) => {
    const t = shownTr(x);
    return t ? h('span', { class: 'chip ok', title: 'Translated by Claude (Haiku)', text: t.lang ? `Translated from ${t.lang}` : 'Translated' }) : null;
  };
  // [title, rest] of the English text: articles keep their first paragraph (the title) apart
  function trSplit(x, text) {
    if (x.kind === 'article') {
      const i = text.indexOf('\n\n');
      return i > 0 ? [text.slice(0, i).trim(), text.slice(i + 2).trim()] : [text.trim(), ''];
    }
    return splitTitle({ ...x, kind: 'tweet', preview: text });
  }

  const fullText = (x) => {
    if (!textOpen.has(x.id)) return null;
    const t = shownTr(x);
    if (t) return t.text;
    return fullCache.has(x.id) ? fullCache.get(x.id) : null;
  };
  const needsFull = (x) => {
    const t = shownTr(x);
    const p = String(t ? t.text : (x.preview || ''));
    return opensInReader(x) || p.endsWith('…') || p.length > 140 || p.split('\n').length > 3;
  };
  function fullToggle(x) {
    // articles are long: they open in the reader instead of growing the card
    if (opensInReader(x)) {
      return h('button', { type: 'button', class: 'tbtn', 'aria-haspopup': 'dialog', 'data-fkey': `full:${x.id}`, onclick: () => openReader(x) },
        icon('note', 'sm'), x.kind === 'article' ? 'Read article' : 'Read full text');
    }
    const open = fullText(x) !== null;
    if (!open && !needsFull(x)) return null;
    const btn = h('button', { type: 'button', class: 'tbtn', 'aria-expanded': String(open), 'data-fkey': `full:${x.id}`, onclick: async () => {
      btn.disabled = true;
      await openInVault(x);
      btn.disabled = false;
    } }, open ? 'Show less' : 'Show full text', icon(open ? 'chevup' : 'chevdown', 'sm'));
    return btn;
  }

  async function loadFull(x) {
    if (!fullCache.has(x.id)) {
      const r = await api('GET', `/api/items/${x.id}`);
      const body = x.kind === 'article' ? r.item.article_md : isWebArticle(x) ? r.item.link_md : x.video ? videoText(r.item) : r.item.text;
      fullCache.set(x.id, String(body || r.item.preview || ''));
    }
    return fullCache.get(x.id);
  }

  // A video in the reader: channel and length, then the transcript (or a line saying there is none yet).
  // The chapters are in the copied text.
  function videoText(item) {
    const v = item.video || {};
    const head = [v.channel, v.duration].filter(Boolean).join(' · ');
    const tr = item.link_md && item.link_md.trim() ? item.link_md.trim() : 'No transcript yet.';
    return [head, tr].filter(Boolean).join('\n\n');
  }

  // a read YouTube video on its card: channel, length, and whether the transcript is saved
  function videoLine(x) {
    const v = x.video;
    if (!v) return null;
    const bits = [v.channel, v.duration, v.chapters ? plural(v.chapters, 'chapter', 'chapters') : null,
      v.transcript === 'ok' ? 'Transcript' : 'No transcript yet'].filter(Boolean);
    return h('p', { class: 'vline' }, icon('play', 'sm'), h('span', { text: bits.join(' · ') }));
  }

  // Reader: the whole article (or post) in a wide window inside the vault, without leaving for X.
  async function openReader(x) {
    let text;
    const t = shownTr(x);
    let title;
    if (t) {
      // English: an article's translation starts with its translated title
      const [tt, rest] = trSplit(x, t.text);
      title = x.kind === 'article' ? tt : (tt || kindName(x));
      text = x.kind === 'article' ? rest : t.text;
    } else {
      try { text = await loadFull(x); } catch (e) { toast(e.message, true); return; }
      title = x.kind === 'article' ? (x.title || 'Article') : isWebArticle(x) ? linkTitle(x) : x.video ? (x.video.title || 'Video') : (splitTitle({ ...x, preview: text })[0] || kindName(x));
    }
    const href = safeHref(x.url);
    await dialogBox((box, finish, id) => {
      box.append(
        h('div', { class: 'rhead' },
          h('div', {}, itemMeta(x), trChip(x), h('h2', { id: `${id}-t`, text: title })),
          h('button', { type: 'button', class: 'ibtn', 'aria-label': 'Close', title: 'Close', onclick: () => finish(null) }, icon('x'))),
        h('div', { class: 'rbody', tabindex: 0, 'aria-label': 'Full text' }, text),
        h('div', { class: 'btnrow' },
          href ? h('a', { class: 'btn', href, target: '_blank', rel: 'noopener noreferrer' }, 'Open source', icon('ext', 'sm')) : null,
          h('button', { type: 'button', class: 'btn', onclick: () => copyText(text, 'text') }, icon('copy', 'sm'), 'Copy text'),
          h('button', { type: 'button', class: 'btn primary', text: 'Close', autofocus: true, onclick: () => finish(null) })));
    }, { cls: 'reader' });
  }

  // a title opens the item inside the vault: articles in the reader, posts and notes expand in place
  async function openInVault(x) {
    if (x.voice_id) return go({ tab: 'voice', voiceId: x.voice_id });
    if (opensInReader(x)) return openReader(x);
    if (fullText(x) !== null) { textOpen.delete(x.id); renderInbox(true); return; }
    if (!shownTr(x)) { try { await loadFull(x); } catch (e) { toast(e.message, true); return; } }
    textOpen.add(x.id);
    renderInbox(true);
  }

  // start a merge from any card: turns on selection with this item already ticked
  function selectToMerge(x) {
    state.selecting = true;
    state.selected.add(x.id);
    renderInbox(true);
    const cb = document.querySelector(`[data-fkey="pick:${x.id}"]`);
    if (cb) { cb.focus(); cb.closest('.card').scrollIntoView({ block: 'nearest' }); }
    toast('Selected. Tick more items, then press Merge.');
  }

  // ---- "Get full thread": the server fetches the author's whole thread in the background and saves
  // every part. The page polls the job, then says how many parts are new and, when the post is in a
  // merge, offers to add them to it.
  const threadJobs = new Map();   // item id -> {x, before: Set of part ids, merge: {slug, title} | null, where, until}
  const canGetThread = (x) => !!(x && (x.kind === 'tweet' || x.kind === 'article') && x.tweet_id
    && (x.fetch_status === 'ok' || x.fetch_status === 'oembed'));
  const threadBusy = (x) => threadJobs.has(x.id) || x.thread_status === 'queued';
  const threadChip = (x) => (threadBusy(x) ? h('span', { class: 'chip wait', role: 'status', text: 'Fetching the thread…' }) : null);
  // the menu entry; merge is the merge the new parts can go into, if any
  const threadMenuItem = (x, merge) => {
    if (!canGetThread(x)) return null;
    if (threadBusy(x)) return { hint: 'Fetching the thread…' };
    return { label: 'Get full thread', icon: 'down', tone: 'blue', onClick: () => getFullThread(x, merge) };
  };
  // a job started in the merge editor belongs to that merge; one started in a list, to that list
  const threadView = () => (state.merge ? { slug: state.merge.slug } : { tab: state.tab });
  const sameThreadView = (w) => (w.slug ? !!(state.merge && state.merge.slug === w.slug) : listShowing() && state.tab === w.tab);
  // the merge editor's redraw waits for a note being typed or an open menu by itself; the list's does too
  function repaintThread(w) {
    if (!sameThreadView(w)) return;
    if (w.slug) { if (state.merge.redrawSources) state.merge.redrawSources(); return; }
    const v = inboxView();
    if (menuIn(v.list, v.tools) || noteEditing(v.list)) v.dirty = true; else renderInbox(true);
  }
  // every copy of an item the page holds: the job's own object may be older than the list or merge on screen
  function itemCopies(st, id) {
    const out = [];
    for (const g of st.groups || []) for (const x of [g.root, ...g.thread, ...g.replies]) if (x && x.id === id) out.push(x);
    if (st.merge) for (const g of st.merge.groups) for (const x of [...g.fixed, ...g.replies]) if (x && x.id === id) out.push(x);
    return out;
  }
  function setThreadStatus(x, status) {
    x.thread_status = status;
    for (const y of itemCopies(state, x.id)) y.thread_status = status;
  }
  // sources the server says are being fetched that no job on this page is watching (started in
  // another view or tab, or before the collection was reopened)
  const untrackedThreads = (items, jobs) => items.filter((x) => x && x.thread_status === 'queued' && !jobs.has(x.id));
  // watch them too, so "Fetching the thread…" clears (and the new parts can be added) when they finish
  async function watchThreads(items, merge) {
    if (!merge || !merge.slug) return;
    const where = { slug: merge.slug };
    for (const x of untrackedThreads(items, threadJobs)) {
      if (!sameThreadView(where)) return;
      let r;
      try { r = await api('GET', `/api/items/${x.id}/thread`); } catch { continue; }
      if (threadJobs.has(x.id) || !sameThreadView(where)) continue;
      if (r.status !== 'queued') { setThreadStatus(x, r.status); repaintThread(where); continue; }
      // a fetch waiting out a rate limit can take a few minutes; this one says nothing unless it brings parts
      threadJobs.set(x.id, { x, before: new Set(r.part_ids), merge, where, until: Date.now() + 300_000, quiet: true });
      pollThread(x.id);
    }
  }

  async function getFullThread(x, merge) {
    if (threadJobs.has(x.id)) return;
    let before;
    try {
      before = new Set((await api('GET', `/api/items/${x.id}/thread`)).part_ids);
      await api('POST', `/api/items/${x.id}/thread`, {});
    } catch (e) { toast(e.message, true); return; }
    const where = threadView();
    threadJobs.set(x.id, { x, before, merge: merge && merge.slug ? merge : null, where, until: Date.now() + 60_000 });
    toast('Fetching the thread…');
    repaintThread(where);
    pollThread(x.id);
  }

  // status: what the server says now, so the card stops showing "Fetching…" before the next reload
  function endThread(id, status) {
    const job = threadJobs.get(id);
    threadJobs.delete(id);
    if (!job) return;
    if (status !== undefined) setThreadStatus(job.x, status);
    repaintThread(job.where);
  }

  // every 2 seconds, for at most a minute, and only while the view the job was started from is showing
  function pollThread(id) {
    setTimeout(async () => {
      const job = threadJobs.get(id);
      if (!job) return;
      if (!sameThreadView(job.where) || !signedIn()) { threadJobs.delete(id); return; }
      let r = null;
      try { r = await api('GET', `/api/items/${id}/thread`); } catch (e) {
        if (e.status === 404 || e.status === 401) { endThread(id); return; }
        // a network blip: try again on the next tick
      }
      if (threadJobs.get(id) !== job) return;
      if (r && r.status === 'done') { threadDone(id, job, r); return; }
      if (r && r.status === 'failed') { endThread(id, 'failed'); toast(r.error || 'Could not get the thread', true); return; }
      if (r && r.status !== 'queued') { endThread(id, r.status); return; }
      if (Date.now() > job.until) { endThread(id); if (!job.quiet) toast('The thread is taking a while. It will show up in your Inbox when it is ready.'); return; }
      pollThread(id);
    }, 2000);
  }

  async function threadDone(id, job, r) {
    threadJobs.delete(id);
    setThreadStatus(job.x, 'done');
    const fresh = (r.part_ids || []).filter((pid) => !job.before.has(pid));
    // r.error on a finished job is a note, such as the 100-part limit
    const msg = `${fresh.length ? `Added ${plural(fresh.length, 'part')}` : 'No new parts. You already have the whole thread.'}${r.error ? ` ${r.error}` : ''}`;
    const m = job.merge;
    const action = m && fresh.length
      ? { label: `Add the new parts to “${String(m.title || 'the merge').slice(0, 30)}”`, fn: () => addToMerged(m.slug, fresh) }
      : null;
    if (job.where.slug) repaintThread(job.where);
    else if (sameThreadView(job.where)) await loadInbox().catch(() => {});
    if (!job.quiet || fresh.length) toast(msg, false, action);
  }

  // ---------- "My note": your own words on why you saved something ----------
  // Stored in items.my_note, which is not the internal `note` the server keeps for short links.
  // The box opens under the item and saves itself after a pause, like a collection's title;
  // Escape or leaving the box closes it. The note only ever reaches the page as textContent.
  const MY_NOTE_MAX = 2000;
  const noteOpen = new Set();    // ids whose note box is open
  const noteState = new Map();   // id -> {draft, saved, timer, chain, status, failed, error, setStatus}
  // Leaving the box by clicking elsewhere closes it, but only after that click lands: redrawing
  // during the press would pull the clicked button out from under the pointer.
  let pointerHeld = false;
  let afterPointer = [];
  const pointerDone = () => {
    pointerHeld = false;
    const run = afterPointer;
    afterPointer = [];
    if (run.length) setTimeout(() => run.forEach((f) => f()), 0);
  };
  document.addEventListener('pointerdown', () => { pointerHeld = true; }, true);
  document.addEventListener('pointerup', pointerDone, true);
  document.addEventListener('pointercancel', pointerDone, true);
  // closing the tab or reloading within the save delay: send the last typing anyway
  window.addEventListener('pagehide', () => {
    for (const [id, ns] of noteState) {
      if (ns.draft.trim() === ns.saved) continue;
      try {
        fetch(`/api/items/${id}`, {
          method: 'PATCH', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ my_note: ns.draft.trim() }),
        });
      } catch { /* best effort */ }
    }
  });

  // the note under an item's text (null when there is none, or while it is being edited)
  const myNoteView = (x) => (x.my_note && !noteOpen.has(x.id)
    ? h('div', { class: 'mynote' }, h('span', { class: 'mynote-l', text: 'My note' }), h('p', { class: 'mynote-t', text: x.my_note }))
    : null);
  // only saved items take a note (the server turns the rest away), so unsaved context posts don't offer one
  const noteMenuItem = (x, open) => (x && x.saved
    ? { label: x.my_note ? 'Edit my note' : 'Add a note', icon: 'pencil', keepFocus: true, onClick: open }
    : null);
  function focusNote(id) {
    const ta = document.querySelector(`[data-fkey="note:${id}"]`);
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  // onSaved(note) puts a note into the page's copy of the item: after each save, and as the box closes;
  // onClose(refocus) runs after the box closes (the caller redraws); repaint() when a closed box's
  // note changed after all (the save failed, or the server stored something else)
  function noteBox(x, { onSaved, onClose, repaint }) {
    let ns = noteState.get(x.id);
    if (!ns) {
      ns = { draft: x.my_note || '', saved: x.my_note || '', timer: null, chain: Promise.resolve(), status: '', failed: false, error: '' };
      noteState.set(x.id, ns);
    }
    const id = `mynote-${x.id}`;
    const status = h('span', { class: 'chip save-state', id: `${id}-s`, role: 'status' });
    ns.setStatus = (st) => {
      ns.status = st || '';
      status.textContent = ns.status;
      status.hidden = !ns.status;
      status.className = `chip save-state ${st === 'Saved' ? 'ok' : st === 'Saving…' ? 'saving' : 'bad'}`;
    };
    ns.setStatus(ns.status);
    const ta = h('textarea', { id, class: 'mynote-in', rows: 3, maxlength: MY_NOTE_MAX, value: ns.draft, 'data-fkey': `note:${x.id}`,
      placeholder: 'Why did you save this?', 'aria-describedby': `${id}-h ${id}-s` });
    const save = () => {
      clearTimeout(ns.timer);
      ns.timer = null;
      const val = ns.draft.trim();
      // typing back to a value that is already on its way (or saved) needs no new save
      const last = ns.sending !== undefined ? ns.sending : ns.saved;
      if (val === last && !ns.failed) return ns.chain;
      ns.sending = val;
      ns.setStatus('Saving…');
      ns.chain = ns.chain.catch(() => {}).then(async () => {
        try {
          const r = await api('PATCH', `/api/items/${x.id}`, { my_note: val });
          if (ns.sending === val) ns.sending = undefined;
          ns.saved = r.my_note || '';
          ns.failed = false;
          // newer typing gets its own save; until then don't claim it is saved
          if (ns.draft.trim() === ns.saved) ns.setStatus('Saved');
          onSaved(r.my_note || null);
        } catch (e) {
          if (ns.sending === val) ns.sending = undefined;
          ns.failed = true;
          ns.error = e.status === 400 ? e.message : 'Not saved, check your connection';
          ns.setStatus(ns.error);
        }
      });
      return ns.chain;
    };
    let closed = false;
    const close = (refocus) => {
      if (closed || !noteOpen.has(x.id)) return;
      closed = true;
      noteOpen.delete(x.id);
      // the closed box shows what was typed at once, not the note from before; the save has the last word
      const typed = ns.draft.trim() || null;
      if ((x.my_note || null) !== typed) onSaved(typed);
      // a note that didn't save stays as a draft for next time, and says so
      save().then(() => {
        if (ns.failed) toast(`Your note wasn't saved. ${ns.error}`, true);
        else if (!noteOpen.has(x.id)) noteState.delete(x.id);
        const kept = ns.saved || null;
        if (!noteOpen.has(x.id) && kept !== typed) { onSaved(kept); if (repaint) repaint(); }
      });
      onClose(refocus);
    };
    ta.addEventListener('input', () => {
      ns.draft = ta.value;
      clearTimeout(ns.timer);
      ns.timer = setTimeout(save, 600);
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close(true);
    });
    ta.addEventListener('blur', () => {
      // switching to another window or tab keeps the box open
      if (!document.hasFocus()) return;
      // a redraw may have rebuilt the box in the meantime: what counts is whether its current one has focus
      const later = () => {
        const cur = document.querySelector(`[data-fkey="note:${x.id}"]`);
        if (!cur || document.activeElement !== cur) close(false);
      };
      if (pointerHeld) afterPointer.push(later);
      else setTimeout(later, 0);   // let focus settle on wherever Tab went
    });
    return h('div', { class: 'mynote edit' },
      h('label', { for: id, class: 'mynote-l', text: 'My note' }),
      ta,
      h('div', { class: 'mynote-foot' },
        h('span', { id: `${id}-h`, class: 'dhint', text: 'Saves by itself. Press Escape when you are done.' }),
        status));
  }

  // Inbox, Archived and Trash: patch the note into the list the page holds, so a redraw shows it at once
  function setNoteLocally(id, note) {
    for (const g of state.groups) {
      for (const x of [g.root, ...g.thread, ...g.replies]) if (x && x.id === id) x.my_note = note;
    }
  }
  function openListNote(x) {
    noteOpen.add(x.id);
    renderInbox(true);
    focusNote(x.id);
  }
  const listNote = (x) => (noteOpen.has(x.id)
    ? noteBox(x, {
      onSaved: (note) => { x.my_note = note; setNoteLocally(x.id, note); },
      onClose: (refocus) => {
        if (!listShowing()) return;
        // the click that closed the box may have just opened a menu: don't draw over it, it repaints as it closes
        const v = inboxView();
        if (menuIn(v.list, v.tools)) v.dirty = true; else renderInbox(true);
        // Escape goes back to the item's menu button; so does Tab when focus had nowhere to land
        const lost = !document.activeElement || document.activeElement === document.body;
        if (refocus || lost) { const b = document.querySelector(`[data-fkey="more:${x.id}"]`); if (b) b.focus(); }
      },
      repaint: () => { if (listShowing()) renderInbox(); },
    })
    : myNoteView(x));
  const noteEditing = (root) => {
    const a = document.activeElement;
    return !!(a && a.classList && a.classList.contains('mynote-in') && root.contains(a));
  };

  function itemMenu(x, title) {
    const picked = state.selecting && state.selected.has(x.id);
    const items = [
      canPick(x) && LIST_TABS[state.tab] && !picked ? { label: 'Select to merge', icon: 'layers', tone: 'blue', onClick: () => selectToMerge(x), keepFocus: true } : null,
      x.voice_id ? { label: 'Open voice note', icon: 'mic', tone: 'blue', onClick: () => go({ tab: 'voice', voiceId: x.voice_id }) } : null,
      { label: x.kind === 'article' ? 'Read article' : 'Read full text', icon: 'note', onClick: () => openReader(x) },
      safeHref(x.url) ? { label: 'Open source', icon: 'ext', onClick: () => window.open(safeHref(x.url), '_blank', 'noopener,noreferrer') } : null,
      canTranslate() && !trOf(x) && !trPending.has(x.id) ? { label: 'Translate to English', icon: 'theme', tone: 'blue', onClick: () => translateItem(x) } : null,
      // English is copied when English is what's on screen
      shownTr(x) ? { label: 'Copy English', icon: 'copy', onClick: () => copyText(shownTr(x).text, 'English text') } : null,
      shownTr(x) ? { label: 'Copy English with sources', icon: 'copy', onClick: () => copyItems([x.id], true, true) } : null,
      { label: shownTr(x) ? 'Copy original' : 'Copy text', icon: 'copy', onClick: () => copyItems([x.id], false) },
      shownTr(x) ? null : { label: 'Copy with sources', icon: 'copy', onClick: () => copyItems([x.id], true) },
      x.own_note ? { label: 'Edit note', icon: 'pencil', tone: 'blue', onClick: async () => {
        const saved = await noteEditor(x);
        if (saved) { forgetTranslation(x.id); toast('Note saved'); loadInbox(); }
      } } : null,
      noteMenuItem(x, () => openListNote(x)),
      canReadLink(x) ? { label: 'Get article text again', icon: 'refresh', onClick: () => readLinkAgain(x) } : null,
      (x.fetch_status === 'failed' || x.fetch_status === 'unavailable' || x.fetch_status === 'oembed') && x.tweet_id
        ? { label: 'Fetch again', icon: 'refresh', onClick: async () => { try { await api('POST', `/api/items/${x.id}/refetch`, {}); forgetTranslation(x.id); toast('Fetching again'); } catch (e) { toast(e.message, true); } loadInbox(); } } : null,
      threadMenuItem(x, x.merged_in && x.merged_in[0]),
      x.saved && x.state !== 'trashed' && state.tab !== 'trashed' && state.bundles.length
        ? { label: 'Add to merged…', icon: 'layers', tone: 'blue', onClick: () => addOneToMerged(x) } : null,
    ];
    if (x.merged_in && x.merged_in.length) items.push({ label: 'Open its collection', icon: 'layers', onClick: () => openBundle(x.merged_in[0].slug) });
    if (!x.context) {
      items.push(state.tab === 'inbox'
        ? { label: 'Archive', icon: 'archive', onClick: () => setItemState(x, 'archived', 'Archived') }
        : { label: 'Move to Inbox', icon: 'undo', onClick: () => setItemState(x, 'inbox', 'Moved to the Inbox') });
      if (state.tab !== 'trashed') items.push({ sep: true }, { label: 'Move to Trash', icon: 'trash', danger: true, onClick: () => setItemState(x, 'trashed', 'Moved to Trash') });
    }
    return moreBtn(title, () => items, { fkey: `more:${x.id}` });
  }

  function itemMeta(x, small) {
    const name = x.author_name || (x.author_handle ? `@${x.author_handle}` : null);
    const dot = () => h('span', { class: 'dot', 'aria-hidden': 'true' });
    const bits = [];
    // notes and links have no author: the type chip says what they are
    if (name) bits.push(h('span', { class: 'who', text: name }));
    if (x.author_name && x.author_handle) bits.push(dot(), h('span', { text: `@${x.author_handle}` }));
    const t = x.posted_at || x.first_saved_at;
    if (t) bits.push(bits.length ? dot() : null, h('span', { title: when(t), text: `${name ? '' : 'Saved '}${ago(t)}` }));
    if (!small) bits.push(bits.length ? dot() : null, kindChip(x));
    if (x.kind === 'article' && x.words) bits.push(dot(), h('span', { text: `${fmtNum(x.words)} words` }));
    if (x.book && x.book.title) {
      // a Kindle highlight: its book (short title before any subtitle; the full one on hover) and authors
      const full = String(x.book.title);
      const short = full.split(/:\s/)[0].slice(0, 80) || full.slice(0, 80);
      const href = safeHref(x.book.url);
      bits.push(dot(), href
        ? h('a', { class: 'who', href, target: '_blank', rel: 'noopener noreferrer', title: `${full} (opens in Kindle)`, text: short })
        : h('span', { class: 'who', title: full, text: short }));
      if (x.book.author) bits.push(dot(), h('span', { text: x.book.author }));
    }
    if (isWebArticle(x)) {
      // site, author and reading length (about 230 words a minute)
      const site = x.link_site || hostOf(x.url);
      if (site) bits.push(dot(), h('span', { class: 'who', text: site }));
      if (x.link_author) bits.push(dot(), h('span', { text: x.link_author }));
      if (x.words) bits.push(dot(), h('span', { title: `${fmtNum(x.words)} words`, text: `${Math.max(1, Math.round(x.words / 230))} min read` }));
    }
    if (x.likes) bits.push(dot(), h('span', { title: 'Likes', text: `♥ ${fmtNum(x.likes)}` }));
    if (x.quote) bits.push(h('span', { class: 'chip', text: 'Quotes a post' }));
    const st = statusChip(x);
    if (st) bits.push(st);
    const tc = threadChip(x);
    if (tc) bits.push(tc);
    if (x.merged_in && x.merged_in.length) {
      bits.push(h('button', { type: 'button', class: 'chip ok', title: 'Already merged. Open the collection', onclick: () => openBundleFromClick(x.merged_in[0].slug) },
        icon('layers'), `In ${x.merged_in[0].title.slice(0, 40)}`));
    } else if (x.context) {
      bits.push(h('span', { class: 'chip ctx', title: 'Shown so the replies make sense', text: x.saved && x.state !== 'inbox' ? (x.state === 'trashed' ? 'In Trash' : x.state === 'archived' ? 'Archived' : x.state) : 'Context' }));
    }
    return h('div', { class: 'meta' }, bits);
  }

  // a checkbox inside a 44px label, so it is easy to hit by touch
  function pickBox(ids, label, { onTick } = {}) {
    if (!state.selecting || !ids.length) return null;
    const on = ids.filter((id) => state.selected.has(id)).length;
    const cb = h('input', { type: 'checkbox', checked: on === ids.length, indeterminate: on > 0 && on < ids.length, 'aria-label': label,
      'data-fkey': `pick:${ids.join(',')}`, onchange: (e) => {
        for (const id of ids) if (e.target.checked) state.selected.add(id); else state.selected.delete(id);
        if (onTick) onTick(e.target.checked);
        renderInbox();
      } });
    return h('label', { class: 'pick' }, cb);
  }

  // Kept images: thumbnails of the vault's own copies under the post's text. A picture not saved yet shows
  // nothing new (its [Image: …] line is still in the text). Only our own /media/<hash>.<ext> addresses are
  // used, and a click opens the full picture in a new tab.
  const MEDIA_PATH = /^\/media\/[0-9a-f]{64}\.(jpg|png|gif|webp)$/;
  function thumbs(x) {
    const seen = new Set();
    const list = (Array.isArray(x.images) ? x.images : [])
      .filter((m) => m && MEDIA_PATH.test(String(m.url || '')) && !seen.has(m.url) && seen.add(m.url)).slice(0, 12);
    if (!list.length) return null;
    return h('div', { class: 'thumbs' }, list.map((m) => h('a', { class: 'thumb', href: m.url, target: '_blank', rel: 'noopener noreferrer', title: 'Open the full image' },
      h('img', { src: m.url, alt: 'Image from the post', loading: 'lazy', decoding: 'async' }))));
  }

  function replyRow(x, depth) {
    const tr = shownTr(x);
    const [t, rest] = tr ? trSplit(x, tr.text) : splitTitle(x);
    const full = fullText(x);
    const text = full !== null ? full : [t, rest].filter(Boolean).join(' ');
    const label = `${x.author_handle ? `@${x.author_handle}` : kindName(x)}: ${text.slice(0, 60)}`;
    const more = fullToggle(x);
    const trc = trControl(x);
    const acts = [trc, more].filter(Boolean);
    return h('li', { class: `reply${x.context ? ' ctx' : ''}`, 'data-depth': depth ? Math.min(depth, 6) : null },
      h('div', { class: 'rpick' }, canPick(x) ? pickBox([x.id], `Select ${label}`) : null, avatarFor(x)),
      h('div', { class: 'bodycol' }, itemMeta(x, true), trChip(x), h('p', { class: `excerpt${full !== null ? '' : ' clamp4'}`, text: text || ' ' }),
        thumbs(x),
        acts.length ? h('div', { class: 'cacts' }, acts) : null,
        x.quote ? h('blockquote', { class: 'quote clamp2', text: `@${x.quote.handle || '?'}: ${x.quote.text}` }) : null,
        x.note ? h('p', { class: 'inote', text: x.note }) : null,
        listNote(x),
        metaLine(x, { onRemoveTag: x.context ? null : (tg) => removeItemTag(x.id, tg) })),
      itemMenu(x, label));
  }

  // a failed request (network, server restart) shows a message instead of doing nothing
  async function removeItemTag(id, tag) {
    try { await api('PATCH', `/api/items/${id}`, { remove_tags: [tag] }); } catch (e) { toast(e.message, true); }
    loadInbox().catch(() => {});
  }

  // a collapsed card says when posts hidden inside it carry your notes
  function notesInside(open, rest) {
    const n = open ? 0 : rest.filter((r) => r.x.my_note).length;
    return n ? h('span', { class: 'chip mynote-mark', title: 'Open the conversation to read them' }, icon('note'), `${n} ${n === 1 ? 'note' : 'notes'}`) : null;
  }

  function conversationCard(g) {
    const main = g.root || g.thread[0] || g.replies[0];
    const rest = [...(g.root ? g.thread : g.thread.slice(1)).map((t) => ({ x: t, depth: 0 })),
      ...g.replies.filter((r) => r !== main).map((r) => ({ x: r, depth: r.depth }))];
    const ids = allIds(g);
    const anySel = ids.some((id) => state.selected.has(id));
    const full = fullText(main);
    const tr = shownTr(main);
    // English first when there is a translation; the full text (in either language) when it's opened
    const [title, excerpt] = tr ? trSplit(main, tr.text)
      : full === null ? splitTitle(main)
        : main.kind === 'article' ? [main.title || 'Article', full] : splitTitle({ ...main, preview: full });
    const name = title || excerpt.slice(0, 60) || kindName(main);
    const href = safeHref(main.url);
    const open = state.expanded.has(g.key) || (!g.root && rest.length > 0);
    const newOnes = [g.root, ...g.thread, ...g.replies].filter((x) => x && !x.context);
    // the conversation is already merged somewhere: one click adds the new saves to it
    const home = [g.root, ...g.thread, ...g.replies].find((x) => x && x.merged_in && x.merged_in.length);
    const addHome = home && newOnes.length
      ? h('button', { type: 'button', class: 'btn compact', onclick: () => addToMerged(home.merged_in[0].slug, newOnes.map((x) => x.id)) },
        icon('layers', 'sm'), `Add ${newOnes.length} to “${home.merged_in[0].title.slice(0, 30)}”`)
      : null;
    const threadN = g.root ? g.thread.length : Math.max(0, g.thread.length - 1);
    const replyN = rest.length - threadN;
    const discLabel = threadN && replyN ? `${rest.length} more` : threadN ? `${threadN} more in thread` : plural(replyN, 'reply', 'replies');
    const listId = `rl-${String(g.key).replace(/[^\w-]/g, '_')}`;
    const disc = rest.length && g.root ? h('button', { type: 'button', class: 'tbtn', 'aria-expanded': String(open), 'aria-controls': open ? listId : null, 'data-fkey': `disc:${g.key}`,
      onclick: () => { if (state.expanded.has(g.key)) state.expanded.delete(g.key); else state.expanded.add(g.key); renderInbox(true); } },
    discLabel, icon(open ? 'chevup' : 'chevdown', 'sm')) : null;
    // the card's own box picks just this post; "Select all N" picks the whole conversation and shows it
    const restIds = rest.map((r) => r.x).filter(canPick).map((x) => x.id);
    const selConv = state.selecting && restIds.length && canPick(main)
      ? h('span', { class: 'selconv' }, pickBox(ids, `Select all ${ids.length} in this conversation`, { onTick: (on) => { if (on) state.expanded.add(g.key); } }), `Select all ${ids.length}`)
      : null;

    const more = fullToggle(main);
    const trc = trControl(main);
    const acts = [trc, trc && more ? h('span', { class: 'bar', 'aria-hidden': 'true' }) : null,
      more, more && (disc || href) ? h('span', { class: 'bar', 'aria-hidden': 'true' }) : null,
      disc, notesInside(open, rest), disc && href ? h('span', { class: 'bar', 'aria-hidden': 'true' }) : null,
      href ? h('a', { class: 'tbtn', href, target: '_blank', rel: 'noopener noreferrer' }, 'Open source', icon('ext', 'sm')) : null,
      addHome, selConv].filter(Boolean);

    return h('article', { class: `card ccard${anySel ? ' sel' : ''}${main.context ? ' ctxonly' : ''}`, 'aria-label': name },
      h('div', { class: 'pickcol' }, canPick(main) ? pickBox([main.id], `Select ${name}`) : (g.root ? null : pickBox(ids, `Select ${name}`)), avatarFor(main)),
      h('div', { class: 'bodycol' },
        itemMeta(main),
        trChip(main),
        // the title opens the item here in the vault; "Open source" is the way out to X
        title ? h('h3', { class: 'ititle' }, opensInReader(main) || needsFull(main) || full !== null
          ? h('button', { type: 'button', class: 'tlink', title: opensInReader(main) ? 'Read the article' : (full !== null ? 'Show less' : 'Show the full text'),
            'aria-expanded': opensInReader(main) ? null : String(full !== null), onclick: () => openInVault(main) }, title)
          : title) : null,
        excerpt ? h('p', { class: `excerpt${full !== null ? ' full' : title ? ' clamp2' : ' clamp4'}`, text: excerpt }) : null,
        thumbs(main),
        videoLine(main),
        main.quote ? h('blockquote', { class: 'quote clamp2', text: `@${main.quote.handle || '?'}: ${main.quote.text}` }) : null,
        main.note ? h('p', { class: 'inote', text: main.note }) : null,
        listNote(main),
        metaLine(main, { onRemoveTag: main.context ? null : (t) => removeItemTag(main.id, t) }),
        acts.length ? h('div', { class: 'cacts' }, acts) : null,
        open && rest.length ? h('ol', { class: 'replies', id: listId, 'aria-label': discLabel }, rest.map(({ x, depth }) => replyRow(x, depth))) : null),
      h('div', { class: 'morecol' }, itemMenu(main, name)));
  }

  // The page parts (capture box, toolbars) are built once per visit so refreshes never wipe what you type.
  function inboxView() {
    const v = state.view;
    if (v && v.kind === 'list' && v.tab === state.tab && document.body.contains(v.list)) return v;
    const main = shell();
    const head = pageHead(tabTitle(), '');
    main.append(head.el);
    let cap = null;
    if (state.tab === 'trashed') main.append(h('p', { class: 'notice' }, icon('trash'), 'Items in Trash are deleted for good 30 days after you trash them. Move one to the Inbox to keep it.'));
    if (state.tab === 'inbox' && !scoped()) { cap = captureBox(); main.append(cap.el); }
    const tools = h('div');
    const panel = h('div');
    const list = h('div', { class: 'cards' });
    // one lasting live region, so selection changes are announced
    const live = h('div', { class: 'sr', role: 'status', 'aria-live': 'polite' });
    main.append(tools, panel, list, live);
    state.view = { kind: 'list', tab: state.tab, list, tools, panel, head, cap, live };
    return state.view;
  }

  function drawTools(v) {
    clear(v.tools);
    clear(v.panel);
    const every = state.groups.flatMap(allIds);
    if (state.selecting) {
      const n = state.selected.size;
      const allOn = every.length > 0 && every.every((id) => state.selected.has(id));
      const selAll = h('input', { type: 'checkbox', checked: allOn, indeterminate: !allOn && n > 0, 'aria-label': allOn ? 'Select none' : 'Select all', 'data-fkey': 'selall', onchange: (e) => {
        for (const id of every) if (e.target.checked) state.selected.add(id); else state.selected.delete(id);
        renderInbox(true);
      } });
      const bulk = async (body, msg) => {
        try {
          await api('POST', '/api/items/bulk', { ids: [...state.selected], ...body });
          toast(msg);
          loadInbox();
        } catch (x) { toast(x.message, true); }
      };
      const moveAll = async (to) => {
        const ids = [...state.selected];
        const from = state.tab;
        try {
          await api('POST', '/api/items/bulk', { ids, state: to });
          state.selected.clear();
          const msg = to === 'archived' ? `Archived ${ids.length}` : to === 'trashed' ? `Moved ${ids.length} to Trash` : `Moved ${ids.length} to the Inbox`;
          toast(msg, false, { label: 'Undo', fn: async () => { try { await api('POST', '/api/items/bulk', { ids, state: from }); } finally { route(); } } });
        } catch (x) { toast(x.message, true); }
        loadInbox();
      };
      const organize = menuButton(h('button', { type: 'button', class: 'btn compact', disabled: !n, 'data-fkey': 'organize' }, 'Organize', icon('chevdown', 'sm')), () => [
        { label: 'Category', icon: 'tag', tone: 'teal', sub: [
          ...catTree().map((c) => ({ label: c.path, onClick: () => bulk({ category_id: c.id }, `Moved to ${c.name}`) })),
          { label: 'No category', onClick: () => bulk({ category_id: null }, 'Category removed') },
          { label: '+ New category…', onClick: async () => {
            const name = await askText({ title: 'New category', label: 'Name', ok: 'Add category' });
            if (!name) return;
            try { const r = await api('POST', '/api/categories', { name }); await refreshSidebar(); bulk({ category_id: r.id }, `Moved to ${name}`); } catch (x) { toast(x.message, true); }
          } },
        ] },
        { label: 'Priority', icon: 'star', tone: 'gold', sub: [3, 2, 1, 0].map((p) => ({ label: p ? `${PRIORITY[p]} priority` : 'No priority', onClick: () => bulk({ priority: p }, p ? `Priority set to ${PRIORITY[p]}` : 'Priority cleared') })) },
        { label: 'Add tags', icon: 'tagplus', tone: 'blue', onClick: async () => { const t = await askTags(); if (t) bulk({ add_tags: t }, `Tagged ${t.map((x) => `#${x}`).join(' ')}`); } },
        state.tab === 'inbox' ? { label: 'Archive', icon: 'archive', tone: 'ink', onClick: () => moveAll('archived') } : { label: 'Move to Inbox', icon: 'undo', tone: 'ink', onClick: () => moveAll('inbox') },
        state.tab !== 'trashed' ? { sep: true } : null,
        state.tab !== 'trashed' ? { label: 'Move to Trash', icon: 'trash', danger: true, onClick: () => moveAll('trashed') } : null,
      ]);
      v.tools.append(h('div', { class: 'selbar', role: 'toolbar', 'aria-label': 'Selected items' },
        h('label', { class: 'pick' }, selAll), h('span', { text: `${n} selected` }), h('span', { class: 'sep', 'aria-hidden': 'true' }),
        h('button', { type: 'button', class: 'tbtn', text: 'Cancel', 'data-fkey': 'selitems', onclick: () => { state.selected.clear(); state.selecting = false; renderInbox(true); } }),
        h('span', { class: 'grow' }),
        organize,
        n && state.bundles.length ? h('button', { type: 'button', class: 'btn compact', 'data-fkey': 'addmerged', onclick: () => addSelectedToMerged() }, icon('layers', 'sm'), 'Add to merged…') : null,
        h('button', { type: 'button', class: 'btn primary compact', disabled: !n, 'data-fkey': 'merge', text: n ? `Merge ${plural(n, 'item')}` : 'Merge items', onclick: () => startMerge() })));
      if (v.cap) v.cap.btn.classList.remove('primary');
      v.panel.append(filtersPanel());
      return;
    }
    if (v.cap) v.cap.btn.classList.add('primary');
    const countText = plural(state.groups.length, 'conversation');
    const selBtn = every.length ? h('button', { type: 'button', class: 'tbtn', text: 'Select items', 'data-fkey': 'selitems', onclick: () => { state.selecting = true; renderInbox(true); } }) : null;
    const sort = sortSelect(SORTS, state.sort, (val) => { state.sort = val; go({}); });
    if (scoped()) {
      v.tools.append(h('div', { class: `fbar${state.filter.priority === 3 && state.filter.category === null ? ' prio' : ''}` },
        h('span', { class: 'flabel', text: 'Showing' }), scopeSelect(), ...appliedChips(), h('span', { class: 'grow' }), selBtn, filtersToggle(), sort));
    } else {
      const chips = appliedChips();
      v.tools.append(h('div', { class: 'ltool' },
        state.tab === 'inbox' ? h('h2', { text: 'Your saves' }) : null, state.tab === 'inbox' ? h('span', { class: 'scount', text: countText }) : null,
        ...chips, h('span', { class: 'grow' }), selBtn, filtersToggle(), sort));
    }
    v.panel.append(filtersPanel());
  }

  function drawList(v) {
    const list = clear(v.list);
    const n = state.groups.length;
    const filtered = anyFilter();
    if (!n) {
      const msg = state.q ? { ic: 'search', tone: '', title: 'Nothing matches that search.', text: 'Try fewer words, an @handle, or clear the search.' }
        : filtered ? { ic: 'filter', tone: '', title: 'Nothing here matches these filters.', text: 'Clear the filters to see everything in this list.' }
          : { inbox: { ic: 'inbox', tone: 'teal', title: 'Your inbox is empty.', text: 'Save from your phone (Share → Vault, or highlight text → Save to Vault), or paste a link above.' },
            archived: { ic: 'archive', tone: 'teal', title: 'Nothing archived.', text: 'Archive keeps items out of the Inbox without deleting them.', start: true },
            trashed: { ic: 'trash', tone: 'burgundy', title: 'Trash is empty.', text: 'Deleted items appear here. Move them back to the Inbox before they expire.' } }[state.tab];
      list.append(emptyCard({ ...msg, links: [
        filtered ? { label: 'Clear filters', onClick: () => setFilter({ category: null, tag: null, priority: 0 }) } : null,
        state.q ? { label: 'Clear search', onClick: () => { state.q = ''; state.shell.search.value = ''; loadInbox(); } } : null,
        state.tab !== 'inbox' && !filtered && !state.q ? { label: 'Go to Inbox', onClick: () => openView('inbox') } : null,
        state.tab === 'inbox' && scoped() ? { label: 'Browse merged', onClick: () => go({ tab: 'bundles' }) } : null,
      ] }));
      return;
    }
    for (const g of state.groups) list.append(conversationCard(g));
    setTimeout(autoTranslate, 0);
  }

  // Repaints only what changed: the toolbar and the list have separate signatures, so a background
  // poll never rebuilds an open dropdown, and keyboard focus is put back on the same control.
  function renderInbox(force) {
    const v = inboxView();
    // don't repaint under an open menu; catch up when it closes
    if (!force && menuIn(v.list, v.tools)) { v.dirty = true; return; }
    // nor under a note being typed (closing the box repaints)
    if (!force && noteEditing(v.list)) { v.dirty = true; return; }
    v.dirty = false;
    const key = focusKey();
    const n = state.groups.length;
    v.head.count.textContent = plural(n, state.tab === 'inbox' ? 'conversation' : 'item');
    const sel = [...state.selected].sort((a, b) => a - b);
    const toolSig = JSON.stringify([sel, state.selecting, state.tab, state.filter, state.sort, state.groups.flatMap(allIds), n,
      state.org.categories, state.org.tags, state.bundles.map((b) => [b.slug, b.title, b.items])]);
    const listSig = JSON.stringify([state.groups, sel, state.selecting, [...state.expanded], state.org.categories,
      [...trCache.keys()], [...trPending], [...showOrig], [...trFailed.keys()], [...textOpen]]);
    const ae = document.activeElement;
    const choosing = ae && ae.tagName === 'SELECT' && (v.tools.contains(ae) || v.panel.contains(ae));
    if (force || (v.toolSig !== toolSig && !choosing)) { v.toolSig = toolSig; drawTools(v); }
    if (force || v.listSig !== listSig) { v.listSig = listSig; drawList(v); }
    const said = state.selecting ? `${plural(state.selected.size, 'item')} selected` : '';
    if (v.live.textContent !== said) v.live.textContent = said;
    restoreFocus(key);
  }

  async function addToMerged(slug, ids) {
    try {
      const r = await api('POST', `/api/bundles/${encodeURIComponent(slug)}/add`, { item_ids: ids });
      state.selected.clear();
      state.selecting = false;
      toast(r.added ? `Added ${r.added} to the collection` : 'Those were already in it');
      await openBundle(slug);
    } catch (x) { toast(x.message, true); }
  }

  // ---------- adding to merged items without unmerging ----------
  // Two pickers. One chooses saved items to add to a merge (it searches everything saved and not in
  // Trash, even items already in another merge). The other chooses a merge, for "Add to merged…" and
  // "Combine into…". Both are dialogs built with dialogBox, so focus goes back where it was.
  // one plain line per item: a title when there is one (articles, read web pages, videos), else the text
  const pickLine = (x) => (x.kind === 'article' ? (x.title || 'Article')
    : isWebArticle(x) ? linkTitle(x)
    : x.video && x.video.title ? x.video.title
    : (x.preview || '').replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').slice(0, 160)) || kindName(x);
  const pickWho = (x) => x.author_name || (x.author_handle ? `@${x.author_handle}` : null);

  // a conversation reads in order in the picker too: the post, its thread, then the replies under it
  function pickGroups(items) {
    const groups = new Map();
    for (const x of items) {
      if (!groups.has(x.group_key)) groups.set(x.group_key, []);
      groups.get(x.group_key).push(x);
    }
    const rank = (x) => (x.tweet_id === x.group_key || x.kind === 'text' || x.kind === 'link' ? 0 : x.is_self_thread ? 1 : 2);
    return [...groups.values()].map((list) => list.slice().sort((a, b) => rank(a) - rank(b) || (a.posted_at || 0) - (b.posted_at || 0)));
  }

  function pickItemsDialog(m) {
    return dialogBox((body, finish, id) => {
      const chosen = new Set();
      const input = h('input', { type: 'search', id: `${id}-q`, autocomplete: 'off', placeholder: 'Words, @handle or link', autofocus: true, 'aria-controls': `${id}-list` });
      const status = h('p', { class: 'pstatus small', role: 'status', text: 'Loading…' });
      const list = h('div', { class: 'plist', id: `${id}-list`, role: 'group', 'aria-label': 'Saved items' });
      const addBtn = h('button', { type: 'submit', class: 'btn primary', disabled: true, text: 'Add items' });
      const sync = () => { const n = chosen.size; addBtn.disabled = !n; addBtn.textContent = n ? `Add ${plural(n, 'item')}` : 'Add items'; };
      // nested: shown under its post; shown: ids in the list (a reply whose parent is listed doesn't repeat it)
      const row = (x, nested, shown) => {
        const cb = h('input', { type: 'checkbox', id: `${id}-i${x.id}`, 'aria-labelledby': `${id}-l${x.id}`, checked: chosen.has(x.id), onchange: (e) => {
          if (e.target.checked) chosen.add(x.id); else chosen.delete(x.id);
          sync();
        } });
        const t = x.posted_at || x.first_saved_at;
        const ins = x.merged_in || [];
        const who = pickWho(x);
        const parentWho = x.reply_to && (x.reply_to.author_handle ? `@${x.reply_to.author_handle}` : x.reply_to.author_name);
        return h('label', { class: `prow${nested ? ' rep' : ''}`, for: cb.id }, cb,
          h('span', { class: 'pbody' },
            h('span', { class: 'meta' }, kindChip(x), who ? h('span', { class: 'who', text: who }) : null,
              t ? h('span', { title: when(t), text: ago(t) }) : null,
              x.state === 'archived' ? h('span', { class: 'chip ctx', text: 'Archived' }) : null,
              ins.slice(0, 2).map((b) => h('span', { class: 'chip ok', text: `In ${b.title.slice(0, 40)}` })),
              ins.length > 2 ? h('span', { class: 'chip ok', text: `+${ins.length - 2} more` }) : null),
            h('span', { class: 'pline', id: `${id}-l${x.id}`, text: pickLine(x) }),
            x.reply_to && !shown.has(x.reply_to.id) ? h('span', { class: 'pctx', text: `Reply to ${parentWho || 'a post'}${x.reply_to.preview ? `: ${x.reply_to.preview}` : ''}` }) : null));
      };
      let seq = 0;
      let deb = null;
      const load = async () => {
        clearTimeout(deb);
        const s = ++seq;
        const q = input.value.trim();
        try {
          const r = await api('GET', `/api/items/pick?q=${encodeURIComponent(q)}&exclude=${encodeURIComponent(m.slug)}`);
          if (s !== seq || !body.isConnected) return;
          clear(list);
          const shown = new Set(r.items.map((x) => x.id));
          for (const g of pickGroups(r.items)) {
            g.forEach((x, i) => list.append(row(x, i > 0 && g[0].tweet_id === x.group_key && !x.is_self_thread, shown)));
          }
          const n = r.items.length;
          status.textContent = !n ? (q ? 'Nothing matches that search.' : 'Nothing else to add. Everything saved is already here.')
            : n >= r.limit ? `Showing the newest ${n}. Type to find older ones.` : `${plural(n, 'item')} found`;
        } catch (x) { if (s === seq && body.isConnected) status.textContent = x.message; }
      };
      input.addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(load, 250); });
      // Enter in the search box searches now; it never adds by accident
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); load(); } });
      body.append(h('form', { method: 'dialog', class: 'pform', onsubmit: (e) => { e.preventDefault(); if (chosen.size) finish([...chosen]); } },
        h('h2', { id: `${id}-t`, text: `Add to “${m.title.slice(0, 60)}”` }),
        h('p', { id: `${id}-d`, text: 'Tick the saved items to add. Items already in another merged item stay there too. Archived items you add move out of Archived.' }),
        h('label', { class: 'lbl', for: `${id}-q`, text: 'Search saved items' }), input, status, list,
        h('div', { class: 'btnrow' },
          h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: () => finish(null) }), addBtn)));
      load();
    }, { cls: 'picker' });
  }

  // choose one merged item (most recently changed first); resolves to its row from GET /api/bundles, or null
  function pickMergeDialog({ title, hint, exclude = null }) {
    return dialogBox((body, finish, id) => {
      let all = null;
      const input = h('input', { type: 'search', id: `${id}-q`, autocomplete: 'off', placeholder: 'Title, name or tag', autofocus: true, 'aria-controls': `${id}-list` });
      const status = h('p', { class: 'pstatus small', role: 'status', text: 'Loading…' });
      const list = h('ul', { class: 'plist mlist', id: `${id}-list`, 'aria-label': 'Merged items' });
      const buttons = () => [...list.querySelectorAll('button')];
      const draw = () => {
        if (!all) return;
        const words = input.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
        const hit = all.filter((b) => words.every((w) => b.title.toLowerCase().includes(w) || b.slug.includes(w)
          || (b.tags || []).some((t) => t.toLowerCase().includes(w))));
        clear(list);
        for (const b of hit.slice(0, 200)) {
          list.append(h('li', {}, h('button', { type: 'button', class: 'mrow', onclick: () => finish(b) },
            h('span', { class: 'pline', text: b.title }),
            h('span', { class: 'meta' }, h('span', { text: plural(b.items, 'source') }), h('span', { class: 'dot', 'aria-hidden': 'true' }),
              h('span', { title: when(b.updated_at), text: `Updated ${ago(b.updated_at)}` })))));
        }
        status.textContent = !all.length ? 'There are no other merged items yet. Merge some items first.'
          : !hit.length ? 'No merged item matches that search.' : plural(hit.length, 'merged item');
      };
      input.addEventListener('input', draw);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); const f = buttons()[0]; if (f) f.focus(); }
      });
      list.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        const bs = buttons();
        const i = bs.indexOf(document.activeElement);
        if (e.key === 'ArrowUp' && i <= 0) { input.focus(); return; }
        const next = bs[e.key === 'ArrowDown' ? Math.min(bs.length - 1, i + 1) : i - 1];
        if (next) next.focus();
      });
      body.append(h('div', { class: 'pform' },
        h('h2', { id: `${id}-t`, text: title }),
        hint ? h('p', { id: `${id}-d`, text: hint }) : null,
        h('label', { class: 'lbl', for: `${id}-q`, text: 'Find a merged item' }), input, status, list,
        h('div', { class: 'btnrow' }, h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: () => finish(null) }))));
      api('GET', '/api/bundles').then((r) => {
        if (!body.isConnected) return;
        if (!exclude) state.bundles = r.bundles;
        all = r.bundles.filter((b) => b.slug !== exclude);
        draw();
      }).catch((x) => { if (body.isConnected) status.textContent = x.message; });
    }, { cls: 'picker' });
  }

  // send the open merge's last change now, so what happens next works on what's on screen
  async function flushMerge(m) {
    const order = m.groups.flatMap((g) => [...g.fixed, ...g.replies].map((x) => x.id));
    const sig = JSON.stringify([m.title, order]);
    if (m.slug && order.length && sig !== m.savedSig) {
      await saveMerge(m, { title: m.title, item_ids: order });
      m.savedSig = sig;
    } else if (m.saving) await m.saving;
  }

  // merge editor → "Add items": the merge reloads in place (same scroll, focus back on the button)
  async function addItemsToMerge(m) {
    const ids = await pickItemsDialog(m);
    if (!ids || state.merge !== m) return;
    const y = window.scrollY;
    try {
      await flushMerge(m);
      const r = await api('POST', `/api/bundles/${encodeURIComponent(m.slug)}/add`, { item_ids: ids });
      if (state.merge === m) {
        await openBundle(m.slug, m);
        window.scrollTo(0, y);
        const b = document.querySelector('[data-fkey="addsrc"]');
        if (b) b.focus();
      }
      toast(r.added ? `Added ${plural(r.added, 'item')}` : 'Those were already in it');
    } catch (x) {
      if (x.status === 409 || x.mergeGone) return;   // saveMerge already said so and reloaded (or left)
      toast(x.message, true);
    }
  }

  // an item's ⋯ → "Add to merged…": it joins the chosen merge and the page stays where it is
  async function addOneToMerged(x) {
    const b = await pickMergeDialog({ title: 'Add to merged', hint: 'Choose the merged item to add this to.' });
    if (!b) return;
    try {
      const r = await api('POST', `/api/bundles/${encodeURIComponent(b.slug)}/add`, { item_ids: [x.id] });
      const name = b.title.slice(0, 40);
      toast(r.added ? `Added to ${name}` : `Already in ${name}`, false, { label: 'Open', fn: () => openBundle(b.slug) });
    } catch (e) { toast(e.message, true); }
    if (listShowing()) loadInbox().catch(() => {});
  }

  // the selection bar's "Add to merged…"
  async function addSelectedToMerged() {
    const ids = [...state.selected];
    if (!ids.length) return;
    const b = await pickMergeDialog({ title: `Add ${plural(ids.length, 'item')} to merged`, hint: 'Choose the merged item to add them to.' });
    if (b) await addToMerged(b.slug, ids);
  }

  // "Combine into…": every source of src moves into the chosen merge, then src goes away (nothing is deleted)
  async function combineInto(src, count) {
    const to = await pickMergeDialog({ title: `Combine “${src.title.slice(0, 60)}” into…`, hint: 'Choose the merged item that gets its sources.', exclude: src.slug });
    if (!to) return;
    const n = count ?? src.items ?? 0;
    if (!await confirmBox({ title: 'Combine merged items?', ok: 'Combine',
      body: `Move all ${plural(n, 'source')} from “${src.title}” into “${to.title}”? “${src.title}” will be removed; nothing is deleted.` })) return;
    const m = state.merge && state.merge.slug === src.slug ? state.merge : null;
    try {
      if (m) await flushMerge(m);
      const r = await api('POST', `/api/bundles/${encodeURIComponent(to.slug)}/combine`, { from: src.slug, ...(m ? { from_version: m.version } : {}) });
      toast(r.added ? `Combined. ${plural(r.added, 'source')} moved into ${to.title.slice(0, 40)}.` : `Combined into ${to.title.slice(0, 40)}.`);
      await openBundle(to.slug);
    } catch (x) {
      if (x.mergeGone) return;   // saveMerge said so and went to the Merged list
      if (x.status === 409) {
        // saveMerge reloaded already; a refused combine reloads here
        if (m && state.merge === m) { toast(x.message, true); await openBundle(m.slug).catch(() => {}); }
        return;
      }
      toast(x.message, true);
      if (!state.merge && state.view && state.view.kind === 'bundles') renderBundles().catch(() => {});
    }
  }

  // carry: the merge being reloaded in place, whose open panels and "In English" choice are kept
  async function openBundle(slug, carry = null) {
    const d = await api('GET', `/api/bundles/${encodeURIComponent(slug)}`);
    state.merge = {
      groups: groupsFromItems(d.items), title: d.bundle.title, slug: d.bundle.slug, version: d.bundle.version,
      meta: { category_id: d.bundle.category_id ?? null, priority: d.bundle.priority || 0, tags: d.bundle.tags || [] },
      ...(carry ? { detailsOpen: carry.detailsOpen, english: carry.english } : {}),
    };
    state.merge.savedSig = JSON.stringify([d.bundle.title, mergeOrder()]);
    state.selecting = false;
    renderMerge();
  }

  // For links and buttons: a collection unmerged in another tab (404) or a dropped connection shows a
  // message, and the page you're on is refreshed so the dead link goes away.
  function openBundleFromClick(slug) {
    return openBundle(slug).catch((x) => {
      toast(x.message, true);
      if (state.merge) return;
      if (state.view && state.view.kind === 'bundles') renderBundles().catch(() => {});
      else if (listShowing()) loadInbox().catch(() => {});
    });
  }

  // One save at a time, always with the version this page last saw. If the merge changed somewhere
  // else (another tab, "Add to merged"), the server refuses and the page reloads the latest copy.
  async function saveMerge(m, patch) {
    const run = async () => {
      const r = await api('PUT', `/api/bundles/${encodeURIComponent(m.slug)}`, { ...patch, version: m.version });
      m.version = r.version;
      return r;
    };
    const p = (m.saving || Promise.resolve()).catch(() => {}).then(run);
    m.saving = p;
    try {
      return await p;
    } catch (x) {
      if (x.status === 409 && state.merge === m) {
        toast(x.message);
        await openBundle(m.slug);
      } else if (x.status === 404 && state.merge === m) {
        // combined into another merge, or unmerged, in another tab: nothing to save into any more
        x.mergeGone = true;
        toast('This merged item was combined or unmerged somewhere else.', true);
        await go({ tab: 'bundles' });
      }
      throw x;
    }
  }

  // close the tab or reload within the save delay: send the last change anyway
  window.addEventListener('pagehide', () => {
    const m = state.merge;
    if (!m || !m.slug) return;
    const order = m.groups.flatMap((g) => [...g.fixed, ...g.replies].map((x) => x.id));
    if (!order.length || JSON.stringify([m.title, order]) === m.savedSig) return;
    try {
      fetch(`/api/bundles/${encodeURIComponent(m.slug)}`, {
        method: 'PUT', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: m.title, item_ids: order, version: m.version }),
      });
    } catch { /* best effort */ }
  });

  // ---------- merge ----------
  // Merging saves straight away; the collection lives under Merged from then on.
  // A double-click (or a second click while the server is slow) would otherwise send a second POST
  // and make a duplicate collection ("title-2") of the same items.
  let merging = false;
  async function startMerge() {
    if (merging) return;
    const pick = (x) => x && state.selected.has(x.id);
    const ids = [];
    let first = null;
    for (const g of state.groups) {
      for (const x of [g.root, ...g.thread, ...g.replies].filter(pick)) {
        ids.push(x.id);
        if (!first) first = x;
      }
    }
    if (!ids.length) return;
    const title = first ? (first.kind === 'article' ? first.title : (first.preview || '').replace(/\s+/g, ' ').slice(0, 60)) : '';
    merging = true;
    try {
      const r = await api('POST', '/api/bundles', { title: title || 'Untitled', item_ids: ids });
      state.selected.clear();
      state.selecting = false;
      toast('Merged and saved. Find it any time under Merged.');
      await openBundle(r.slug);
    } catch (x) { toast(x.message, true); } finally { merging = false; }
  }

  function groupsFromItems(items) {
    // items: dto list in saved order (already normalised by the server)
    const groups = [];
    const map = new Map();
    for (const x of items) {
      if (!map.has(x.group_key)) { map.set(x.group_key, { key: x.group_key, fixed: [], replies: [] }); groups.push(map.get(x.group_key)); }
      const g = map.get(x.group_key);
      if (x.tweet_id === x.group_key || x.is_self_thread || x.kind === 'text' || x.kind === 'link') g.fixed.push(x); else g.replies.push(x);
    }
    return groups;
  }

  // The title as the server stores it (trimmed, at most 200 characters). The server keeps the old title
  // when it is sent an empty one, so an empty box keeps the last title here too and the preview,
  // the copies and the Merged list all agree.
  function mergeTitle(raw, last) {
    const t = String(raw || '').trim().slice(0, 200);
    return t ? { title: t, kept: false } : { title: last, kept: true };
  }

  const mergeOrder = () => state.merge.groups.flatMap((g) => [...g.fixed, ...g.replies].map((x) => x.id));

  let previewTimer = null;
  let previewSeq = 0;
  // Copy buttons only work on a preview that matches the current order and title.
  // m is the merge the view was built for: work that finishes after you've left it must not touch
  // whichever merge (or none) is current by then.
  function refreshPreview(m, pre, withSources) {
    if (state.merge !== m || !pre.isConnected) return;
    m.rendered = null;
    if (m.setFresh) m.setFresh(false);
    clearTimeout(previewTimer);
    const seq = ++previewSeq;
    previewTimer = setTimeout(async () => {
      let saving = false;   // "Not saved" only when the save itself failed, not the preview after it
      try {
        const order = m.groups.flatMap((g) => [...g.fixed, ...g.replies].map((x) => x.id));
        if (!order.length) {
          pre.textContent = 'Nothing left in this collection. Use Unmerge to finish, or go back.';
          if (m.setStatus) m.setStatus('');
          return;
        }
        // every change saves itself (even if you leave this screen straight away)
        const sig = JSON.stringify([m.title, order]);
        if (m.slug && sig !== m.savedSig) {
          if (m.setStatus) m.setStatus('Saving…');
          saving = true;
          await saveMerge(m, { title: m.title, item_ids: order });
          saving = false;
          m.savedSig = sig;
          if (m.setStatus) m.setStatus('Saved');
        }
        if (seq !== previewSeq || state.merge !== m) return;
        const r = await api('POST', '/api/render', { item_ids: order, title: m.title, english: !!m.english });
        if (seq !== previewSeq || state.merge !== m) return;
        m.rendered = r;
        pre.textContent = withSources() ? r.text_sources : r.text;
        if (m.setFresh) m.setFresh(true);
      } catch (x) {
        if (x.status === 409 || x.mergeGone) return; // reloaded with the latest version, or gone to Merged
        if (seq === previewSeq) pre.textContent = x.message;
        if (saving && m.setStatus) m.setStatus('Not saved, check your connection');
      }
    }, 250);
  }

  function move(arr, i, j) {
    if (j < 0 || j >= arr.length) return;
    const [x] = arr.splice(i, 1);
    arr.splice(j, 0, x);
  }

  // "In English" in the merge editor: translate the foreign sources that have no English yet (once, then
  // cached), showing progress in the preview. Used by the switch and after a reload that keeps the switch on
  // (Add items), so newly added sources are translated too. Not true = this merge's page is gone, stop there.
  async function translatePending(m, foreign, englishSw, pre) {
    // trPending: a redraw can start a second loop while the first still waits on a request; never send one twice
    const todo = foreign().filter((x) => !x.translation && !trCache.has(x.id) && !trPending.has(x.id));
    if (!todo.length) return true;
    englishSw.disabled = true;
    pre.textContent = `Translating ${plural(todo.length, 'source')}…`;
    for (const x of todo) {
      trPending.add(x.id);
      try {
        const r = await api('POST', `/api/items/${x.id}/translate`, {});
        trCache.set(x.id, { text: r.text, lang: r.lang, seq: state.inboxSeq });
        x.translation = { text: r.text, lang: r.lang };
      } catch (e) { toast(e.message, true); break; } finally { trPending.delete(x.id); }
      // left this merge (or reopened it): stop spending translations on a page that's gone
      if (state.merge !== m || !pre.isConnected) return;
    }
    englishSw.disabled = false;
    return true;
  }

  function renderMerge() {
    const m = state.merge;
    const main = shell();
    const pre = h('pre', { class: 'reading stale', tabindex: 0, 'aria-label': 'Reading preview', text: 'Building preview…' });
    const showSrc = h('input', { type: 'checkbox', id: 'src', role: 'switch' });
    const withSources = () => showSrc.checked;
    // "In English": sources in another language are translated (once, then cached) and the preview and
    // copies use the English text. Shown only when some source isn't English and translation is set up.
    const foreign = () => m.groups.flatMap((g) => [...g.fixed, ...g.replies]).filter((x) => x.lang);
    const englishSw = h('input', { type: 'checkbox', id: 'eng', role: 'switch', checked: !!m.english });
    englishSw.addEventListener('change', async () => {
      m.english = englishSw.checked;
      if (m.english && !await translatePending(m, foreign, englishSw, pre)) return;
      refresh();
    });
    const englishLabel = canTranslate() && foreign().length
      ? h('label', { class: 'switch', for: 'eng' }, 'In English', englishSw, h('span', { class: 'track', 'aria-hidden': 'true' }))
      : null;
    showSrc.addEventListener('change', () => { if (m.rendered) pre.textContent = withSources() ? m.rendered.text_sources : m.rendered.text; });
    const refresh = () => refreshPreview(m, pre, withSources);

    // title + save status
    const h1 = h('h1', { text: m.title });
    const status = h('span', { class: 'chip ok save-state', role: 'status', text: 'Saved' });
    m.setStatus = (s) => {
      status.textContent = s || '';
      status.hidden = !s;
      status.className = `chip save-state ${s === 'Saved' ? 'ok' : s === 'Saving…' ? 'saving' : 'bad'}`;
    };
    const titleIn = h('input', { type: 'text', id: 'title', value: m.title, maxlength: 200, 'aria-describedby': 'title-hint' });
    const titleHint = h('span', { id: 'title-hint', class: 'dhint', role: 'status', hidden: true, text: 'A collection needs a title. It keeps the last one until you type a new one.' });
    titleIn.addEventListener('input', () => {
      const t = mergeTitle(titleIn.value, m.title);
      titleHint.hidden = !t.kept;
      if (t.title === m.title) return;
      m.title = t.title;
      h1.textContent = m.title;
      refresh();
    });
    // leaving the box empty puts back the title that is actually saved
    titleIn.addEventListener('blur', () => { if (!titleIn.value.trim()) { titleIn.value = m.title; titleHint.hidden = true; } });

    const copySources = h('button', { type: 'button', class: 'btn primary', disabled: true, onclick: () => m.rendered && copyText(m.rendered.text_sources, 'with sources') }, icon('copy', 'sm'), 'Copy with sources');
    const copyWith = recipeMenuButton((rc) => copyMergeWithRecipe(m, rc));
    m.setFresh = (ok) => { copySources.disabled = !ok; copyWith.firstChild.disabled = !ok; pre.classList.toggle('stale', !ok); };

    let detailsOpen = !!m.detailsOpen;
    const details = h('section', { class: 'card details', id: 'edit-details', 'aria-label': 'Edit details', hidden: !detailsOpen });
    const detailsBtn = h('button', { type: 'button', class: 'tbtn', 'aria-expanded': String(detailsOpen), 'aria-controls': 'edit-details' }, 'Edit details', icon(detailsOpen ? 'chevup' : 'chevdown', 'sm'));
    const setDetails = (open) => {
      detailsOpen = open;
      m.detailsOpen = open;
      details.hidden = !open;
      detailsBtn.setAttribute('aria-expanded', String(open));
      detailsBtn.replaceChild(icon(open ? 'chevup' : 'chevdown', 'sm'), detailsBtn.lastChild);
      if (open) titleIn.focus();
    };
    detailsBtn.addEventListener('click', () => setDetails(!detailsOpen));

    const emeta = h('div', { class: 'emeta' });
    const tagsRow = h('div', { class: 'tagsrow' });
    const catHolder = h('span');
    const prioHolder = h('span');
    const srcCount = () => m.groups.reduce((n, g) => n + g.fixed.length + g.replies.length, 0);
    const drawMeta = () => {
      clear(emeta);
      const bits = [catMark(m.meta.category_id), prioChip(m.meta.priority), h('span', { text: plural(srcCount(), 'source') })].filter(Boolean);
      bits.forEach((b, i) => { if (i) emeta.append(h('span', { class: 'dot', 'aria-hidden': 'true' })); emeta.append(b); });
      emeta.append(h('span', { class: 'dot', 'aria-hidden': 'true' }), detailsBtn);
    };
    // category, priority and tags (saved right away)
    const saveMeta = async (patch, msg) => {
      try {
        const r = await saveMerge(m, patch);
        m.meta = { category_id: r.category_id, priority: r.priority, tags: r.tags };  // what the server stored
        if (msg) toast(msg);
        drawOrg();
        refreshSidebar();
      } catch (x) { if (x.status !== 409 && !x.mergeGone) toast(x.message, true); }
    };
    const drawOrg = () => {
      clear(catHolder).append(catSelect(m.meta.category_id, (id) => saveMeta({ category_id: id })));
      clear(prioHolder).append(prioSelect(m.meta.priority, (p) => saveMeta({ priority: p })));
      clear(tagsRow).append(
        (m.meta.tags || []).map((t) => h('span', { class: 'tagchip' }, `#${t}`,
          h('button', { type: 'button', title: `Remove #${t}`, 'aria-label': `Remove tag ${t}`, text: '×', onclick: () => saveMeta({ tags: m.meta.tags.filter((x) => x !== t) }) }))),
        h('button', { type: 'button', class: 'tbtn sm', onclick: async () => {
          const t = await askTags();
          if (t) saveMeta({ tags: [...new Set([...(m.meta.tags || []), ...t])] });
        } }, icon('plus', 'xs'), 'Add tags'));
      drawMeta();
    };
    if (!m.meta) m.meta = { category_id: null, priority: 0, tags: [] };
    details.append(
      h('div', { class: 'grid' },
        h('label', { for: 'title' }, 'Title', titleIn, titleHint),
        h('label', {}, 'Category', catHolder),
        h('label', {}, 'Priority', prioHolder),
        h('div', { class: 'lab' }, h('span', { class: 'small muted', text: 'Tags' }), tagsRow)),
      h('div', { class: 'slugrow' }, h('span', { class: 'muted', text: 'Name for Claude' }), h('code', { text: m.slug }),
        h('button', { type: 'button', class: 'tbtn sm', onclick: () => copyText(m.slug, 'name') }, icon('copy', 'xs'), 'Copy')),
      h('p', { class: 'small muted', text: 'Changes save by themselves. To add more, press Add items next to Sources, or choose Add to merged… on any saved item.' }));
    drawOrg();

    // sources
    const list = h('div', { class: 'srclist' });
    const srcHead = h('span', { class: 'scount muted' });
    const pad = (n) => String(n).padStart(2, '0');
    const prune = () => { m.groups = m.groups.filter((g) => g.fixed.length || g.replies.length); };
    // the last item can't be taken out; Unmerge does that (and says where things go)
    function lastOne() {
      if (srcCount() > 1) return false;
      toast('This is the last item. Use Unmerge to send it back to the Inbox.', false, { label: 'Unmerge', fn: () => unmergeBundle(m.slug, m.title) });
      return true;
    }
    const changed = () => { draw(); drawMeta(); refresh(); };
    // a source's own note: saved straight to the item, then the preview picks it up
    const openSrcNote = (x) => { noteOpen.add(x.id); draw(); focusNote(x.id); };
    const srcNote = (x) => (noteOpen.has(x.id)
      ? noteBox(x, {
        onSaved: (note) => { x.my_note = note; refresh(); },
        onClose: (refocus) => {
          if (state.merge !== m || !list.isConnected) return;
          // as in the Inbox: a menu the closing click opened stays, and the rows catch up when it closes
          if (menuIn(list)) m.srcDirty = true; else draw();
          const lost = !document.activeElement || document.activeElement === document.body;
          if (refocus || lost) { const b = list.querySelector(`[data-fkey="smore:${x.id}"]`); if (b) b.focus(); }
        },
        repaint: () => { if (state.merge === m && list.isConnected) redraw(); },
      })
      : myNoteView(x));
    const draw = () => {
      m.srcDirty = false;
      // rebuilding the rows replaces the focused control: put focus back on the same one by key
      const key = focusKey();
      clear(list);
      srcHead.textContent = String(srcCount());
      let k = 0;
      m.groups.forEach((g, gi) => {
        const part = h('section', { class: 'part', 'data-g': gi, 'aria-label': `Part ${gi + 1}` });
        if (m.groups.length > 1) {
          part.append(h('div', { class: 'parthead' }, h('span', { text: `Part ${gi + 1}` }),
            h('span', {},
              h('button', { type: 'button', class: 'ibtn sm', 'aria-label': 'Move this part up', title: 'Move this part up', disabled: gi === 0, onclick: () => { move(m.groups, gi, gi - 1); changed(); } }, icon('up', 'sm')),
              h('button', { type: 'button', class: 'ibtn sm', 'aria-label': 'Move this part down', title: 'Move this part down', disabled: gi === m.groups.length - 1, onclick: () => { move(m.groups, gi, gi + 1); changed(); } }, icon('down', 'sm')))));
        }
        for (const x of g.fixed) {
          k += 1;
          const t = x.kind === 'article' ? (x.title || 'Article') : (x.preview || '').replace(/\s+/g, ' ').slice(0, 160);
          part.append(h('div', { class: 'src' },
            h('span', { class: 'num', 'aria-hidden': 'true', text: pad(k) }),
            h('div', {}, h('div', { class: 'stitle', text: t || kindName(x) }),
              h('div', { class: 'smeta' }, kindChip(x), x.author_handle ? h('span', { text: `@${x.author_handle}` }) : null, threadChip(x)),
              srcNote(x)),
            moreBtn(t.slice(0, 50) || kindName(x), () => [
              noteMenuItem(x, () => openSrcNote(x)),
              safeHref(x.url) ? { label: 'Open source', icon: 'ext', onClick: () => window.open(safeHref(x.url), '_blank', 'noopener,noreferrer') } : null,
              threadMenuItem(x, { slug: m.slug, title: m.title }),
              { sep: true },
              { label: 'Take out (back to Inbox)', icon: 'undo', danger: true, onClick: () => { if (lastOne()) return; g.fixed.splice(g.fixed.indexOf(x), 1); prune(); changed(); } },
            ], { fkey: `smore:${x.id}` })));
        }
        g.replies.forEach((x, i) => {
          k += 1;
          const snip = (x.preview || '').replace(/\s+/g, ' ').slice(0, 140);
          const li = h('div', { class: 'src rep', draggable: 'true', tabindex: 0, 'aria-label': `Reply ${i + 1}${x.author_handle ? ` by @${x.author_handle}` : ''}. Alt+Up or Alt+Down to move.` },
            h('span', { class: 'num', 'aria-hidden': 'true', text: pad(k) }),
            h('div', {}, h('div', { class: 'stitle', text: snip || 'Reply' }),
              h('div', { class: 'smeta' }, h('span', { class: 'chip thread', text: `Reply ${i + 1}` }), x.author_handle ? h('span', { text: `@${x.author_handle}` }) : null),
              srcNote(x)),
            moreBtn(`reply ${i + 1}`, () => [
              noteMenuItem(x, () => openSrcNote(x)),
              { label: 'Move up', icon: 'up', onClick: () => { move(g.replies, i, i - 1); changed(); } },
              { label: 'Move down', icon: 'down', onClick: () => { move(g.replies, i, i + 1); changed(); } },
              safeHref(x.url) ? { label: 'Open source', icon: 'ext', onClick: () => window.open(safeHref(x.url), '_blank', 'noopener,noreferrer') } : null,
              { sep: true },
              { label: 'Take out (back to Inbox)', icon: 'undo', danger: true, onClick: () => { if (lastOne()) return; g.replies.splice(i, 1); prune(); changed(); } },
            ], { fkey: `smore:${x.id}` }));
          li.addEventListener('keydown', (e) => {
            if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || e.target !== li) return;
            e.preventDefault();
            const j = e.key === 'ArrowUp' ? i - 1 : i + 1;
            move(g.replies, i, j); changed();
            const again = list.querySelectorAll(`[data-g="${gi}"] .src.rep`)[Math.max(0, Math.min(g.replies.length - 1, j))];
            if (again) again.focus();
          });
          li.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', `${gi}:${i}`); li.classList.add('dragging'); });
          li.addEventListener('dragend', () => li.classList.remove('dragging'));
          li.addEventListener('dragover', (e) => { e.preventDefault(); li.classList.add('over'); });
          li.addEventListener('dragleave', () => li.classList.remove('over'));
          li.addEventListener('drop', (e) => {
            e.preventDefault();
            li.classList.remove('over');
            const [sg, si] = String(e.dataTransfer.getData('text/plain')).split(':').map(Number);
            if (sg !== gi) { toast('Replies can only move within their own conversation'); return; }
            move(g.replies, si, i); changed();
          });
          part.append(li);
        });
        if (g.replies.length > 1) part.append(h('p', { class: 'dhint', text: 'Drag replies, or use Alt+↑ ↓, to set their order.' }));
        list.append(part);
      });
      if (!m.groups.length) list.append(h('p', { class: 'muted', text: 'Nothing left in this collection.' }));
      restoreFocus(key);
    };
    // a redraw from outside (a "Get full thread" job) waits while a note is being typed or a menu is
    // open here: the note's closing, or the menu's, draws the rows again
    const redraw = () => { if (noteEditing(list) || menuIn(list)) { m.srcDirty = true; return; } draw(); };
    m.redrawSources = redraw;   // a "Get full thread" job shows and clears its status on the source row

    main.append(
      h('div', { class: 'back' }, h('button', { type: 'button', class: 'tbtn', onclick: () => go({ tab: 'bundles' }) }, icon('left', 'sm'), 'Back to merged')),
      h('div', { class: 'ehead' },
        h('div', { class: 'tl' }, h1, status),
        h('div', { class: 'ea' }, copySources, copyWith, moreBtn(m.title, () => [
          { label: 'Copy text', icon: 'copy', onClick: () => (m.rendered ? copyText(m.rendered.text, 'text') : toast('The preview is still updating. Try again in a moment.', true)) },
          { label: 'Copy name for Claude', icon: 'copy', onClick: () => copyText(m.slug, 'name') },
          { label: detailsOpen ? 'Hide details' : 'Edit details', icon: 'pencil', onClick: () => setDetails(!detailsOpen) },
          { label: 'Add items…', icon: 'plus', tone: 'blue', onClick: () => addItemsToMerge(m) },
          { label: 'Combine into…', icon: 'layers', onClick: () => combineInto({ slug: m.slug, title: m.title }, srcCount()) },
          { sep: true },
          { label: 'Unmerge', icon: 'trash', danger: true, onClick: () => unmergeBundle(m.slug, m.title) },
        ]))),
      emeta,
      details,
      h('div', { class: 'card workspace' },
        h('div', { class: 'srcpane' }, h('div', { class: 'pane-h' }, h('h2', { text: 'Sources' }), srcHead, h('span', { class: 'grow' }),
          h('button', { type: 'button', class: 'tbtn sm', 'data-fkey': 'addsrc', onclick: () => addItemsToMerge(m) }, icon('plus', 'xs'), 'Add items')), list),
        h('div', { class: 'readpane' },
          h('div', { class: 'pane-h' }, h('h2', { text: 'Reading preview' }), h('span', { class: 'grow' }),
            englishLabel,
            h('label', { class: 'switch', for: 'src' }, 'Show sources', showSrc, h('span', { class: 'track', 'aria-hidden': 'true' }))),
          pre)));
    draw();
    // reloaded with "In English" kept on (Add items): translate what was just added before the first preview
    if (m.english && canTranslate()) translatePending(m, foreign, englishSw, pre).then((ok) => { if (ok) refresh(); });
    else refresh();
    watchThreads(m.groups.flatMap((g) => [...g.fixed, ...g.replies]), { slug: m.slug, title: m.title });
  }

  async function unmergeBundle(slug, title) {
    if (!await confirmBox({ title: `Unmerge "${title}"?`, body: 'Its items go back to your Inbox. Nothing is deleted.', ok: 'Unmerge' })) return;
    try {
      const r = await api('DELETE', `/api/bundles/${encodeURIComponent(slug)}`);
      toast(`Unmerged. ${plural(r.returned, 'item')} back in the Inbox.`);
      go({ tab: state.merge || state.tab === 'bundles' ? 'inbox' : state.tab });
    } catch (x) { toast(x.message, true); }
  }

  // ---------- merged ----------
  async function renderBundles() {
    const prev = state.view;
    const reuse = prev && prev.kind === 'bundles' && document.body.contains(prev.list);
    let v = prev;
    if (!reuse) {
      const main = shell();
      const head = pageHead(tabTitle(), '', scoped() ? null : h('button', { type: 'button', class: 'btn', onclick: () => go({ tab: 'inbox', selecting: true }) }, 'Merge from Inbox'));
      const tools = h('div');
      const panel = h('div');
      const list = h('div', { class: 'cards' });
      main.append(head.el, tools, panel, list);
      v = state.view = { kind: 'bundles', head, tools, panel, list };
      const sort = sortSelect(BSORTS, state.bsort, (val) => { state.bsort = val; go({}); });
      // a local search box; it shares the query with the header search
      const hint = scoped() ? `Search in ${tabTitle()}` : 'Find a collection';
      const find = h('input', { type: 'search', id: 'bq', placeholder: hint, value: state.q, autocomplete: 'off' });
      let deb = null;
      find.addEventListener('input', () => {
        clearTimeout(deb);
        deb = setTimeout(() => { state.q = find.value; state.shell.search.value = find.value; renderBundles().catch(() => {}); }, 300);
      });
      const findBox = h('div', { class: 'gsearch fsearch' }, icon('search'), h('label', { for: 'bq', class: 'sr', text: hint }), find);
      if (scoped()) {
        tools.append(h('div', { class: `fbar${state.filter.priority === 3 && state.filter.category === null ? ' prio' : ''}` },
          h('span', { class: 'flabel', text: 'Showing' }), scopeSelect(), findBox, ...appliedChips(), filtersToggle(), sort));
      } else {
        tools.append(h('div', { class: 'fbar' }, findBox, ...appliedChips(), filtersToggle(), sort));
      }
      panel.append(filtersPanel());
    }
    const seq = ++state.inboxSeq;
    const r = await api('GET', `/api/bundles?${filterQuery(state.bsort)}&q=${encodeURIComponent(state.q)}`);
    if (seq !== state.inboxSeq || state.view !== v) return;
    if (!anyFilter() && !state.q) state.bundles = r.bundles;
    v.head.count.textContent = plural(r.bundles.length, 'collection');
    const list = clear(v.list);
    if (!r.bundles.length) {
      const f = state.filter;
      list.append(state.q
        ? emptyCard({ ic: 'search', title: 'No collections match that search.', text: 'Search looks at titles, names for Claude and tags.', links: [{ label: 'Clear search', onClick: () => { state.q = ''; state.shell.search.value = ''; renderBundles(); } }] })
        : f.category === 'none'
          ? emptyCard({ ic: 'tag', tone: 'gold', title: 'No uncategorized collections.', text: 'All your merged collections have a category.', links: [{ label: 'Browse merged', onClick: () => openView('bundles') }, { label: 'View inbox', onClick: () => openView('inbox') }] })
          : anyFilter()
            ? emptyCard({ ic: 'filter', title: 'Nothing merged matches these filters.', text: 'Try the Inbox scope, or clear the filters.', links: [{ label: 'Clear filters', onClick: () => setFilter({ category: null, tag: null, priority: 0 }) }, { label: 'View inbox', onClick: () => go({ tab: 'inbox' }) }] })
            : emptyCard({ ic: 'layers', title: 'Nothing merged yet.', text: 'Select items in the Inbox and press Merge. Collections are kept here.', links: [{ label: 'Go to Inbox', onClick: () => go({ tab: 'inbox', selecting: true }) }] }));
      return;
    }
    const exp = async (b, sources) => {
      try { copyText(await api('GET', `/api/bundles/${encodeURIComponent(b.slug)}/export?sources=${sources ? 1 : 0}`), sources ? 'with sources' : 'text'); } catch (x) { toast(x.message, true); }
    };
    if (!state.recipes) loadRecipes();
    for (const b of r.bundles) {
      const c = catOf(b.category_id);
      const dot = () => h('span', { class: 'dot', 'aria-hidden': 'true' });
      const meta = [catMark(b.category_id), h('span', { class: 'srcs', text: plural(b.items, 'source') }), prioChip(b.priority), h('span', { title: when(b.updated_at), text: `Updated ${ago(b.updated_at)}` })].filter(Boolean);
      list.append(h('article', { class: 'card bcard', 'aria-label': b.title },
        h('span', { class: `initials v-${c ? catTone(c).tone : toneOf(b.slug)}`, 'aria-hidden': 'true', text: initialsOf(b.title) }),
        h('div', { class: 'bodycol' },
          h('h3', { class: 'ititle' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); openBundleFromClick(b.slug); }, text: b.title })),
          h('div', { class: 'meta' }, meta.map((x, i) => [i ? dot() : null, x])),
          h('p', { class: 'excerpt small muted' }, 'Name for Claude: ', h('code', { text: b.slug }),
            (b.tags || []).length ? ` · ${b.tags.map((t) => `#${t}`).join(' ')}` : ''),
          h('div', { class: 'foot' }, h('button', { type: 'button', class: 'tbtn', onclick: () => openBundleFromClick(b.slug) }, 'Open collection', icon('ext', 'sm')))),
        moreBtn(b.title, () => [
          { label: 'Open collection', icon: 'layers', tone: 'blue', onClick: () => openBundle(b.slug) },
          { label: 'Copy text', icon: 'copy', onClick: () => exp(b, false) },
          { label: 'Copy with sources', icon: 'copy', onClick: () => exp(b, true) },
          { label: 'Copy with…', icon: 'copy', sub: recipeItems((rc) => copyBundleWithRecipe(b, rc)) },
          { label: 'Copy name for Claude', icon: 'copy', onClick: () => copyText(b.slug, 'name') },
          { label: 'Combine into…', icon: 'layers', onClick: () => combineInto(b) },
          { sep: true },
          { label: 'Unmerge', icon: 'trash', danger: true, onClick: () => unmergeBundle(b.slug, b.title) },
        ])));
    }
  }

  // ---------- prompt recipes ----------
  // A recipe is an instruction copied together with a collection: "Copy with…" gives Claude the task and
  // the material in one paste. The server wraps the material and marks it as source, not instructions.
  async function loadRecipes() {
    try { state.recipes = (await api('GET', '/api/recipes')).recipes; } catch { /* the menus say so; the page shows the error */ }
    return state.recipes || [];
  }

  // menu items for the recipes, in their order; menus are built when opened, so this reads the cache
  function recipeItems(onPick) {
    if (!state.recipes) loadRecipes();
    const list = state.recipes || [];
    return [
      list.length ? list.map((rc) => ({ label: rc.name, icon: 'note', onClick: () => onPick(rc) }))
        : { hint: state.recipes ? 'No recipes yet' : 'Loading recipes… Try again in a moment.' },
      { sep: true },
      { label: 'Edit recipes', icon: 'pencil', onClick: () => openView('recipes') },
    ].flat();
  }

  // "Copy with…" next to Copy in the collection editor (starts disabled, like Copy, until the preview is ready)
  function recipeMenuButton(onPick) {
    if (!state.recipes) loadRecipes();
    return menuButton(h('button', { type: 'button', class: 'btn', disabled: true, 'data-fkey': 'copywith' }, icon('copy', 'sm'), 'Copy with…', icon('chevdown', 'sm')),
      () => recipeItems(onPick));
  }

  // a recipe deleted in another tab: refresh the list so the menu stops offering it
  const recipeGone = (x) => { if (x.status === 404) loadRecipes(); throw x; };

  async function copyMergeWithRecipe(m, rc) {
    if (state.merge !== m) return;
    const order = mergeOrder();
    if (!order.length) return;
    const r = await api('POST', '/api/render', { item_ids: order, title: m.title, english: !!m.english, recipe_id: rc.id }).catch(recipeGone);
    if (state.merge !== m) return;
    await copyText(r.prompt_text, `with “${rc.name}”`);
  }

  async function copyBundleWithRecipe(b, rc) {
    const text = await api('GET', `/api/bundles/${encodeURIComponent(b.slug)}/export?recipe=${encodeURIComponent(rc.id)}`).catch(recipeGone);
    await copyText(text, `with “${rc.name}”`);
  }

  // focus the first of these controls that can take it (Move up is disabled once a recipe is at the top)
  function focusFirst(keys) {
    for (const k of keys) {
      const el = [...document.querySelectorAll('[data-fkey]')].find((x) => x.dataset.fkey === k);
      if (el && !el.disabled) { el.focus(); return; }
    }
  }

  // what a recipe card would send now: {error} when it can't be saved yet, else {patch} (null when nothing changed)
  function recipePatch(draft, saved) {
    const n = String(draft.name || '').replace(/\s+/g, ' ').trim();
    const p = String(draft.prompt || '').replace(/\r\n?/g, '\n').trim();
    if (!n || !p) return { error: n ? 'Not saved: write the instruction' : 'Not saved: give it a name' };
    const patch = {};
    if (n !== saved.name) patch.name = n;
    if (p !== saved.prompt) patch.prompt = p;
    return { patch: Object.keys(patch).length ? patch : null };
  }
  // closing the tab or reloading within the save delay: send the recipe edits that can be saved
  window.addEventListener('pagehide', () => {
    for (const [id, ed] of state.recEdits) {
      const { patch } = recipePatch(ed, ed.saved);
      if (!patch) continue;
      try {
        fetch(`/api/recipes/${id}`, {
          method: 'PATCH', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
      } catch { /* best effort */ }
    }
  });

  async function renderRecipes(focusKeys) {
    const seq = ++state.recSeq;
    const main = shell();
    const r = await api('GET', '/api/recipes');
    if (seq !== state.recSeq || state.tab !== 'recipes' || state.merge || !document.body.contains(main)) return;
    clear(main);
    state.recipes = r.recipes;
    const lim = r.limits || { name: 60, prompt: 8000, count: 50 };
    const list = r.recipes;
    for (const id of [...state.recEdits.keys()]) if (!list.some((rc) => rc.id === id)) state.recEdits.delete(id);

    // every card saves by itself; anything still waiting is saved before the page is rebuilt
    const flushers = new Set();
    const flushAll = () => Promise.all([...flushers].map((f) => f()));
    const rerender = async (keys) => {
      await flushAll();
      if (state.tab !== 'recipes' || state.merge) return;
      await renderRecipes(keys);
    };

    const card = (rc, i) => {
      const id = `rc${rc.id}`;
      const nameIn = h('input', { type: 'text', id: `${id}-n`, value: rc.name, maxlength: lim.name, autocomplete: 'off', 'data-fkey': `rcname:${rc.id}` });
      const promptIn = h('textarea', { id: `${id}-p`, rows: 7, maxlength: lim.prompt, 'aria-describedby': 'rc-help', 'data-fkey': `rcprompt:${rc.id}` });
      promptIn.value = rc.prompt;
      const status = h('span', { class: 'chip save-state', role: 'status', hidden: true });
      const setStatus = (s, bad = false) => {
        status.textContent = s || '';
        status.hidden = !s;
        status.className = `chip save-state ${bad ? 'bad' : s === 'Saved' ? 'ok' : 'saving'}`;
      };
      let saved = { name: rc.name, prompt: rc.prompt };
      // typing that didn't save (a blank name, a failed request) comes back after a rebuild and is tried again
      const kept = state.recEdits.get(rc.id);
      if (kept) { nameIn.value = kept.name; promptIn.value = kept.prompt; kept.saved = saved; }
      const remember = () => state.recEdits.set(rc.id, { name: nameIn.value, prompt: promptIn.value, saved });
      let timer = null;
      let chain = Promise.resolve();
      const save = async () => {
        const { error, patch } = recipePatch({ name: nameIn.value, prompt: promptIn.value }, saved);
        if (error) { setStatus(error, true); return; }
        if (!patch) { state.recEdits.delete(rc.id); return; }
        setStatus('Saving…');
        try {
          const out = (await api('PATCH', `/api/recipes/${rc.id}`, patch)).recipe;
          saved = { name: out.name, prompt: out.prompt };
          // the same object sits in state.recipes, so the Copy with… menus show the new name at once
          rc.name = out.name;
          rc.prompt = out.prompt;
          // nothing left to keep, unless more was typed meanwhile
          const ed = state.recEdits.get(rc.id);
          if (ed) { ed.saved = saved; const left = recipePatch(ed, saved); if (!left.error && !left.patch) state.recEdits.delete(rc.id); }
          setStatus('Saved');
        } catch (x) { setStatus(`Not saved: ${x.message}`, true); }
      };
      // saves run one after another, so an older one can never land after a newer one
      const flush = () => { clearTimeout(timer); timer = null; chain = chain.then(save); return chain; };
      flushers.add(flush);
      const later = () => { remember(); clearTimeout(timer); setStatus(''); timer = setTimeout(flush, 800); };
      if (kept) timer = setTimeout(flush, 0);
      nameIn.addEventListener('input', later);
      promptIn.addEventListener('input', later);
      nameIn.addEventListener('blur', () => { if (timer) flush(); });
      promptIn.addEventListener('blur', () => { if (timer) flush(); });

      const moveTo = async (j, keys) => {
        const ids = list.map((x) => x.id);
        move(ids, i, j);
        try {
          await flushAll();
          await api('POST', '/api/recipes/order', { ids });
        } catch (x) { toast(x.message, true); }
        await rerender(keys);
      };
      const del = async () => {
        if (!await confirmBox({ title: `Delete “${saved.name}”?`, body: 'Only the recipe goes. Your collections stay as they are.', ok: 'Delete recipe', danger: true })) return;
        try {
          await api('DELETE', `/api/recipes/${rc.id}`);
          state.recEdits.delete(rc.id);
          toast('Recipe deleted');
        } catch (x) { toast(x.message, true); }
        const next = list[i + 1] || list[i - 1];
        await rerender(next ? [`rcname:${next.id}`] : ['rc-new']);
      };
      return h('section', { class: 'card rcard', 'aria-label': `Recipe ${i + 1} of ${list.length}` },
        h('label', { class: 'lbl', for: `${id}-n`, text: 'Name' }), nameIn,
        h('label', { class: 'lbl', for: `${id}-p`, text: 'Instruction' }), promptIn,
        h('div', { class: 'rfoot' },
          h('button', { type: 'button', class: 'ibtn sm', 'aria-label': `Move ${rc.name} up`, title: 'Move up', disabled: i === 0, 'data-fkey': `rcup:${rc.id}`,
            onclick: () => moveTo(i - 1, [`rcup:${rc.id}`, `rcdown:${rc.id}`]) }, icon('up', 'sm')),
          h('button', { type: 'button', class: 'ibtn sm', 'aria-label': `Move ${rc.name} down`, title: 'Move down', disabled: i === list.length - 1, 'data-fkey': `rcdown:${rc.id}`,
            onclick: () => moveTo(i + 1, [`rcdown:${rc.id}`, `rcup:${rc.id}`]) }, icon('down', 'sm')),
          status,
          h('span', { class: 'grow' }),
          h('button', { type: 'button', class: 'tbtn danger', 'aria-label': `Delete ${rc.name}`, onclick: del }, icon('trash', 'sm'), 'Delete')));
    };

    // a new recipe: typed here, added with the button (an empty recipe is never saved)
    const d = state.recDraft;
    const newName = h('input', { type: 'text', id: 'rc-new-n', value: d.name, maxlength: lim.name, autocomplete: 'off', 'data-fkey': 'rc-new' });
    const newPrompt = h('textarea', { id: 'rc-new-p', rows: 5, maxlength: lim.prompt, 'aria-describedby': 'rc-help',
      placeholder: 'For example: Find 5 hook angles for a video about "{{title}}".' });
    newPrompt.value = d.prompt;
    newName.addEventListener('input', () => { d.name = newName.value; });
    newPrompt.addEventListener('input', () => { d.prompt = newPrompt.value; });
    const newErr = h('p', { class: 'err', role: 'alert' });
    const full = list.length >= lim.count;
    const addForm = full
      ? h('p', { class: 'muted', text: `You have ${lim.count} recipes, the most the vault keeps. Delete one to add another.` })
      : h('form', { class: 'card rcard', 'aria-labelledby': 'rc-new-t', onsubmit: async (e) => {
        e.preventDefault();
        newErr.textContent = '';
        const name = newName.value.replace(/\s+/g, ' ').trim();
        const prompt = newPrompt.value.trim();
        if (!name) { newErr.textContent = 'Give the recipe a name.'; newName.focus(); return; }
        if (!prompt) { newErr.textContent = 'Write the instruction.'; newPrompt.focus(); return; }
        let out;
        try { out = (await api('POST', '/api/recipes', { name, prompt })).recipe; } catch (x) { newErr.textContent = x.message; return; }
        state.recDraft = { name: '', prompt: '' };
        toast('Recipe added');
        await rerender([`rcname:${out.id}`]);
      } },
      h('h2', { class: 'subh', id: 'rc-new-t', text: 'New recipe' }),
      h('label', { class: 'lbl', for: 'rc-new-n', text: 'Name' }), newName,
      h('label', { class: 'lbl', for: 'rc-new-p', text: 'Instruction' }), newPrompt,
      newErr,
      h('div', { class: 'btnrow' }, h('button', { type: 'submit', class: 'btn primary' }, icon('plus', 'sm'), 'Add recipe')));

    main.append(h('div', { class: 'phead' }, h('h1', { text: 'Prompt recipes' }), h('span', { class: 'scount', text: plural(list.length, 'recipe') })),
      h('p', { class: 'psub', text: 'Instructions to copy along with a collection. In a collection, choose Copy with… and pick one.' }),
      h('p', { class: 'dhint rhelp', id: 'rc-help', text: 'Use {{title}} to insert the collection\'s title. Changes save by themselves.' }),
      h('div', { class: 'recipes' }, list.length ? list.map(card) : h('p', { class: 'muted', text: 'No recipes yet. Add one below.' }), addForm));
    if (focusKeys) focusFirst(focusKeys);
  }

  // ---------- security ----------
  const EVENT_TEXT = {
    login_ok: 'Signed in', login_failed: 'Wrong password', login_locked: 'Sign-in blocked (too many attempts)',
    password_ok: 'Password accepted, waiting for code', code_failed: 'Wrong two-step code', mfa_enabled: 'Two-step sign-in turned on',
    mfa_setup_failed: 'Two-step setup code did not match', mfa_reset: 'Two-step sign-in reset on the server',
    recovery_code_used: 'Recovery code used', recovery_codes_renewed: 'New recovery codes made',
    pair_code_created: 'Pairing code created', device_paired: 'Device paired', pair_failed: 'Wrong pairing code',
    device_removed: 'Device removed', device_organize_changed: 'Phone organizing changed', phone_organized: 'Phone changed the vault', session_ended: 'Signed a browser out', trusted_browser_removed: 'Browser no longer trusted',
    browser_remembered: 'Computer kept signed in for 30 days',
    bundle_deleted: 'Bundle deleted', bundle_combined: 'Merged items combined',
    device_key_created: 'Claude key created', mcp_call: 'Claude read the vault',
    oauth_consent_granted: 'App connected', oauth_consent_denied: 'App connection refused',
    oauth_consent_refused: 'App connection page expired or changed', oauth_grant_removed: 'Connected app removed',
    oauth_code_reuse: 'Connected app removed (sign-in code used twice)', oauth_refresh_reuse: 'Connected app removed (old sign-in token used again)',
    oauth_grant_expired: 'Connected app removed (unused for 30 days)',
    app_update_downloaded: 'App update downloaded',
  };
  const shortUa = (ua) => {
    const s = String(ua || '');
    const b = /Edg\//.test(s) ? 'Edge' : /SamsungBrowser/.test(s) ? 'Samsung Internet' : /Chrome\//.test(s) ? 'Chrome' : /Firefox\//.test(s) ? 'Firefox' : /Safari\//.test(s) ? 'Safari' : (s.split(' ')[0] || 'Unknown');
    const os = /Android/.test(s) ? 'Android' : /Windows/.test(s) ? 'Windows' : /Mac OS/.test(s) ? 'macOS' : /iPhone|iPad/.test(s) ? 'iOS' : /Linux/.test(s) ? 'Linux' : '';
    return os ? `${b} on ${os}` : b;
  };

  function accordion(key, title, chip, ...body) {
    const d = h('details', { class: 'card acc', open: state.secOpen[key] || null },
      h('summary', {}, h('h2', { text: title }), chip, h('span', { class: 'grow' }), icon('chevdown', 'chev')),
      h('div', { class: 'accbody' }, ...body));
    d.addEventListener('toggle', () => { state.secOpen[key] = d.open; });
    return d;
  }

  async function renderSecurity() {
    const seq = ++state.secSeq;
    const main = shell();
    const [me, dv, au, og] = await Promise.all([api('GET', '/api/me'), api('GET', '/api/devices'), api('GET', '/api/audit?days=30'), api('GET', '/api/oauth/grants')]);
    // a newer render (or another view) wins; never stack two copies of the page
    if (seq !== state.secSeq || state.tab !== 'security' || state.merge || !document.body.contains(main)) return;
    clear(main);
    const rerender = () => { if (state.tab === 'security' && !state.merge) renderSecurity().catch((x) => toast(x.message, true)); };

    // two-step sign-in: one code box serves both actions
    const code = h('input', { id: 'curcode', class: 'codein', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, placeholder: '000000', 'aria-describedby': 'codeerr' });
    const codeErr = h('p', { class: 'err', id: 'codeerr', role: 'alert' });
    const needCode = () => {
      codeErr.textContent = '';
      if (!/^\d{6}$/.test(code.value.trim())) { codeErr.textContent = 'Type the 6-digit code from your authenticator app first.'; code.focus(); return null; }
      return code.value.trim();
    };
    const mfa = accordion('mfa', 'Two-step sign-in', h('span', { class: `chip ${me.mfa_enabled ? 'ok' : 'bad'}`, text: me.mfa_enabled ? 'On' : 'Off' }),
      h('p', { class: 'lead', text: 'A code from your phone is needed after the password, so a leaked password alone can\'t open your vault.' }),
      me.mfa_enabled ? h('p', {}, h('span', { class: `chip ${me.recovery_left > 2 ? 'gold' : 'bad'}` }, icon('key', 'xs'), `${me.recovery_left} of 8 recovery codes left`)) : null,
      me.via_recovery ? h('div', { class: 'paircard' },
        h('p', { text: 'You signed in with a recovery code. If you lost your phone, set up the authenticator again now.' }),
        h('button', { type: 'button', class: 'btn primary', text: 'Set up on a new phone', onclick: () => showMfaSetup() })) : null,
      // a form, so Enter after the code makes new recovery codes (the non-destructive action)
      h('form', { onsubmit: async (e) => {
        e.preventDefault();
        const c = needCode(); if (!c) return;
        try { const r = await api('POST', '/api/mfa/recovery', { code: c }); showRecoveryCodes(r.recovery_codes, false); } catch (x) { codeErr.textContent = x.message; }
      } },
      h('label', { class: 'lbl', for: 'curcode', text: 'Current authenticator code' }), code, codeErr,
      h('div', { class: 'btnrow' },
        h('button', { type: 'submit', class: 'btn', text: 'New recovery codes' }),
        h('button', { type: 'button', class: 'btn', text: 'Move to a new phone', onclick: () => { const c = needCode(); if (c) showMfaSetup(c); } }))));

    // phones
    const pairOut = h('div');
    const pairBtn = h('button', { type: 'button', class: 'btn', onclick: async () => {
      let p;
      try { p = await api('POST', '/api/devices', { scopes: 'capture' }); } catch (x) { toast(x.message, true); return; }
      clear(pairOut);
      const left = h('span', { class: 'muted small' });
      const tick = () => {
        const s = p.expires_at - Math.floor(Date.now() / 1000);
        left.textContent = s > 0 ? `Expires in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : 'Expired. Make a new one.';
        if (s > 0 && document.body.contains(left)) setTimeout(tick, 1000);
      };
      // the code is announced once; the ticking countdown sits outside the live region
      pairOut.append(h('div', { class: 'paircard' },
        h('div', { role: 'status' },
          h('p', { text: 'In the Vault app on your phone, enter this code:' }),
          h('p', { class: 'paircode mono', text: `${p.code.slice(0, 3)} ${p.code.slice(3)}` })),
        left));
      tick();
    } }, icon('plus', 'sm'), 'Pair a phone');
    const scopeLabel = (s) => {
      const set = new Set(String(s).split(','));
      if (set.has('organize')) return 'Save and organize';
      return s === 'capture' ? 'Save only' : s === 'read' ? 'Read only' : s === 'capture,read' ? 'Save and read' : s;
    };
    // "Allow organizing": turning it on asks first, turning it off is immediate
    const organizeSwitch = (d) => {
      const id = `org-${d.id}`;
      const sw = h('input', { type: 'checkbox', id, role: 'switch', checked: String(d.scopes).split(',').includes('organize') });
      sw.addEventListener('change', async () => {
        const want = sw.checked;
        if (want && !await confirmBox({ title: `Let ${d.name} organize?`, body: 'It will be able to merge, tag, archive and move things to Trash. It still cannot delete for good or change Security settings.', ok: 'Allow organizing' })) { sw.checked = false; return; }
        sw.disabled = true;
        try { await api('PATCH', `/api/devices/${d.id}`, { organize: want }); toast(want ? 'This phone can now organize' : 'This phone can only save now'); } catch (x) { toast(x.message, true); }
        rerender();
      });
      return h('label', { class: 'switch devswitch', for: id }, 'Allow organizing', sw, h('span', { class: 'track', 'aria-hidden': 'true' }));
    };
    const live = dv.devices.filter((d) => !d.revoked_at).length;
    const phones = accordion('phones', 'Paired phones and keys', live ? h('span', { class: 'chip ok', text: plural(live, 'phone') }) : null,
      h('p', { class: 'lead', text: 'A paired phone can save things. With "Allow organizing" on, it can also merge, tag, archive and trash. A Claude key can only read.' }),
      dv.devices.length ? dv.devices.map((d) => h('div', { class: `devrow${d.revoked_at ? ' gone' : ''}` },
        h('span', { class: 'dicon' }, icon('phone')),
        h('div', {}, h('div', { class: 'dname', text: d.name }),
          h('div', { class: 'dmeta' },
            h('span', { class: 'c-teal', text: scopeLabel(d.scopes) }),
            h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', { text: `Paired ${ago(d.created_at)}` }),
            h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', { text: d.revoked_at ? 'Removed' : d.last_used_at ? `Last used ${ago(d.last_used_at)}` : 'Never used' })),
          !d.revoked_at && String(d.scopes).split(',').includes('capture') ? organizeSwitch(d) : null),
        d.revoked_at ? h('span') : moreBtn(d.name, () => [{ label: d.scopes === 'read' ? 'Remove key' : 'Remove phone', icon: 'trash', danger: true, onClick: async () => {
          const key = d.scopes === 'read';
          if (!await confirmBox({ title: `Remove ${d.name}?`, body: key ? 'Claude stops being able to read your vault with this key at once.' : 'It will need to pair again before it can save to your vault.', ok: key ? 'Remove key' : 'Remove phone', danger: true })) return;
          try { await api('DELETE', `/api/devices/${d.id}`); toast(key ? 'Key removed' : 'Phone removed'); } catch (x) { toast(x.message, true); }
          rerender();
        } }]))) : h('p', { class: 'muted', text: 'No phones paired yet.' }),
      h('div', { class: 'btnrow' }, pairBtn), pairOut);

    // Connect Claude: a read-only key for the MCP endpoint, shown once
    const mcpUrl = `${location.origin}/mcp`;
    const keyName = h('input', { type: 'text', id: 'keyname', value: 'Claude Code', maxlength: 60, autocomplete: 'off' });
    const keyErr = h('p', { class: 'err', id: 'keyerr', role: 'alert' });
    const keyOut = h('div');
    const keyBtn = h('button', { type: 'submit', class: 'btn' }, icon('key', 'sm'), 'Create key');
    const claude = accordion('claude', 'Connect Claude', h('span', { class: 'chip gold', text: 'Read only' }),
      h('p', { class: 'lead', text: 'Let Claude read your collections and saved items directly, without SSH. It can only read: it cannot save, change or delete anything. For Claude Code, make a key here. For claude.ai, add a custom connector (below).' }),
      h('form', { onsubmit: async (e) => {
        e.preventDefault();
        keyErr.textContent = '';
        keyBtn.disabled = true;
        let r;
        try { r = await api('POST', '/api/devices/key', { name: keyName.value.trim() || 'Claude Code' }); } catch (x) { keyErr.textContent = x.message; keyBtn.disabled = false; return; }
        keyBtn.disabled = false;
        const cmd = `claude mcp add --transport http vault ${mcpUrl} --header "Authorization: Bearer ${r.token}"`;
        clear(keyOut);
        keyOut.append(h('div', { class: 'paircard', role: 'status' },
          h('p', { class: 'keywarn', text: `Key for ${r.name}. It is shown only once: copy it now.` }),
          h('pre', { class: 'keybox mono', text: r.token }),
          h('div', { class: 'btnrow' }, h('button', { type: 'button', class: 'btn', onclick: () => copyText(r.token, 'key') }, icon('copy', 'sm'), 'Copy key')),
          h('p', { text: 'Then paste this in a terminal on your computer:' }),
          h('pre', { class: 'keybox mono', text: cmd }),
          h('div', { class: 'btnrow' }, h('button', { type: 'button', class: 'btn primary', onclick: () => copyText(cmd, 'command') }, icon('copy', 'sm'), 'Copy command')),
          h('p', { class: 'muted small', text: 'Anyone with this key can read your vault. You can remove it any time under Paired phones and keys (it shows there the next time you open this page).' })));
      } },
      h('label', { class: 'lbl', for: 'keyname', text: 'Name for the key' }), keyName, keyErr,
      h('div', { class: 'btnrow' }, keyBtn)),
      keyOut,
      // claude.ai (web, desktop app, phone): a custom connector that signs in here with OAuth, no key
      h('h3', { class: 'subh', text: 'claude.ai, Claude desktop and the Claude phone app' }),
      h('ol', { class: 'steps' },
        h('li', { text: 'In Claude, open Customize, then Connectors, then Add custom connector.' }),
        h('li', {}, 'Paste this address: ', h('code', { class: 'mono', text: mcpUrl }), ' ',
          h('button', { type: 'button', class: 'tbtn', onclick: () => copyText(mcpUrl, 'address') }, 'Copy')),
        h('li', { text: 'Leave the client ID and client secret empty, then choose Add and Connect.' }),
        h('li', { text: 'This page opens: sign in if asked, check the app, then choose Allow.' })),
      h('h3', { class: 'subh', text: 'Connected apps' }),
      og.grants.length ? og.grants.map((g) => h('div', { class: 'devrow' },
        h('span', { class: 'dicon' }, icon('key')),
        h('div', {}, h('div', { class: 'dname', text: g.name }),
          h('div', { class: 'dmeta' },
            h('span', { class: 'c-teal', text: g.returns_to === 'claude.ai' ? 'claude.ai' : 'This computer' }),
            h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', { text: `Connected ${ago(g.created_at)}` }),
            h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', { text: g.last_used_at ? `Last used ${ago(g.last_used_at)}` : 'Never used' }))),
        moreBtn(g.name, () => [{ label: 'Remove app', icon: 'trash', danger: true, onClick: async () => {
          if (!await confirmBox({ title: `Remove ${g.name}?`, body: 'It stops being able to read your vault at once. To use it again, connect it again from Claude.', ok: 'Remove app', danger: true })) return;
          try { await api('DELETE', `/api/oauth/grants/${g.id}`); toast('App removed'); } catch (x) { toast(x.message, true); }
          rerender();
        } }]))) : h('p', { class: 'muted', text: 'No apps connected yet.' }));

    // browsers
    const browsers = accordion('browsers', 'Signed-in browsers', h('span', { class: 'chip ok', text: `${plural(dv.sessions.length, 'active browser')}` }),
      me.remembered
        ? h('p', { class: 'lead', text: 'This computer stays signed in. The 30 days restart each time you open the vault.' })
        : h('div', {},
          h('p', { class: 'lead', text: 'This computer signs out after 12 hours.' }),
          h('button', { type: 'button', class: 'btn', text: 'Keep this computer signed in for 30 days', onclick: async () => {
            try { await api('POST', '/api/me/remember', {}); toast('This computer stays signed in for 30 days'); } catch (x) { toast(x.message, true); }
            rerender();
          } })),
      dv.sessions.map((s) => h('div', { class: 'devrow' },
        h('span', { class: 'dicon' }, icon('monitor')),
        h('div', {}, h('div', { class: 'dname', text: `${shortUa(s.user_agent)}${s.current ? ' (this one)' : ''}` }),
          h('div', { class: 'dmeta' }, s.trusted ? h('span', { class: 'c-teal', text: 'Remembered' }) : null, s.trusted ? h('span', { class: 'dot', 'aria-hidden': 'true' }) : null,
            h('span', { text: s.ip || 'Unknown address' }), h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', { text: `Active ${ago(s.last_seen_at)}` }))),
        s.current ? h('span', { class: 'chip ok', text: 'This browser' }) : moreBtn(shortUa(s.user_agent), () => [{ label: 'Sign out this browser', icon: 'logout', danger: true, onClick: async () => {
          try { await api('DELETE', `/api/sessions/${s.id}`); toast('Signed out'); } catch (x) { toast(x.message, true); }
          rerender();
        } }]))),
      h('h3', { class: 'subh', text: 'Trusted for 30 days (no code needed)' }),
      dv.trusted.length ? dv.trusted.map((t) => h('div', { class: 'devrow' },
        h('span', { class: 'dicon' }, icon('shield')),
        h('div', {}, h('div', { class: 'dname', text: shortUa(t.user_agent) }),
          h('div', { class: 'dmeta' }, h('span', { text: t.ip || '' }), h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', { text: `Until ${new Date(t.expires_at * 1000).toISOString().slice(0, 10)}` }))),
        moreBtn(shortUa(t.user_agent), () => [{ label: 'Forget this browser', icon: 'trash', danger: true, onClick: async () => {
          try { await api('DELETE', `/api/trusted/${t.id}`); toast('Browser forgotten'); } catch (x) { toast(x.message, true); }
          rerender();
        } }])))
        : h('p', { class: 'muted', text: 'None.' }));

    // activity
    const activity = accordion('activity', 'Recent activity', h('span', { class: 'chip gold', text: 'Last 30 days' }),
      au.events.length ? h('ul', { class: 'loglist' }, au.events.map((e) => h('li', { class: e.ok ? '' : 'bad' },
        h('span', { class: 'muted', title: when(e.at), text: ago(e.at) }),
        h('span', { class: 'what' }, e.ok ? null : h('span', { class: 'sr', text: 'Failed: ' }), EVENT_TEXT[e.event] || e.event),
        h('span', { class: 'where', text: [e.ip, e.user_agent ? shortUa(e.user_agent) : null, e.detail].filter(Boolean).join(' · ') }))))
        : h('p', { class: 'muted', text: 'Nothing yet.' }));

    main.append(h('div', { class: 'phead' }, h('h1', { text: 'Security' })),
      h('p', { class: 'psub', text: 'Manage sign-in and connected devices.' }),
      mfa, phones, claude, browsers, activity);
  }

  // ---------- voice notes (server/src/voice.js) ----------
  // Record here (or on the phone), and the server transcribes the audio (Groq Whisper) and writes the notes
  // (Claude). A recording is kept in IndexedDB piece by piece while it runs, so a closed tab doesn't lose it.
  const VOICE_MAX_S = 90 * 60;
  const VOICE_WARN_S = 85 * 60;
  const VOICE_BUSY = new Set(['uploading', 'transcribing', 'writing']);
  const VOICE_STATUS = {
    uploading: ['wait', 'Uploading'], transcribing: ['wait', 'Transcribing'], writing: ['wait', 'Writing notes'],
    ready: ['ok', 'Ready'], failed: ['bad', 'Needs attention'],
  };
  const PASS_PRESETS = [
    ['Email', 'Write this up as a clear email to my team: the context, what was decided, and who does what next.'],
    ['Thread', 'Turn the strongest idea in this note into an X thread of 6-9 posts, in my voice, with a hook first.'],
    ['Video outline', 'Turn this into a YouTube video outline: a title-question hook, the setup, 3-6 sections with the key point and an example each, and the payoff.'],
    ['To-dos by priority', 'List only the things to do, grouped by priority, each with the reason it matters and the first concrete step.'],
    ['Decisions memo', 'Write a one-page decision memo: the question, the options I considered, what I chose and why, and what is still open.'],
  ];
  const durText = (s) => { const m = Math.floor((s || 0) / 60); const sec = Math.floor((s || 0) % 60); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : m ? `${m} min${sec && m < 10 ? ` ${sec} s` : ''}` : `${sec} s`; };
  const clockText = (s) => { const t = Math.max(0, Math.floor(s)); const hh = Math.floor(t / 3600); const mm = String(Math.floor((t % 3600) / 60)).padStart(2, '0'); const ss = String(t % 60).padStart(2, '0'); return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`; };
  const markSecs = (m) => { const p = m.split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };
  const MARK_RE = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g;

  // Text with [mm:ss] marks turned into buttons that seek the note's player.
  function withMarks(text, seek) {
    const out = [];
    let last = 0;
    for (const m of String(text).matchAll(MARK_RE)) {
      if (m.index > last) out.push(inlineMd(text.slice(last, m.index)));
      out.push(seek ? h('button', { type: 'button', class: 'vn-mark', title: `Play from ${m[1]}`, text: m[1], onclick: () => seek(markSecs(m[1])) }) : m[0]);
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push(inlineMd(text.slice(last)));
    return out;
  }
  // **bold**, *italic* and `code`, as elements (never innerHTML)
  function inlineMd(s) {
    const out = [];
    const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g;
    let last = 0;
    for (const m of s.matchAll(re)) {
      if (m.index > last) out.push(s.slice(last, m.index));
      const t = m[0];
      out.push(t.startsWith('**') ? h('strong', { text: t.slice(2, -2) }) : t.startsWith('`') ? h('code', { text: t.slice(1, -1) }) : h('em', { text: t.slice(1, -1) }));
      last = m.index + t.length;
    }
    if (last < s.length) out.push(s.slice(last));
    return out;
  }
  // A small Markdown reader for notes and passes: headings, bullet and numbered lists, checkboxes, quotes,
  // paragraphs. Built with elements and text nodes only.
  function mdView(md, seek) {
    const root = h('div', { class: 'vn-md' });
    let list = null;
    let para = [];
    const flush = () => { if (para.length) { root.append(h('p', {}, withMarks(para.join(' '), seek))); para = []; } };
    for (const raw of String(md || '').split('\n')) {
      const line = raw.replace(/\s+$/, '');
      let m;
      if (!line.trim()) { flush(); list = null; continue; }
      if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
        flush(); list = null;
        root.append(h(`h${Math.min(6, Math.max(3, m[1].length + 1))}`, {}, withMarks(m[2], seek)));
      } else if ((m = /^\s*[-*+]\s+(?:\[( |x)\]\s+)?(.*)$/.exec(line)) || (m = /^\s*(\d+)[.)]\s+(.*)$/.exec(line))) {
        flush();
        const ordered = /^\s*\d/.test(line);
        if (!list || list.tagName !== (ordered ? 'OL' : 'UL')) { list = h(ordered ? 'ol' : 'ul'); root.append(list); }
        const box = !ordered && m[1] !== undefined ? h('span', { class: 'vn-box', 'aria-hidden': 'true', text: m[1] === 'x' ? '☑ ' : '☐ ' }) : null;
        list.append(h('li', {}, box, withMarks(m[2], seek)));
      } else if ((m = /^>\s?(.*)$/.exec(line))) {
        flush(); list = null;
        root.append(h('blockquote', {}, withMarks(m[1], seek)));
      } else {
        list = null;
        para.push(line.trim());
      }
    }
    flush();
    return root;
  }

  // ---- IndexedDB: recordings that were not uploaded yet ----
  const vdb = {
    open() {
      return new Promise((res, rej) => {
        let r;
        try { r = indexedDB.open('tv-voice', 1); } catch (e) { rej(e); return; }
        r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('recs', { keyPath: 'id' }); d.createObjectStore('parts', { autoIncrement: true }).createIndex('rec', 'rec'); };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    },
    async run(stores, mode, fn) {
      const d = await this.open();
      return new Promise((res, rej) => {
        const t = d.transaction(stores, mode);
        let out;
        t.oncomplete = () => { d.close(); res(out); };
        t.onerror = () => { d.close(); rej(t.error); };
        out = fn(t);
      });
    },
    putRec(rec) { return this.run(['recs'], 'readwrite', (t) => { t.objectStore('recs').put(rec); }).catch(() => {}); },
    addPart(rec, blob) { return this.run(['parts'], 'readwrite', (t) => { t.objectStore('parts').add({ rec, blob }); }).catch(() => {}); },
    async list() {
      try {
        const recs = await this.run(['recs'], 'readonly', (t) => { const q = t.objectStore('recs').getAll(); return q; });
        return (recs && recs.result) || [];
      } catch { return []; }
    },
    async blob(rec) {
      const r = await this.run(['parts'], 'readonly', (t) => t.objectStore('parts').index('rec').getAll(rec.id));
      return new Blob(((r && r.result) || []).map((p) => p.blob), { type: rec.mime });
    },
    async drop(id) {
      try {
        await this.run(['recs', 'parts'], 'readwrite', (t) => {
          t.objectStore('recs').delete(id);
          const idx = t.objectStore('parts').index('rec');
          idx.openKeyCursor(IDBKeyRange.only(id)).onsuccess = (e) => { const c = e.target.result; if (c) { t.objectStore('parts').delete(c.primaryKey); c.continue(); } };
        });
      } catch { /* storage blocked */ }
    },
  };

  // ---- upload: start, pieces (resumable), finish ----
  async function uploadVoice(blob, { mime, duration, title, clientId, onProgress }) {
    const start = await api('POST', '/api/voice', { source: 'web', mime, bytes: blob.size, duration_s: Math.max(1, Math.round(duration)), title: title || undefined, client_id: clientId });
    // this recording was already sent and finished (another tab, an earlier try): nothing left to send
    if (start.status && start.status !== 'uploading') return start;
    let off = start.received || 0;
    const size = start.chunk_size || 512 * 1024;
    let fails = 0;
    while (off < blob.size) {
      try {
        const res = await fetch(`/api/voice/${start.id}/chunk?offset=${off}`, {
          method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }, body: blob.slice(off, off + size),
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 409 && data.error === 'offset_mismatch') {
          // the server has a different amount: ask it again by resending the start (same client id)
          const again = await api('POST', '/api/voice', { source: 'web', mime, bytes: blob.size, duration_s: Math.max(1, Math.round(duration)), client_id: clientId });
          if (again.status && again.status !== 'uploading') return again;
          off = again.received || 0;
          continue;
        }
        // another piece of this note is on its way (a second tab): wait and look again
        if (res.status === 409 && data.error === 'busy') throw Object.assign(new Error(data.message || 'Busy'), { status: 503 });
        if (!res.ok) throw Object.assign(new Error(data.message || `Upload failed (${res.status})`), { status: res.status });
        if (data.complete) return api('GET', '/api/voice').then((l) => l.notes.find((n) => n.id === start.id) || { id: start.id, status: 'transcribing' });
        if (!(data.received > off)) throw Object.assign(new Error('The upload is not moving'), { status: 503 });
        off = data.received;
        fails = 0;
        if (onProgress) onProgress(off / blob.size);
      } catch (e) {
        if (e.status && e.status < 500 && e.status !== 429) throw e;
        if (++fails > 5) throw new Error('The upload keeps failing. The recording is kept in this browser; try again later.');
        await new Promise((r) => setTimeout(r, 1500 * fails));
      }
    }
    return api('POST', `/api/voice/${start.id}/finish`, {});
  }

  // ---- the recorder (one at a time, kept outside the page so a refresh of the list never stops it) ----
  const rec = { on: false };
  const sending = new Set();      // recordings (by client id) being uploaded right now: not offered again
  const passDrafts = new Map();   // note id -> a half-typed "Another pass" prompt, kept across refreshes
  const passTab = new Map();      // note id -> the tab to open on its next rebuild (a pass just started)
  function pickMime() {
    const list = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'];
    if (typeof MediaRecorder === 'undefined') return null;
    return list.find((m) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || '';
  }
  async function startRecording(title) {
    // a double click must not start two recorders on one recording (set before the permission prompt)
    if (rec.on || rec.starting) return;
    const mime = pickMime();
    if (mime === null) { toast('This browser cannot record audio. Use the phone app instead.', true); return; }
    rec.starting = true;
    let stream;
    let mr;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      mr = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 16000 });
    } catch (e) {
      rec.starting = false;
      if (stream) stream.getTracks().forEach((t) => t.stop());
      toast(stream ? 'This browser could not start recording.' : 'The microphone is blocked. Allow it for this site in the browser, then try again.', true);
      return;
    }
    rec.starting = false;
    const id = uuid();
    mr.ondataavailable = (e) => { if (e.data && e.data.size) { rec.parts.push(e.data); vdb.addPart(id, e.data); } };
    mr.onstop = () => finishRecording();
    try {
      mr.start(10_000);   // a piece every 10 s, so at most 10 s is lost if the tab dies
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      toast('This browser could not start recording.', true);
      return;
    }
    Object.assign(rec, { on: true, paused: false, stream, mr, mime: (mr.mimeType || mime || 'audio/webm').split(';')[0], parts: [], title: title || '',
      id, startedAt: Date.now(), elapsed: 0, segStart: Date.now(), warned: false, level: 0, savedAt: 0 });
    vdb.putRec({ id, mime: rec.mime, title: rec.title, created: Date.now(), updated: Date.now(), duration: 0 });
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      rec.ac = new AC();
      const an = rec.ac.createAnalyser();
      an.fftSize = 512;
      rec.ac.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(an.fftSize);
      rec.meter = setInterval(() => {
        an.getByteTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        rec.level = Math.min(1, peak / 64);
      }, 100);
    } catch { /* no level meter */ }
    rec.tick = setInterval(voiceTick, 250);
    window.addEventListener('beforeunload', recLeaveGuard);
    paintRecorder();
  }
  const recSeconds = () => (rec.on ? rec.elapsed + (rec.paused ? 0 : (Date.now() - rec.segStart) / 1000) : 0);
  function recLeaveGuard(e) { if (rec.on) { e.preventDefault(); e.returnValue = ''; } }
  function voiceTick() {
    const s = recSeconds();
    if (s >= VOICE_WARN_S && !rec.warned) { rec.warned = true; toast('5 minutes left: voice notes stop at 90 minutes.'); }
    if (s >= VOICE_MAX_S) { stopRecording(); return; }
    // every 5 s: the length, and a heartbeat that tells other tabs this recording is still live
    if (Date.now() - rec.savedAt > 5000) {
      rec.savedAt = Date.now();
      vdb.putRec({ id: rec.id, mime: rec.mime, title: rec.title, created: rec.startedAt, updated: Date.now(), duration: Math.round(s) });
    }
    const t = document.getElementById('vn-clock');
    if (t) t.textContent = clockText(s);
    const lv = document.getElementById('vn-level');
    if (lv) lv.style.setProperty('--lv', String(rec.paused ? 0 : rec.level));
  }
  function pauseRecording() {
    if (!rec.on) return;
    if (rec.paused) { rec.mr.resume(); rec.paused = false; rec.segStart = Date.now(); } else { rec.mr.pause(); rec.paused = true; rec.elapsed += (Date.now() - rec.segStart) / 1000; }
    paintRecorder();
  }
  function stopRecording() {
    if (!rec.on || rec.stopping) return;
    rec.stopping = true;
    rec.duration = recSeconds();
    try { rec.mr.stop(); } catch { finishRecording(); }
  }
  async function finishRecording() {
    clearInterval(rec.tick); clearInterval(rec.meter);
    try { rec.stream.getTracks().forEach((t) => t.stop()); } catch { /* already stopped */ }
    try { rec.ac && rec.ac.close(); } catch { /* closed */ }
    window.removeEventListener('beforeunload', recLeaveGuard);
    const blob = new Blob(rec.parts, { type: rec.mime });
    // stopped by itself (the mic went away): no Stop press measured the length, so measure it now
    const job = { id: rec.id, mime: rec.mime, title: rec.title, duration: rec.duration ?? recSeconds() };
    Object.keys(rec).forEach((k) => delete rec[k]);
    rec.on = false;
    paintRecorder();
    if (!blob.size) { vdb.drop(job.id); toast('Nothing was recorded.', true); return; }
    await sendRecording(blob, job);
  }
  // the upload under way, shown in the recorder card as step 1 of the progress steps
  let sendState = null;
  function showSendProgress(frac) {
    if (!sendState) return;
    sendState.frac = frac;
    const pct = document.getElementById('vn-send-pct');
    if (pct) pct.textContent = `${Math.round(frac * 100)}%`;
    const bar = document.getElementById('vn-send-bar');
    if (bar) bar.value = frac;
  }
  async function sendRecording(blob, job) {
    if (sending.has(job.id)) return;
    sending.add(job.id);
    sendState = { frac: 0, duration: job.duration };
    paintRecorder();
    try {
      const r = await uploadVoice(blob, { mime: job.mime, duration: job.duration, title: job.title, clientId: job.id, onProgress: showSendProgress });
      await vdb.drop(job.id);
      sendState = null;
      toast('Sent. Transcribing now.');
      // straight to the note's page, where the steps carry on (Transcribing, Writing notes, Ready)
      if (state.tab === 'voice') go({ tab: 'voice', voiceId: r.id });
    } catch (e) {
      sendState = null;
      toast(e.message || 'Sending failed. The recording is kept in this browser.', true);
      if (state.tab === 'voice' && !state.voiceId) route();
    } finally {
      sending.delete(job.id);
      sendState = null;
      paintRecorder();
    }
  }

  // Sending → Transcribing → Writing notes → Ready, with the current step marked (and failed in red).
  const VOICE_STEPS = ['Sending', 'Transcribing', 'Writing notes', 'Ready'];
  function voiceSteps(status, { failedStage = null, pct = null, compact = false } = {}) {
    const at = { uploading: 0, transcribing: 1, writing: 2, ready: 3 }[status] ?? (failedStage === 'notes' ? 2 : 1);
    const failed = status === 'failed';
    return h('ol', { class: `vn-steps${compact ? ' compact' : ''}`, 'aria-label': 'Progress' },
      VOICE_STEPS.map((label, i) => {
        const cls = i < at || (status === 'ready' && i === at) ? 'done' : i === at ? (failed ? 'fail' : 'now') : 'todo';
        const what = cls === 'done' ? 'done' : cls === 'now' ? 'in progress' : cls === 'fail' ? 'failed' : 'not yet';
        return h('li', { class: cls, 'aria-current': cls === 'now' ? 'step' : null },
          h('span', { class: 'vn-stepdot', 'aria-hidden': 'true' }, cls === 'done' ? icon('check', 'xs') : cls === 'fail' ? icon('x', 'xs') : null),
          h('span', { class: 'vn-steplabel' }, label, i === 0 && pct !== null && cls === 'now' ? h('span', { id: 'vn-send-pct', text: ` ${pct}%` }) : null),
          h('span', { class: 'sr', text: ` (${what})` }));
      }));
  }

  function paintRecorder() {
    const box = document.getElementById('vn-rec');
    if (!box) return;
    clear(box);
    if (!rec.on && sendState) {
      box.append(h('div', { role: 'status' },
        h('p', { class: 'vn-sendhead', text: `Sending your recording (${durText(sendState.duration)})…` }),
        voiceSteps('uploading', { pct: Math.round(sendState.frac * 100) }),
        h('progress', { id: 'vn-send-bar', max: 1, value: sendState.frac, 'aria-label': 'Sending progress' }),
        h('p', { class: 'small muted', text: 'Keep this tab open until it is sent. If it fails, the recording stays in this browser and you can send it again.' })));
      return;
    }
    if (!rec.on) {
      const title = h('input', { type: 'text', id: 'vn-title', maxlength: 200, placeholder: 'Title (optional: the notes give it one)', autocomplete: 'off' });
      box.append(
        h('div', { class: 'vn-recrow' },
          h('button', { type: 'button', class: 'btn primary vn-recbtn', onclick: () => startRecording(title.value.trim()) }, icon('mic', 'sm'), 'Record'),
          h('label', { for: 'vn-title', class: 'sr', text: 'Title' }), title),
        h('p', { class: 'small muted', text: 'Up to 90 minutes. The title is optional. The audio is kept at 16 kbps (about 11 MB for 90 minutes) and backed up with the vault.' }));
      return;
    }
    box.append(h('div', { class: 'vn-recrow live' },
      h('span', { class: `vn-dot${rec.paused ? ' paused' : ''}`, 'aria-hidden': 'true' }),
      h('span', { id: 'vn-clock', class: 'vn-clock', role: 'timer', 'aria-label': 'Recording time', text: clockText(recSeconds()) }),
      h('span', { id: 'vn-level', class: 'vn-level', 'aria-hidden': 'true' }),
      h('span', { class: 'small muted', text: rec.paused ? 'Paused' : 'Recording' }),
      h('span', { class: 'vn-grow' }),
      h('button', { type: 'button', class: 'btn', onclick: pauseRecording, text: rec.paused ? 'Resume' : 'Pause' }),
      h('button', { type: 'button', class: 'btn primary', onclick: stopRecording, text: 'Stop and send' })));
  }

  function voiceChip(v) {
    const [cls, label] = VOICE_STATUS[v.status] || ['low', v.status];
    return h('span', { class: `chip ${cls}`, text: label });
  }

  async function renderVoice() {
    if (state.voiceId) return renderVoiceNote(state.voiceId);
    const prev = state.view;
    let v = prev;
    if (!(prev && prev.kind === 'voice' && document.body.contains(prev.list))) {
      const main = shell();
      const head = pageHead('Voice notes', '');
      const recBox = h('section', { class: 'card vn-recorder', id: 'vn-rec', 'aria-label': 'Record a voice note' });
      const info = h('div');
      const pending = h('div');
      const list = h('div', { class: 'cards' });
      main.append(head.el, h('p', { class: 'psub', text: 'Talk it through. You get a transcript, detailed notes, action items and decisions, and you can run your own prompts on it.' }),
        recBox, pending, info, list);
      v = state.view = { kind: 'voice', head, list, info, pending };
      paintRecorder();
    }
    const r = await api('GET', '/api/voice');
    if (state.view !== v) return;
    v.head.count.textContent = plural(r.notes.length, 'note');
    clear(v.info);
    const u = r.usage;
    if (u && (!u.transcribe || !u.notes)) {
      v.info.append(h('div', { class: 'card vn-warn' }, icon('alert', 'sm'),
        h('span', { text: !u.transcribe ? 'Transcription is not set up on the server yet (run deploy\\set-groq-key.ps1). Recordings upload and wait.' : 'Note writing is not set up on the server yet (run deploy\\set-anthropic-key.ps1). You still get transcripts.' })));
    }
    // recordings this browser still holds (a closed tab or a failed upload)
    clear(v.pending);
    // left out: this tab's live recording, uploads under way, and a recording another tab is still making
    // (its heartbeat is under 20 s old)
    const left = (await vdb.list()).filter((x) => !(rec.on && x.id === rec.id) && !sending.has(x.id) && !(x.updated && Date.now() - x.updated < 20_000));
    if (state.view !== v) return;   // the user moved on while storage was read: leave that page's timer alone
    for (const x of left) {
      v.pending.append(h('div', { class: 'card vn-warn' }, icon('alert', 'sm'),
        h('span', { text: `A recording from ${new Date(x.created).toLocaleString()} (${durText(x.duration)}) was not uploaded.` }),
        h('span', { class: 'vn-grow' }),
        h('button', { type: 'button', class: 'btn compact', text: 'Upload it', onclick: async (e) => {
          e.target.disabled = true;
          let blob;
          try { blob = await vdb.blob(x); } catch { e.target.disabled = false; toast('This browser could not read the saved recording.', true); return; }
          await sendRecording(blob, { id: x.id, mime: x.mime, title: x.title, duration: Math.max(1, x.duration) });
        } }),
        h('button', { type: 'button', class: 'tbtn danger', text: 'Discard', onclick: async () => { if (await confirmBox({ title: 'Discard this recording?', body: 'It is only in this browser, so it cannot be brought back.', ok: 'Discard', danger: true })) { await vdb.drop(x.id); route(); } } })));
    }
    const list = clear(v.list);
    if (!r.notes.length) {
      list.append(emptyCard({ ic: 'mic', tone: 'teal', title: 'No voice notes yet.', text: 'Press Record above, or use "New voice note" in the phone app.' }));
    }
    for (const n of r.notes) {
      list.append(h('article', { class: 'card vn-card', 'aria-label': n.title || 'Voice note' },
        h('div', { class: 'vn-cardhead' },
          h('h3', { class: 'ititle' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); go({ tab: 'voice', voiceId: n.id }); }, text: n.title || 'Voice note' })),
          voiceChip(n)),
        h('div', { class: 'meta' }, h('span', { text: durText(n.duration_s) }), h('span', { class: 'dot', 'aria-hidden': 'true' }),
          h('span', { title: when(n.created_at), text: ago(n.created_at) }), h('span', { class: 'dot', 'aria-hidden': 'true' }),
          h('span', { text: n.source === 'web' ? 'Recorded here' : n.source === 'share' ? 'Shared file' : 'Phone' })),
        n.status !== 'ready' ? voiceSteps(n.status, { failedStage: n.failed_stage, compact: true }) : null,
        n.one_line ? h('p', { class: 'excerpt', text: n.one_line }) : n.status === 'failed' && n.error ? h('p', { class: 'excerpt small', text: n.error }) : null));
    }
    clearTimeout(state.timer);
    const ms = pollMs(r.notes);
    if (ms) state.timer = setTimeout(() => { if (state.tab === 'voice' && !state.voiceId) renderVoice().catch(() => {}); }, ms);
  }

  // How soon to look again: often while the server is working, rarely while a note waits (a rate limit or
  // tomorrow's cap), and not at all for uploads nobody is sending (an abandoned phone upload).
  function pollMs(notes, passes = []) {
    const now = Date.now() / 1000;
    let ms = 0;
    for (const n of notes) {
      if (n.status === 'uploading' && !sending.size) continue;
      if (!VOICE_BUSY.has(n.status)) continue;
      const wait = n.next_at && n.next_at > now + 120 ? 60_000 : 5000;
      ms = ms ? Math.min(ms, wait) : wait;
    }
    if (passes.some((p) => p.status === 'queued' || p.status === 'running')) ms = 5000;
    return ms;
  }
  // re-read the note; the page rebuilds only if something changed, keeping the open tab and the player
  function refreshNote(id) {
    clearTimeout(state.timer);
    return renderVoiceNote(id).catch((e) => toast(e.message, true));
  }

  function voiceMarkdown(n) {
    let md = n.notes_md || (n.transcript ? `# ${n.title || 'Voice note'}\n\n## Transcript\n\n${n.transcript}` : '');
    // ticked action items stay ticked in the copy
    const done = new Set(n.action_done || []);
    let i = -1;
    md = md.replace(/^- \[ \] /gm, (m) => { i++; return done.has(i) ? '- [x] ' : m; });
    if (n.transcript && n.notes_md) md += `\n\n## Transcript\n\n${n.transcript}`;
    return md;
  }
  function downloadText(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
    const a = h('a', { href: url, download: name, class: 'offscreen' });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }
  const fileName = (s) => `${String(s || 'voice-note').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'voice-note'}.md`;

  async function renderVoiceNote(id) {
    const n = await api('GET', `/api/voice/${id}`);
    if (state.tab !== 'voice' || state.voiceId !== id) return;
    // a refresh while the page is open keeps the player playing and the open tab: only rebuild when needed
    const prev = state.view;
    const sig = JSON.stringify([n.status, n.title, n.notes_at, n.transcribed_at, n.error, n.passes.map((p) => [p.id, p.status]), n.action_done]);
    clearTimeout(state.timer);
    const again = () => { const ms = pollMs([n], n.passes); if (ms) state.timer = setTimeout(() => renderVoiceNote(id).catch(() => {}), ms); };
    if (prev && prev.kind === 'voicenote' && prev.id === id && prev.sig === sig && document.body.contains(prev.root)) { again(); return; }
    const keepTab = passTab.get(id) || (prev && prev.kind === 'voicenote' && prev.id === id ? prev.tab : null);
    passTab.delete(id);
    const keepTime = prev && prev.audio ? prev.audio.currentTime : 0;
    const wasPlaying = prev && prev.audio && !prev.audio.paused;
    const main = shell();
    const audio = n.audio_url ? h('audio', { controls: true, preload: 'metadata', src: n.audio_url, class: 'vn-audio' }) : null;
    if (audio && keepTime) { audio.currentTime = keepTime; if (wasPlaying) audio.play().catch(() => {}); }
    const seek = audio ? (s) => { audio.currentTime = s; audio.play().catch(() => {}); } : null;
    const v = state.view = { kind: 'voicenote', id, sig, audio, tab: keepTab || 'notes', root: null };

    const title = n.title || 'Voice note';
    const back = h('button', { type: 'button', class: 'tbtn', onclick: () => go({ tab: 'voice', voiceId: null }) }, icon('left', 'sm'), 'All voice notes');
    const actions = moreBtn(title, () => [
      { label: 'Rename', icon: 'pencil', onClick: async () => {
        const t = await askText({ title: 'Rename voice note', label: 'Title', value: n.title || '' });
        if (t === null) return;
        try { await api('PATCH', `/api/voice/${id}`, { title: t }); refreshNote(id); } catch (e) { toast(e.message, true); }
      } },
      n.notes_md || n.transcript ? { label: 'Copy as Markdown', icon: 'copy', onClick: () => copyText(voiceMarkdown(n), 'notes') } : null,
      n.notes_md || n.transcript ? { label: 'Download .md', icon: 'down', onClick: () => downloadText(fileName(title), voiceMarkdown(n)) } : null,
      n.audio_url ? { label: 'Download audio', icon: 'down', onClick: () => window.open(n.audio_url, '_blank', 'noopener') } : null,
      n.transcript ? { label: 'Write the notes again', icon: 'refresh', onClick: () => redo('notes') } : null,
      n.audio_url ? { label: 'Transcribe again', icon: 'refresh', onClick: () => redo('transcript') } : null,
      n.item_id ? { label: 'Show in Inbox', icon: 'inbox', onClick: () => { state.q = title.slice(0, 60); go({ tab: 'inbox', voiceId: null }); } } : null,
      { sep: true },
      { label: 'Delete', icon: 'trash', danger: true, onClick: async () => {
        if (!await confirmBox({ title: 'Delete this voice note?', body: 'The audio, transcript, notes and passes are deleted. The copy on Google Drive stays.', ok: 'Delete', danger: true })) return;
        try { await api('DELETE', `/api/voice/${id}`); toast('Voice note deleted'); go({ tab: 'voice', voiceId: null }); } catch (e) { toast(e.message, true); }
      } },
    ].filter(Boolean), { fkey: `vmore:${id}` });
    async function redo(what) {
      try { await api('POST', `/api/voice/${id}/retry`, { what }); toast(what === 'notes' ? 'Writing the notes again' : 'Transcribing again'); refreshNote(id); } catch (e) { toast(e.message, true); }
    }

    const head = h('div', { class: 'phead' }, h('h1', { text: title }), voiceChip(n), h('span', { class: 'act' }, actions));
    const meta = h('div', { class: 'meta vn-meta' }, h('span', { text: durText(n.duration_s) }), h('span', { class: 'dot', 'aria-hidden': 'true' }),
      h('span', { text: when(n.created_at) }), n.notes_model ? [h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', { text: 'Notes by Claude, transcript by Whisper' })] : null);

    let banner = null;
    if (n.status === 'transcribing' || n.status === 'writing' || n.status === 'uploading') {
      banner = h('div', { class: 'card vn-progress', role: 'status' },
        voiceSteps(n.status),
        h('p', { class: 'vn-busyline' }, h('span', { class: 'spin', 'aria-hidden': 'true' }),
          h('span', { text: n.status === 'transcribing' ? 'Transcribing the audio. A 90-minute note takes about a minute.' : n.status === 'writing' ? 'Writing the notes. Long notes take a few minutes.' : 'Still being sent from the device that recorded it.' })),
        n.error ? h('p', { class: 'small muted', text: n.error }) : null);
    } else if (n.status === 'failed') {
      banner = h('div', { class: 'card vn-progress', role: 'alert' },
        voiceSteps('failed', { failedStage: n.failed_stage }),
        h('div', { class: 'vn-failline' }, icon('alert', 'sm'), h('span', { text: n.error || 'Something went wrong.' }), h('span', { class: 'vn-grow' }),
          h('button', { type: 'button', class: 'btn compact', text: n.failed_stage === 'notes' ? 'Write the notes again' : 'Transcribe again', onclick: () => redo(n.failed_stage === 'notes' ? 'notes' : 'transcript') })));
    }

    // tabs: Notes, each pass, Transcript
    const tabs = [];
    if (n.notes) tabs.push(['notes', 'Notes']);
    for (const p of n.passes) tabs.push([`pass:${p.id}`, p.prompt.length > 28 ? `${p.prompt.slice(0, 26)}…` : p.prompt]);
    if (n.transcript) tabs.push(['transcript', 'Transcript']);
    if (n.transcript) tabs.push(['new', 'Another pass']);
    if (!tabs.find((t) => t[0] === v.tab)) v.tab = tabs.length ? tabs[0][0] : 'notes';
    const panel = h('div', { class: 'vn-panel', role: 'tabpanel', id: `vn-panel-${id}` });
    const bar = h('div', { class: 'vn-tabs', role: 'tablist', 'aria-label': 'Views of this note' });
    function showTab(k) {
      v.tab = k;
      for (const b of bar.children) { const on = b.dataset.k === k; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; b.classList.toggle('on', on); }
      clear(panel).append(tabBody(k));
    }
    for (const [k, label] of tabs) {
      bar.append(h('button', { type: 'button', role: 'tab', 'data-k': k, 'aria-controls': panel.id, class: k === 'new' ? 'vn-tab add' : 'vn-tab', onclick: () => showTab(k),
        onkeydown: (e) => {
          const i = tabs.findIndex((t) => t[0] === k);
          const j = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length : -1;
          if (j >= 0) { e.preventDefault(); showTab(tabs[j][0]); bar.children[j].focus(); }
        } }, k === 'new' ? icon('plus', 'sm') : null, label));
    }

    function section(name, kids) { return kids && kids.length ? h('section', { class: 'vn-sec' }, h('h2', { text: name }), kids) : null; }
    function listOf(xs) { return xs && xs.length ? [h('ul', {}, xs.map((x) => h('li', {}, withMarks(x, seek))))] : null; }
    function tabBody(k) {
      if (k === 'notes' && n.notes) {
        const nt = n.notes;
        const done = new Set(n.action_done || []);
        const acts = nt.action_items.length ? [h('ul', { class: 'vn-actions' }, nt.action_items.map((a, i) => {
          const idc = `vn-a-${id}-${i}`;
          const bits = [a.owner && `Owner: ${a.owner}`, a.due && `Due: ${a.due}`].filter(Boolean).join(' · ');
          const mark = (/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/.exec(a.text) || [])[1];
          return h('li', { class: done.has(i) ? 'done' : null },
            h('input', { type: 'checkbox', id: idc, checked: done.has(i), onchange: async (e) => {
              const next = new Set(n.action_done || []);
              if (e.target.checked) next.add(i); else next.delete(i);
              e.target.closest('li').classList.toggle('done', e.target.checked);
              try { const r = await api('PATCH', `/api/voice/${id}`, { action_done: [...next] }); n.action_done = r.action_done; v.sig = JSON.stringify([n.status, n.title, n.notes_at, n.transcribed_at, n.error, n.passes.map((p) => [p.id, p.status]), n.action_done]); } catch (x) { e.target.checked = !e.target.checked; toast(x.message, true); }
            } }),
            h('label', { for: idc }, inlineMd(a.text.replace(MARK_RE, '').replace(/\s{2,}/g, ' ').trim())),
            a.priority !== 'medium' ? h('span', { class: `chip ${a.priority === 'high' ? 'high' : 'low'}`, text: a.priority }) : null,
            bits ? h('span', { class: 'small muted', text: ` ${bits}` }) : null,
            mark && seek ? h('button', { type: 'button', class: 'vn-mark', text: mark, title: `Play from ${mark}`, onclick: () => seek(markSecs(mark)) }) : null);
        }))] : null;
        return h('div', {},
          nt.one_line ? h('p', { class: 'vn-lede', text: nt.one_line }) : null,
          section('Summary', nt.summary ? [h('p', {}, withMarks(nt.summary, seek))] : null),
          section('Key points', listOf(nt.key_points)),
          section('Action items', acts),
          section('Decisions', listOf(nt.decisions)),
          section('Objectives', listOf(nt.objectives)),
          section('Open questions', listOf(nt.open_questions)),
          section('Ideas', listOf(nt.ideas)),
          section('Detailed notes', nt.detailed_notes ? [mdView(nt.detailed_notes, seek)] : null),
          nt.tags.length ? h('p', { class: 'small muted', text: nt.tags.map((t) => `#${t}`).join(' ') }) : null);
      }
      if (k === 'transcript') {
        return h('div', { class: 'vn-transcript' }, String(n.transcript).split('\n\n').map((p) => h('p', {}, withMarks(p, seek))),
          h('div', { class: 'btnrow' }, h('button', { type: 'button', class: 'btn', onclick: () => copyText(n.transcript, 'transcript') }, icon('copy', 'sm'), 'Copy transcript')));
      }
      if (k.startsWith('pass:')) {
        const p = n.passes.find((x) => `pass:${x.id}` === k);
        if (!p) return h('p', { text: 'That pass is gone.' });
        return h('div', {},
          h('p', { class: 'small muted vn-prompt' }, h('strong', { text: 'Your prompt: ' }), p.prompt),
          p.status === 'done' ? mdView(p.output_md, seek)
            : p.status === 'failed' ? h('div', { class: 'card vn-warn' }, icon('alert', 'sm'), h('span', { text: p.error || 'This pass failed.' }))
              : h('div', { class: 'card vn-busy', role: 'status' }, h('span', { class: 'spin', 'aria-hidden': 'true' }), h('span', { text: 'Working on it…' })),
          h('div', { class: 'btnrow' },
            p.status === 'done' ? h('button', { type: 'button', class: 'btn', onclick: () => copyText(p.output_md, 'text') }, icon('copy', 'sm'), 'Copy') : null,
            p.status === 'done' ? h('button', { type: 'button', class: 'btn', onclick: () => downloadText(fileName(`${title} ${p.prompt.slice(0, 30)}`), p.output_md) }, icon('down', 'sm'), 'Download .md') : null,
            h('button', { type: 'button', class: 'btn', onclick: () => newPass(p.prompt) }, icon('refresh', 'sm'), 'Run again'),
            p.status !== 'running' ? h('button', { type: 'button', class: 'tbtn danger', text: 'Delete this pass', onclick: async () => {
              try { await api('DELETE', `/api/voice/${id}/passes/${p.id}`); v.tab = 'notes'; refreshNote(id); } catch (e) { toast(e.message, true); }
            } }) : null));
      }
      if (k === 'new') {
        const ta = h('textarea', { id: `vn-ask-${id}`, rows: 5, maxlength: 4000, value: passDrafts.get(id) || '',
          placeholder: 'What should Claude do with this note? For example: "Pull out every number I mentioned and what it was for."',
          oninput: () => passDrafts.set(id, ta.value) });
        return h('form', { class: 'vn-ask', onsubmit: (e) => { e.preventDefault(); newPass(ta.value); } },
          h('label', { class: 'lbl', for: ta.id, text: 'Your prompt' }), ta,
          h('div', { class: 'vn-presets', role: 'group', 'aria-label': 'Starting points' },
            PASS_PRESETS.map(([label, text]) => h('button', { type: 'button', class: 'chip', text: label, onclick: () => { ta.value = text; passDrafts.set(id, text); ta.focus(); } }))),
          h('p', { class: 'small muted', text: 'Claude reads the whole transcript and the notes, then does this. Each pass is kept as its own tab.' }),
          h('div', { class: 'btnrow' }, h('button', { type: 'submit', class: 'btn primary', text: 'Run' })));
      }
      return h('p', { class: 'muted', text: n.status === 'failed' ? 'No notes yet.' : 'The notes appear here when they are ready.' });
    }
    async function newPass(prompt) {
      if (!String(prompt || '').trim()) { toast('Write what you want done first.', true); return; }
      try {
        const r = await api('POST', `/api/voice/${id}/passes`, { prompt });
        passDrafts.delete(id);
        passTab.set(id, `pass:${r.id}`);   // whichever rebuild comes next opens the new pass's tab
        await refreshNote(id);
      } catch (e) { toast(e.message, true); }
    }

    const root = h('div', { class: 'vn-note' }, back, head, meta, banner, audio ? h('div', { class: 'card vn-player' }, audio) : null, tabs.length ? bar : null, panel);
    v.root = root;
    main.append(root);
    if (tabs.length) showTab(v.tab); else panel.append(tabBody('notes'));
    again();
  }

  // ---------- routing ----------
  async function route() {
    clearTimeout(state.timer);
    if (!state.me) return boot();
    try {
      if (state.merge) return renderMerge();
      if (state.tab === 'bundles') return await renderBundles();
      if (state.tab === 'security') return await renderSecurity();
      if (state.tab === 'recipes') return await renderRecipes();
      if (state.tab === 'voice') return await renderVoice();
      return await loadInbox();
    } catch (x) {
      if (x.status !== 401 && x.code !== 'mfa_setup_required') toast(x.message, true);
    }
  }

  // Connecting Claude (claude.ai custom connector): /oauth/authorize sends a signed-out browser here with
  // ?next=/oauth/authorize?...; after a full sign-in (password and two-step) the page goes back there.
  // Only a same-origin /oauth/authorize address is accepted, and only one bounce within 10 seconds, so a
  // sign-in the server doesn't see can never loop.
  const NEXT = (() => {
    try {
      const n = new URLSearchParams(location.search).get('next');
      if (!n || !n.startsWith('/oauth/authorize?')) return null;
      const u = new URL(n, location.origin);
      return u.origin === location.origin && u.pathname === '/oauth/authorize' ? u.pathname + u.search : null;
    } catch { return null; }
  })();
  function followNext() {
    if (!NEXT) return false;
    let last = 0;
    try { last = Number(sessionStorage.getItem('tv_next_at')) || 0; } catch { /* storage blocked */ }
    if (Date.now() - last < 10_000) {
      history.replaceState(null, '', '/');
      toast('Could not continue connecting Claude. Start again from Claude.', true);
      return false;
    }
    try { sessionStorage.setItem('tv_next_at', String(Date.now())); } catch { /* storage blocked */ }
    location.replace(NEXT);
    return true;
  }

  async function boot() {
    let me;
    try { me = await api('GET', '/api/me'); } catch { me = { signed_in: false }; }
    if (me.needs_code) return showCode();
    if (!me.signed_in) return showLogin();
    if (!me.mfa_enabled) return showMfaSetup();
    if (followNext()) return 'next';
    state.me = me;
    return route();
  }

  boot();
})();
