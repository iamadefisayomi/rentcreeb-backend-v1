/* RentCreeb admin dashboard — plain JS, no build step. Served by the API at /admin; talks to /api/v1/admin. */
(function () {
  'use strict';
  var API = '/api/v1';
  var PAGE = 20;
  var KEY = 'rc_admin_session';
  var session = load();
  var me = null;
  var counts = {};

  // ───────── helpers ─────────
  function load() { try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function save(s) { session = s; try { s ? sessionStorage.setItem(KEY, JSON.stringify(s)) : sessionStorage.removeItem(KEY); } catch (e) {} }
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function safeUrl(u) { return /^https?:\/\//i.test(String(u || '')) ? esc(u) : ''; }
  function naira(k) { var n = Number(k || 0) / 100; return '₦' + n.toLocaleString('en-NG', { maximumFractionDigits: n % 1 ? 2 : 0 }); }
  function toKobo(v) { var n = Number(String(v == null ? '' : v).replace(/[₦,\s]/g, '')); return isFinite(n) && n > 0 ? Math.round(n * 100) : null; }
  function when(iso) { if (!iso) return '—'; var d = new Date(iso); return d.toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }) + ' ' + d.toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' }); }
  function day(iso) { if (!iso) return '—'; return new Date(iso).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }); }
  function ago(iso) { if (!iso) return ''; var m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + 'h ago' : Math.round(m / 1440) + 'd ago'; }
  function name(p) { return p ? esc([p.first_name, p.last_name].filter(Boolean).join(' ') || p.email || 'Unnamed') : '—'; }
  function plainName(p) { return p ? ([p.first_name, p.last_name].filter(Boolean).join(' ') || p.email || 'Unnamed') : ''; }
  function userLink(p) { return p && p.id ? '<a href="#/users/' + esc(p.id) + '">' + name(p) + '</a>' : name(p); }
  function initials(p) { var f = (p && p.first_name) || ''; var l = (p && p.last_name) || ''; return esc(((f.charAt(0) + l.charAt(0)) || '?').toUpperCase()); }
  function avatar(p) { return '<div class="avatar">' + (p && safeUrl(p.avatar_url) ? '<img alt="" src="' + safeUrl(p.avatar_url) + '">' : initials(p)) + '</div>'; }
  function badge(text, tone) { return '<span class="badge ' + (tone || '') + '">' + esc(text) + '</span>'; }
  var TONE = { approved: 'ok', success: 'ok', resolved: 'ok', active: 'ok', completed: 'ok', released: 'ok', confirmed: 'ok', paid: 'ok', rented: 'ok', accepted: 'ok',
    closed: 'grey', pending: 'warn', open: 'warn', investigating: 'warn', in_progress: 'warn', manual_review: 'warn', held: 'warn', pending_payment: 'warn', due: 'warn', ringing: 'warn',
    assigned: 'warn', diagnosing: 'warn', awaiting_approval: 'warn', awaiting_confirmation: 'warn', job_posted: 'warn',
    rejected: 'bad', failed: 'bad', overdue: 'bad', declined: 'bad', reversed: 'bad', cancelled: 'grey', dismissed: 'grey', refunded: 'grey', unlisted: 'grey', paused: 'grey',
    archived: 'grey', expired: 'grey', ended: 'grey', draft: 'grey' };
  function statusBadge(s) { return badge(String(s || '—').replace(/_/g, ' '), TONE[s]); }
  function label(s) { return esc(String(s || '—').replace(/_/g, ' ')); }
  function qs(o) { var p = []; Object.keys(o).forEach(function (k) { if (o[k] !== undefined && o[k] !== null && o[k] !== '') p.push(encodeURIComponent(k) + '=' + encodeURIComponent(o[k])); }); return p.length ? '?' + p.join('&') : ''; }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function toast(msg, bad) {
    var el = document.createElement('div'); el.className = 't' + (bad ? ' bad' : ''); el.textContent = msg;
    $('#toast').appendChild(el); setTimeout(function () { el.remove(); }, 4000);
  }
  function kv(pairs) { return '<dl class="kv">' + pairs.filter(Boolean).map(function (p) { return '<dt>' + esc(p[0]) + '</dt><dd>' + (p[1] == null || p[1] === '' ? '—' : p[1]) + '</dd>'; }).join('') + '</dl>'; }

  // ───────── API ─────────
  var refreshing = null;
  function refreshSession() {
    if (!refreshing) refreshing = fetch(API + '/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: session.refresh_token }) })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('expired')); })
      .then(function (j) { save(j.session); })
      .finally(function () { refreshing = null; });
    return refreshing;
  }
  function api(path, opts, retried) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    if (session && session.access_token) headers.Authorization = 'Bearer ' + session.access_token;
    return fetch(API + path, { method: opts.method || 'GET', headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined })
      .then(function (res) {
        if (res.status === 401 && !retried && session && session.refresh_token && path.indexOf('/auth/') !== 0) {
          return refreshSession().then(function () { return api(path, opts, true); })
            .catch(function () { logout('Your session expired. Please sign in again.'); throw new Error('Session expired'); });
        }
        if (res.status === 204) return null;
        return res.json().catch(function () { return {}; }).then(function (j) {
          if (!res.ok) { var e = new Error((j.error && j.error.message) || ('Request failed (' + res.status + ')')); e.status = res.status; e.code = j.error && j.error.code; throw e; }
          return j;
        });
      });
  }
  function post(path, body) { return api(path, { method: 'POST', body: body || {} }); }
  function act(promise, okMsg) {
    return promise.then(function (r) { if (okMsg) toast(okMsg); route(); return r; }).catch(function (e) { toast(e.message, true); throw e; });
  }
  /** Authenticated file download (CSV exports). */
  function download(path, filename, retried) {
    return fetch(API + path, { headers: { Authorization: 'Bearer ' + session.access_token } }).then(function (res) {
      if (res.status === 401 && !retried) return refreshSession().then(function () { return download(path, filename, true); });
      if (!res.ok) throw new Error('Export failed (' + res.status + ')');
      return res.blob().then(function (b) {
        var a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = filename; document.body.appendChild(a); a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000); toast('Export downloaded');
      });
    }).catch(function (e) { toast(e.message, true); });
  }

  // ───────── dialogs ─────────
  /**
   * form({ title, body, fields: [{ name, label, type: text|textarea|select|checkbox|number|money|date|checks, options, value, required, min, placeholder, hint }],
   *        confirm, danger, wide, html }) → Promise<values|null>
   */
  function form(opts) {
    return new Promise(function (resolve) {
      var root = $('#modal-root');
      var fields = (opts.fields || []).map(function (f, i) {
        var id = 'f-' + i; var req = f.required ? ' required' : '';
        var hint = f.hint ? '<span class="hint">' + esc(f.hint) + '</span>' : '';
        if (f.type === 'checkbox') return '<label class="check"><input type="checkbox" id="' + id + '"' + (f.value ? ' checked' : '') + '><span>' + esc(f.label) + (f.hint ? '<br><span class="faint">' + esc(f.hint) + '</span>' : '') + '</span></label>';
        if (f.type === 'checks') return '<div class="field"><span>' + esc(f.label) + '</span><div class="checks" id="' + id + '">' + f.options.map(function (o) { return '<label class="check"><input type="checkbox" value="' + esc(o[0]) + '"' + ((f.value || []).indexOf(o[0]) >= 0 ? ' checked' : '') + '><span>' + esc(o[1]) + '</span></label>'; }).join('') + '</div>' + hint + '</div>';
        var input;
        if (f.type === 'textarea') input = '<textarea class="input" id="' + id + '" placeholder="' + esc(f.placeholder || '') + '"' + req + '>' + esc(f.value || '') + '</textarea>';
        else if (f.type === 'select') input = '<select class="input" id="' + id + '">' + f.options.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(f.value) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>';
        else input = '<input class="input" id="' + id + '" type="' + (f.type === 'money' ? 'text' : f.type || 'text') + '" inputmode="' + (f.type === 'money' || f.type === 'number' ? 'decimal' : 'text') + '" value="' + esc(f.value == null ? '' : f.value) + '" placeholder="' + esc(f.placeholder || (f.type === 'money' ? '₦0' : '')) + '"' + req + '>';
        return '<label class="field"><span>' + esc(f.label) + '</span>' + input + hint + '</label>';
      }).join('');
      root.innerHTML = '<div class="backdrop"><form class="card modal' + (opts.wide ? ' wide' : '') + '" role="dialog" aria-modal="true" aria-labelledby="m-title" novalidate><h2 id="m-title">' + esc(opts.title) + '</h2>' +
        (opts.body ? '<p class="muted" style="margin:0">' + esc(opts.body) + '</p>' : '') + (opts.html || '') + fields +
        '<div class="row sticky-actions" style="justify-content:flex-end"><button type="button" class="btn" id="m-cancel">' + (opts.fields || opts.confirm ? 'Cancel' : 'Close') + '</button>' +
        (opts.confirm !== false ? '<button type="submit" class="btn ' + (opts.danger ? 'danger' : 'primary') + '" id="m-ok">' + esc(opts.confirm || 'Confirm') + '</button>' : '') + '</div></form></div>';
      var close = function (v) { root.innerHTML = ''; document.removeEventListener('keydown', onKey); resolve(v); };
      var onKey = function (e) { if (e.key === 'Escape') close(null); };
      document.addEventListener('keydown', onKey);
      $('#m-cancel').onclick = function () { close(null); };
      $('.backdrop').onclick = function (e) { if (e.target.classList.contains('backdrop')) close(null); };
      var first = $('.modal .input'); if (first) setTimeout(function () { first.focus(); }, 30);
      $('.modal').onsubmit = function (e) {
        e.preventDefault();
        var out = {}; var bad = null;
        (opts.fields || []).forEach(function (f, i) {
          var el = $('#f-' + i); var v;
          if (f.type === 'checkbox') v = el.checked;
          else if (f.type === 'checks') v = $$('input:checked', el).map(function (x) { return x.value; });
          else v = el.value.trim();
          if (f.type === 'money' && v !== '') { var k = toKobo(v); if (k == null && !bad) bad = [el, 'Enter an amount in naira']; v = k; }
          if (f.type === 'number' && v !== '') v = Number(v);
          if (f.required && (v === '' || v == null) && !bad) bad = [el, 'Please fill in “' + f.label + '”'];
          if (f.min && typeof v === 'string' && v.length < f.min && (f.required || v.length) && !bad) bad = [el, '“' + f.label + '” needs at least ' + f.min + ' characters'];
          out[f.name] = v === '' ? undefined : v;
        });
        if (bad) { bad[0].focus(); toast(bad[1], true); return; }
        close(out);
      };
    });
  }
  /** Back-compat wrapper: a reason box and/or a select. */
  function ask(o) {
    var fields = [];
    if (o.select) fields.push({ name: 'value', label: o.selectLabel || 'Status', type: 'select', options: o.select, value: o.value });
    if (o.label) fields.push({ name: 'text', label: o.label, type: 'textarea', placeholder: o.placeholder, required: o.required, min: o.required ? 3 : 0 });
    return form({ title: o.title, body: o.body, fields: fields, confirm: o.confirm, danger: o.danger }).then(function (v) { return v ? { text: v.text || '', value: v.value } : null; });
  }
  function reason(title, labelText, opts) {
    opts = opts || {};
    return form({ title: title, body: opts.body, fields: [{ name: 'reason', label: labelText || 'Reason (kept in the audit log)', type: 'textarea', required: true, min: 3, placeholder: opts.placeholder }].concat(opts.extra || []),
      confirm: opts.confirm || 'Confirm', danger: opts.danger });
  }

  // ───────── shell ─────────
  var NAV = [
    ['Dashboard', [['overview', 'Overview'], ['system', 'System & settings']]],
    ['Review queues', [['verifications', 'ID verification', 'manualVerifications'], ['listings', 'Listings', 'pendingProperties'], ['artisans', 'Artisans', 'pendingArtisans'],
      ['reports', 'Reports', 'openReports'], ['reviews', 'Reviews', 'flaggedReviews'], ['support', 'Support', 'openTickets'], ['feedback', 'App feedback']]],
    ['People', [['users', 'Users']]],
    ['Money', [['finance', 'Finance'], ['payments', 'Payments', 'stuckPayments'], ['bookings', 'Bookings'], ['escrow', 'Escrow'], ['withdrawals', 'Withdrawals', 'pendingWithdrawals'], ['subscriptions', 'Subscriptions & plans']]],
    ['Operations', [['tenancies', 'Tenancies'], ['jobs', 'Jobs'], ['rentsave', 'RentSave']]],
    ['Platform', [['announcements', 'Announcements'], ['audit', 'Audit log']]],
  ];
  var ALL_NAV = []; NAV.forEach(function (g) { ALL_NAV = ALL_NAV.concat(g[1]); });
  function shell(section, title, sub, actions) {
    var nav = NAV.map(function (g) {
      return '<div class="nav-group">' + esc(g[0]) + '</div>' + g[1].map(function (n) {
        var c = n[2] && counts[n[2]] ? '<span class="badge">' + counts[n[2]] + '</span>' : '';
        return '<a class="nav' + (section === n[0] ? ' on' : '') + '" href="#/' + n[0] + '">' + esc(n[1]) + c + '</a>';
      }).join('');
    }).join('');
    $('#app').innerHTML = '<div class="shell"><aside class="side" id="side"><div class="brand"><img src="logo-white.svg" alt="RentCreeb" height="22"> <span>Admin</span></div>' + nav +
      '<div class="side-foot"><div>Signed in as<br><b style="color:#fff">' + name(me) + '</b></div><button id="logout">Sign out</button></div></aside>' +
      '<main class="main"><div class="head"><div><div class="row"><button class="btn sm menu-btn" id="menu">☰ Menu</button><h1>' + esc(title) + '</h1></div>' +
      (sub ? '<p>' + esc(sub) + '</p>' : '') + '</div><div class="row">' + (actions || '') +
      '<form class="head-search" id="gsearch"><input class="input" name="q" placeholder="Search people, listings, references…" aria-label="Search"></form></div></div>' +
      (counts.maintenanceMode ? '<div class="alert bad" style="margin-bottom:14px">Maintenance mode is ON: the app is blocked for everyone except admins. <a href="#/system">Turn it off</a></div>' : '') +
      '<div id="view"><div class="spinner">Loading…</div></div></main></div>';
    $('#logout').onclick = function () { api('/auth/logout', { method: 'POST' }).catch(function () {}); logout(); };
    $('#menu').onclick = function () { $('#side').classList.toggle('open'); };
    $('#gsearch').onsubmit = function (e) { e.preventDefault(); var q = e.target.q.value.trim(); if (q.length >= 2) location.hash = '#/search' + qs({ q: q }); };
    return $('#view');
  }
  function view(html) { var v = $('#view'); if (v) v.innerHTML = html; return v; }
  function fail(e) { view('<div class="err">' + esc(e.message || 'Something went wrong') + '</div>'); }
  function pageLink(hash, p) { var base = hash.replace(/([?&])page=\d+/, '$1').replace(/[?&]$/, ''); return '#' + base + (base.indexOf('?') >= 0 ? '&' : '?') + 'page=' + p; }
  function pager(page, total, hash) {
    var pages = Math.max(1, Math.ceil((total || 0) / PAGE));
    if (pages <= 1) return total ? '<div class="pager"><span class="faint">' + total + ' total</span></div>' : '';
    return '<div class="pager"><span class="faint">Page ' + page + ' of ' + pages + ' · ' + total + ' total</span>' +
      (page > 1 ? '<a class="btn sm" href="' + pageLink(hash, page - 1) + '">← Prev</a>' : '') + (page < pages ? '<a class="btn sm" href="' + pageLink(hash, page + 1) + '">Next →</a>' : '') + '</div>';
  }
  function tabs(items, current, hashFor) {
    return '<div class="tabs">' + items.map(function (t) { return '<a class="tab' + (t[0] === current ? ' on' : '') + '" href="#' + hashFor(t[0]) + '">' + esc(t[1]) + (t[2] ? ' <b>' + esc(t[2]) + '</b>' : '') + '</a>'; }).join('') + '</div>';
  }
  function table(cols, rows, render, emptyText) {
    if (!rows || !rows.length) return '<div class="empty">' + esc(emptyText || 'Nothing here.') + '</div>';
    return '<div class="table-wrap"><table><thead><tr>' + cols.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') + '</tr></thead><tbody>' + rows.map(render).join('') + '</tbody></table></div>';
  }
  function section(title, inner, right) { return '<div class="card stack"><div class="row between"><h3>' + esc(title) + '</h3>' + (right || '') + '</div>' + inner + '</div>'; }
  function refreshCounts() {
    return api('/admin/overview').then(function (o) { counts = Object.assign({}, o.queues, { maintenanceMode: o.settings && o.settings.maintenanceMode }); return o; });
  }
  function bind(sel, fn) { $$(sel).forEach(function (el) { var attr = sel.replace(/[\[\]]/g, '').replace('data-', ''); el.onclick = function (e) { e.stopPropagation(); e.preventDefault(); fn(el.dataset[camel(attr)], el); }; }); }
  function camel(s) { return s.replace(/-([a-z])/g, function (_m, c) { return c.toUpperCase(); }); }
  function on(id, fn) { var el = document.getElementById(id); if (el) el.onclick = function (e) { e.preventDefault(); fn(e); }; }
  function bindMenus() {
    $$('.menu > .btn').forEach(function (b) { b.onclick = function (e) { e.stopPropagation(); var m = b.parentElement; var open = m.classList.contains('open'); $$('.menu.open').forEach(function (x) { x.classList.remove('open'); }); if (!open) m.classList.add('open'); }; });
  }
  document.addEventListener('click', function () { $$('.menu.open').forEach(function (x) { x.classList.remove('open'); }); });

  /** Bar chart of a daily series. */
  function chart(series, fmt) {
    if (!series || !series.length) return '';
    var max = Math.max.apply(null, series.map(function (d) { return d.value; }).concat([1]));
    var w = 600, h = 110, gap = 2, bw = (w - gap * series.length) / series.length;
    var bars = series.map(function (d, i) {
      var bh = Math.max(d.value ? 2 : 0, Math.round((d.value / max) * (h - 18)));
      return '<rect class="bar" x="' + (i * (bw + gap)).toFixed(1) + '" y="' + (h - 14 - bh) + '" width="' + bw.toFixed(1) + '" height="' + bh + '" rx="2"><title>' + esc(d.day + ': ' + (fmt ? fmt(d.value) : d.value)) + '</title></rect>';
    }).join('');
    return '<svg class="chart" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" role="img" aria-label="Daily chart">' + bars +
      '<text x="0" y="' + (h - 2) + '">' + esc(series[0].day.slice(5)) + '</text><text x="' + w + '" y="' + (h - 2) + '" text-anchor="end">' + esc(series[series.length - 1].day.slice(5)) + '</text></svg>';
  }

  // Internal notes
  function notesBlock(type, id, notes) {
    var list = (notes || []).map(function (n) {
      return '<div class="note"><div>' + esc(n.body) + '</div><div class="faint">' + name(n.admin) + ' · ' + when(n.created_at) + ' · <a href="#" data-delnote="' + esc(n.id) + '">delete</a></div></div>';
    }).join('');
    return section('Internal notes', (list || '<div class="faint">No notes yet. Notes are only visible to admins.</div>') +
      '<form class="stack" id="note-form" data-type="' + esc(type) + '" data-id="' + esc(id) + '"><textarea class="input" name="body" placeholder="Add a note for other admins…" style="min-height:60px"></textarea><div class="row" style="justify-content:flex-end"><button class="btn sm primary">Add note</button></div></form>');
  }
  function bindNotes() {
    var f = $('#note-form'); if (f) f.onsubmit = function (e) {
      e.preventDefault(); var body = f.body.value.trim(); if (!body) return;
      act(post('/admin/notes', { targetType: f.dataset.type, targetId: f.dataset.id, body: body }), 'Note added');
    };
    bind('[data-delnote]', function (id) { act(api('/admin/notes/' + id, { method: 'DELETE' }), 'Note deleted'); });
  }

  /** Read a conversation (asks why first; every view is in the audit log). */
  function openConversation(id) {
    reason('Open this conversation?', 'Why are you reading it? (saved in the audit log)', { body: 'Private messages are only opened to investigate a report, dispute or safety issue.', placeholder: 'e.g. Investigating report about a fake listing', confirm: 'Open' }).then(function (v) {
      if (!v) return;
      api('/admin/conversations/' + id + '/messages' + qs({ reason: v.reason })).then(function (j) {
        var c = j.conversation; var aId = c.a && c.a.id;
        var who = function (sid) { return sid === aId ? c.a : c.b; };
        var html = '<div class="faint">' + label(c.context_type) + ' · between ' + userLink(c.a) + ' and ' + userLink(c.b) + '</div><div class="msgs">' + (j.messages.length ? j.messages.map(function (m) {
          var att = m.attachment && safeUrl(m.attachment) ? '<div><a target="_blank" rel="noopener" href="' + safeUrl(m.attachment) + '">📎 ' + esc(m.attachment_name || 'Attachment') + '</a></div>' : '';
          return '<div class="msg' + (m.sender_id === aId ? '' : ' right') + '">' + esc(m.body || '') + att + '<div class="meta">' + name(who(m.sender_id)) + ' · ' + when(m.created_at) + '</div></div>';
        }).join('') : '<div class="empty">No messages.</div>') + '</div>';
        form({ title: 'Conversation', html: html, wide: true, confirm: false });
      }).catch(function (e) { toast(e.message, true); });
    });
  }

  // ───────── router ─────────
  function parse() {
    var h = (location.hash || '#/overview').slice(1);
    var parts = h.split('?'); var path = parts[0].split('/').filter(Boolean); var q = {};
    (parts[1] || '').split('&').forEach(function (kv2) { if (!kv2) return; var x = kv2.split('='); q[decodeURIComponent(x[0])] = decodeURIComponent((x[1] || '').replace(/\+/g, ' ')); });
    return { path: path, q: q, raw: h };
  }
  var PAGES = {};
  function route() {
    $('#modal-root').innerHTML = ''; // never carry a dialog over to another page
    stopLive();
    if (!session) return renderLogin();
    if (!me) return api('/users/me').then(function (r) {
      var p = r.profile || r.user || r;
      if (!p || p.role !== 'admin') { logout('This account is not an admin.'); return; }
      me = p; refreshCounts().catch(function () {}).then(route);
    }).catch(function () { logout(); });
    var r = parse(); var s = r.path[0] || 'overview';
    (PAGES[s] || PAGES.overview)(r);
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);
  function logout(msg) { save(null); me = null; renderLogin(msg); }

  // ───────── login ─────────
  function renderLogin(msg) {
    $('#app').innerHTML = '<div class="login"><form class="card" id="login"><div><img src="logo.svg" alt="RentCreeb" height="28" class="login-logo"><h1 style="margin-top:14px">Admin sign-in</h1><p class="muted" style="margin:6px 0 0">Sign in with your admin account.</p></div>' +
      (msg ? '<div class="err">' + esc(msg) + '</div>' : '') +
      '<label>Email<input class="input" name="email" type="email" autocomplete="username" required></label>' +
      '<label>Password<input class="input" name="password" type="password" autocomplete="current-password" required></label>' +
      '<button class="btn primary" type="submit">Sign in</button></form></div>';
    $('#login').onsubmit = function (e) {
      e.preventDefault();
      var f = e.target; var btn = f.querySelector('button'); btn.disabled = true; btn.textContent = 'Signing in…';
      api('/auth/login', { method: 'POST', body: { identifier: f.email.value.trim(), password: f.password.value } }).then(function (r) {
        if (!r.profile || r.profile.role !== 'admin') { renderLogin('This account is not an admin.'); return; }
        save(r.session); me = r.profile;
        refreshCounts().catch(function () {}).then(function () { if (!location.hash || location.hash === '#/') location.hash = '#/overview'; else route(); });
      }).catch(function (err) { renderLogin(err.status === 401 ? 'Wrong email or password.' : err.message); });
    };
  }

  // ═════════ Overview ═════════
  PAGES.overview = function () {
    shell('overview', 'Overview', 'What needs attention right now.');
    refreshCounts().then(function (o) {
      shell('overview', 'Overview', 'What needs attention right now.');
      var q = o.queues, u = o.users, a = o.activity;
      var card = function (n, l, href, hot) { return '<a class="card stat' + (hot && n ? ' hot' : '') + '" href="' + href + '"><span class="n">' + n + '</span><span class="l">' + esc(l) + '</span></a>'; };
      var plain = function (n, l) { return '<div class="card stat"><span class="n">' + n + '</span><span class="l">' + esc(l) + '</span></div>'; };
      var banner = o.settings && o.settings.banner ? '<div class="alert info" style="margin-bottom:14px">App banner showing: “' + esc(o.settings.banner.message) + '” · <a href="#/system">edit</a></div>' : '';
      view(banner + '<h2 class="section-title">Queues</h2><div class="grid cols-4">' +
        card(q.manualVerifications, 'ID checks needing review', '#/verifications', 1) + card(q.pendingProperties, 'Listings awaiting approval', '#/listings', 1) +
        card(q.pendingArtisans, 'Artisan applications', '#/artisans', 1) + card(q.openReports, 'Open reports', '#/reports', 1) +
        card(q.flaggedReviews, 'Flagged reviews', '#/reviews', 1) + card(q.openTickets, 'Open support tickets', '#/support', 1) +
        card(q.pendingWithdrawals, 'Withdrawals pending over 1h', '#/withdrawals?tab=pending', 1) + card(q.stuckPayments, 'Payments stuck at pending', '#/payments?status=pending', 1) + '</div>' +
        '<h2 class="section-title">Platform</h2><div class="grid cols-4">' +
        card(u.total, 'Users (' + u.new7d + ' new this week)', '#/users') + card(u.verified, 'NIN-verified users', '#/users?status=verified') +
        plain(u.tenants, 'Tenants') + plain(u.landlords, 'Landlords & estate managers') + plain(u.agents, 'Agents') + plain(u.artisans, 'Artisans') +
        card(u.suspended, 'Suspended accounts', '#/users?status=suspended') + card(a.liveProperties, 'Live listings', '#/listings?tab=approved') +
        card(a.bookings7d, 'Bookings this week', '#/bookings') + card(a.activeSubscriptions, 'Active subscriptions', '#/subscriptions') +
        card(naira(a.paymentsKobo30d), 'Payments, last 30 days', '#/finance') + card(naira(a.escrowHeldKobo), 'Held in escrow (' + a.heldEscrows + ')', '#/escrow') + '</div>' +
        '<div class="grid cols-2" style="margin-top:14px">' + section('Sign-ups, last 30 days', chart(o.trends.signups)) + section('Payments, last 30 days', chart(o.trends.paymentsKobo, naira)) + '</div>' +
        '<h2 class="section-title">Recent admin activity <a class="btn sm" href="#/audit">Full audit log →</a></h2><div class="card">' + actionsTable(o.recentActions) + '</div>');
    }).catch(fail);
  };

  function actionsTable(rows) {
    if (!rows || !rows.length) return '<div class="empty">No admin actions recorded yet.</div>';
    var link = function (x) {
      var id = esc(x.target_id || '');
      var map = { user: '#/users/', property: '#/listings/', booking: '#/bookings/', verification: '#/verifications/', tenancy: '#/tenancies/', job: '#/jobs/' };
      return map[x.target_type] && x.target_id ? '<a href="' + map[x.target_type] + id + '">' + esc(x.target_type) + '</a>' : esc(x.target_type);
    };
    return table(['When', 'Admin', 'Action', 'Target', 'Details'], rows, function (x) {
      var d = x.details || {}; var det = Object.keys(d).map(function (k) { return esc(k) + ': ' + esc(typeof d[k] === 'object' ? JSON.stringify(d[k]) : d[k]); }).join('<br>');
      return '<tr><td class="num">' + when(x.created_at) + '</td><td>' + (x.admin ? name(x.admin) : /^property\.auto/.test(x.action) ? badge('RentCreeb AI', 'grey') : '—') + '</td><td>' + badge(x.action.replace(/\./g, ' · ')) + '</td><td>' + link(x) + '</td><td class="faint">' + (det || '—') + '</td></tr>';
    });
  }

  // ═════════ Search ═════════
  PAGES.search = function (r) {
    shell('', 'Search', 'Results for “' + (r.q.q || '') + '”');
    if (String(r.q.q || '').trim().length < 2) { view('<div class="card empty">Type at least 2 characters to search.</div>'); return; }
    api('/admin/search' + qs({ q: r.q.q })).then(function (j) {
      var any = j.users.length + j.properties.length + j.payments.length + j.bookings.length;
      view(!any ? '<div class="card empty">Nothing matches. Try a name, email, phone, listing title, payment reference or an ID.</div>' : '<div class="grid cols-2">' +
        (j.users.length ? section('People', table(['Name', 'Role', 'Contact'], j.users, function (u) { return '<tr class="click" data-go="#/users/' + esc(u.id) + '"><td><div class="row">' + avatar(u) + name(u) + '</div></td><td>' + label(u.role) + '</td><td>' + esc(u.email || '') + '<div class="faint">' + esc(u.phone || '') + '</div></td></tr>'; })) : '') +
        (j.properties.length ? section('Listings', table(['Title', 'Area', 'Status'], j.properties, function (p) { return '<tr class="click" data-go="#/listings/' + esc(p.id) + '"><td>' + esc(p.title) + '</td><td>' + esc(p.area || '') + '</td><td>' + statusBadge(p.status) + '</td></tr>'; })) : '') +
        (j.payments.length ? section('Payments', table(['Reference', 'Purpose', 'Amount', 'Status'], j.payments, function (p) { return '<tr class="click" data-pay="' + esc(p.id) + '"><td class="faint">' + esc(p.reference) + '</td><td>' + label(p.purpose) + '</td><td class="num">' + naira(p.amount_kobo) + '</td><td>' + statusBadge(p.status) + '</td></tr>'; })) : '') +
        (j.bookings.length ? section('Bookings', table(['Property', 'Status', 'Date'], j.bookings, function (b) { return '<tr class="click" data-go="#/bookings/' + esc(b.id) + '"><td>' + esc(b.properties && b.properties.title || '—') + '</td><td>' + statusBadge(b.status) + '</td><td class="num">' + when(b.scheduled_at) + '</td></tr>'; })) : '') + '</div>');
      bindGo(); bind('[data-pay]', paymentDialog);
    }).catch(fail);
  };
  function bindGo() { bind('[data-go]', function (h) { location.hash = h; }); }

  // ═════════ ID verification ═════════
  var REASON = { FACE_BORDERLINE: ['Close match', 'warn'], MANUAL_REQUEST: ['Asked for manual review', ''], FACE_MISMATCH: ['Face did not match', 'bad'], NIN_NOT_FOUND: ['NIN not found', 'bad'],
    REJECTED_BY_ADMIN: ['Rejected by admin', 'bad'], REVOKED: ['Revoked', 'bad'], SUPERSEDED: ['Superseded', 'grey'] };
  function reasonBadge(v) { var k = v.failure_reason || (v.nin_last3 === '---' && v.status === 'manual_review' ? 'MANUAL_REQUEST' : ''); var x = REASON[k]; return x ? badge(x[0], x[1]) : k ? badge(k.toLowerCase().replace(/_/g, ' '), 'grey') : ''; }
  var DOC = { nin_slip: 'NIN slip', national_id: 'National ID card', passport: 'International passport', drivers_licence: 'Driver’s licence', voters_card: 'Voter’s card', other: 'ID document' };
  function nameMatch(nimc, first, last) {
    var norm = function (s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(function (t) { return t.length > 1; }); };
    var a = norm(nimc), b = norm((first || '') + ' ' + (last || ''));
    if (!a.length || !b.length) return null;
    var hits = b.filter(function (t) { return a.indexOf(t) >= 0; }).length;
    return hits >= Math.min(2, b.length) ? 'match' : hits ? 'partial' : 'mismatch';
  }

  PAGES.verifications = function (r) {
    if (r.path[1]) return verificationDetail(r.path[1]);
    var tab = r.q.tab || 'manual_review'; var page = Number(r.q.page || 1);
    shell('verifications', 'ID verification', 'Review NIN checks the automatic matcher could not decide, and requests for manual verification.');
    api('/admin/verifications' + qs({ status: tab, page: page, limit: PAGE })).then(function (j) {
      var c = j.counts || {};
      view(tabs([['manual_review', 'Needs review', c.manual_review], ['failed', 'Failed', c.failed], ['success', 'Passed', c.success]], tab, function (t) { return '/verifications?tab=' + t; }) +
        '<div class="card">' + table(['Person', 'Why it is here', 'Face score', 'Evidence', 'NIN', 'Submitted'], j.verifications, function (v) {
          var u = v.user || {};
          var ev = (v.hasSelfie ? badge('Selfie', 'ok') : '') + (v.hasNimcPhoto ? badge('NIMC photo', 'ok') : '') + (v.hasNimcResponse ? badge('NIN response', 'grey') : '') + (v.hasDocument ? badge(DOC[v.document_type] || 'ID', 'ok') : '') + (v.metadata && v.metadata.nimc_name ? badge('NIMC name', 'grey') : '');
          return '<tr class="click" data-go="#/verifications/' + esc(v.id) + '"><td><div class="row">' + avatar(u) + '<div><b>' + name(u) + '</b><div class="faint">' + label(u.role) + ' · ' + esc(u.phone || u.email || '') + '</div></div></div></td>' +
            '<td>' + reasonBadge(v) + (v.metadata && v.metadata.note ? '<div class="faint">“' + esc(String(v.metadata.note).slice(0, 80)) + '”</div>' : '') + '</td>' +
            '<td class="num">' + (v.confidence != null ? Math.round(Number(v.confidence)) + '%' : '—') + '</td><td><div class="chips">' + (ev || '<span class="faint">none</span>') + '</div></td>' +
            '<td class="num">•••' + esc(v.nin_last3) + '</td><td class="num">' + when(v.created_at) + '<div class="faint">' + ago(v.created_at) + '</div></td></tr>';
        }, tab === 'manual_review' ? 'No ID checks waiting. 🎉' : 'Nothing here.') + '</div>' + pager(page, j.total, r.raw));
      bindGo();
    }).catch(fail);
  };

  function verificationDetail(id) {
    shell('verifications', 'ID review', '', '<a class="btn sm" href="#/verifications">← Back to queue</a>');
    api('/admin/verifications/' + encodeURIComponent(id)).then(function (j) {
      var v = j.verification, u = j.user || {}, e = j.evidence || {}, meta = v.metadata || {};
      shell('verifications', 'ID review: ' + plainName(u), 'Submitted ' + when(v.created_at) + ' · ' + ago(v.created_at), '<a class="btn sm" href="#/verifications">← Back to queue</a>');
      var fig = function (url, cap, sub, pdf) {
        if (!url) return '<figure><div class="none">' + esc(cap) + ':<br>not provided</div><figcaption><span>' + esc(cap) + '</span></figcaption></figure>';
        if (pdf) return '<figure><div class="none"><a class="btn" target="_blank" rel="noopener" href="' + safeUrl(url) + '">Open PDF</a></div><figcaption><span>' + esc(cap) + '</span><span>' + esc(sub || '') + '</span></figcaption></figure>';
        return '<figure><a target="_blank" rel="noopener" href="' + safeUrl(url) + '"><img alt="' + esc(cap) + '" src="' + safeUrl(url) + '"></a><figcaption><span>' + esc(cap) + '</span><span>' + esc(sub || '') + '</span></figcaption></figure>';
      };
      var match = nameMatch(meta.nimc_name, u.first_name, u.last_name);
      var matchBadge = match === 'match' ? badge('Names match', 'ok') : match === 'partial' ? badge('Partly matches', 'warn') : match === 'mismatch' ? badge('Names differ', 'bad') : '';
      var open = v.status === 'manual_review';
      var warnings = (j.sameNinOtherAccounts || []).length ? '<div class="alert bad"><b>This NIN was also used by another account:</b> ' + j.sameNinOtherAccounts.map(function (x) { return userLink(x.user); }).join(', ') + '. Approving is blocked if that account is already verified.</div>' : '';
      if (u.nin_verified) warnings += '<div class="alert ok">This account is already NIN-verified.</div>';
      if (u.is_suspended) warnings += '<div class="alert warn">This account is suspended.</div>';
      var nimcImgs = e.nimcImages || [];
      // The NIN check response, flattened into rows (pictures are shown with the evidence, so they are placeholders here).
      var flat = function (o, pre, out) {
        Object.keys(o || {}).forEach(function (k) {
          var val = o[k], key = pre ? pre + '.' + k : k;
          if (val && typeof val === 'object' && !Array.isArray(val)) flat(val, key, out);
          else if (Array.isArray(val) && val.some(function (x) { return x && typeof x === 'object'; })) val.forEach(function (x, i) { if (x && typeof x === 'object') flat(x, key + '[' + i + ']', out); else out.push([key + '[' + i + ']', x]); });
          else out.push([key, Array.isArray(val) ? val.join(', ') : val]);
        });
        return out;
      };
      var nimcRows = e.nimcResponse ? flat(e.nimcResponse, '', []) : [];
      var nimcSection = e.nimcResponse
        ? section('NIN verification response', '<p class="muted" style="margin:0">Everything the NIN check returned for this attempt (Bytid / NIMC). Pictures are shown with the evidence above.</p>' +
            '<div style="max-height:460px;overflow:auto">' + kv(nimcRows.map(function (x) { return [x[0].replace(/_/g, ' '), x[1] == null || x[1] === '' ? '' : '<span style="word-break:break-word">' + esc(String(x[1])) + '</span>']; })) + '</div>' +
            '<details><summary class="faint" style="cursor:pointer">Raw JSON</summary><pre style="white-space:pre-wrap;word-break:break-word;max-height:360px;overflow:auto;font-size:12px">' + esc(JSON.stringify(e.nimcResponse, null, 2)) + '</pre></details>')
        : '';
      if (!e.selfieUrl && !e.documentUrl && !nimcImgs.length) warnings +='<div class="alert info">No photos were kept for this check (older checks, or the person sent none). Ask them to submit a manual review with a photo of their ID from the app, or verify them on a video call.</div>';
      view('<div class="stack">' + warnings + '<div class="grid cols-2">' +
        section('Evidence', '<div class="evidence">' + fig(e.selfieUrl, 'Selfie', v.confidence != null ? 'face score ' + Math.round(v.confidence) + '%' : '') +
          nimcImgs.map(function (x, i) { return fig(x.url, i === 0 && !/signature/i.test(x.field) ? 'NIMC ID photo' : /signature/i.test(x.field) ? 'NIMC signature' : 'NIMC picture', 'from the NIN check · ' + x.field); }).join('') +
          (e.documentUrl || !nimcImgs.length ? fig(e.documentUrl, DOC[e.documentType] || 'ID document', '', e.documentIsPdf) : '') +
          (safeUrl(u.avatar_url) ? fig(u.avatar_url, 'Profile photo', 'on the account') : '') + '</div><div class="faint">Photos open full size in a new tab. Links expire after 10 minutes; they are deleted once you decide.</div>') +
        '<div class="stack">' + section('Does it match the account?',
          '<div class="compare"><div><div class="label">Name on the account</div><div class="value">' + name(u) + '</div></div><div><div class="label">Name on the NIMC record</div><div class="value">' + (meta.nimc_name ? esc(meta.nimc_name) : '<span class="faint">not available</span>') + '</div></div></div>' +
          '<div class="row">' + matchBadge + reasonBadge(v) + statusBadge(v.status) + '</div>' +
          kv([['Face score', v.confidence != null ? Math.round(v.confidence) + '%' : '—'], ['NIN', '••••••••' + esc(v.nin_last3)], ['Date of birth', esc(u.date_of_birth ? day(u.date_of_birth) : '')],
            ['Phone', esc(u.phone || '') + (u.phone_verified ? ' ' + badge('verified', 'ok') : '')], ['Email', esc(u.email || '')], ['Role', label(u.role)], ['Joined', when(u.created_at)],
            ['Their note', meta.note ? '“' + esc(meta.note) + '”' : ''], ['Bytid request', meta.request_id ? '<span class="faint">' + esc(meta.request_id) + '</span>' : ''],
            ['Attempts used', esc(j.attempts.used + ' of ' + j.attempts.max)], v.review_note ? ['Review note', esc(v.review_note)] : null, v.reviewed_at ? ['Reviewed', when(v.reviewed_at)] : null]) +
          '<div class="row"><a class="btn sm" href="#/users/' + esc(u.id) + '">Open account →</a></div>') +
        section('Decision', open ? '<p class="muted" style="margin:0">Approve only if the selfie is clearly the same person as the ID photo, and the names agree.</p><div class="row"><button class="btn ok" id="v-ok">Approve: verify identity</button><button class="btn ghost-danger" id="v-no">Reject</button></div>'
          : '<div class="row">' + statusBadge(v.status) + '<span class="muted">This check is closed.</span>' + (!u.nin_verified ? '<button class="btn sm" id="v-reset">Reset attempts so they can retry</button>' : '') + '</div>') + '</div></div>' +
        nimcSection +
        section('All checks for this person', table(['Status', 'Reason', 'Score', 'Counts toward limit', 'When', 'Note'], j.history, function (h) {
          return '<tr' + (h.id === v.id ? ' style="font-weight:600"' : ' class="click" data-go="#/verifications/' + esc(h.id) + '"') + '><td>' + statusBadge(h.status) + '</td><td>' + reasonBadge(h) + '</td><td class="num">' + (h.confidence != null ? Math.round(h.confidence) + '%' : '—') + '</td><td>' + (h.status === 'failed' ? (h.counts_as_attempt === false ? 'No' : 'Yes') : '—') + '</td><td class="num">' + when(h.created_at) + '</td><td class="faint">' + esc(h.review_note || '') + '</td></tr>';
        })) + '</div>');
      bindGo();
      on('v-ok', function () {
        form({ title: 'Verify ' + plainName(u) + '?', body: 'They get full access to RentCreeb and are told by notification and email.', fields: [{ name: 'note', label: 'Note for the audit log (optional)', type: 'textarea', placeholder: 'e.g. Selfie matches NIN slip; names agree' }], confirm: 'Verify identity' })
          .then(function (x) { if (x) act(post('/admin/verifications/' + v.id + '/approve', { note: x.note }), 'Identity verified').then(function () { location.hash = '#/verifications'; }); });
      });
      on('v-no', function () {
        form({ title: 'Reject this ID check', fields: [
          { name: 'reason', label: 'Message to the person', type: 'textarea', required: true, min: 3, placeholder: 'e.g. Your selfie was too dark to compare. Please retake it facing a window.' },
          { name: 'allowRetry', label: 'Let them try again', type: 'checkbox', value: true, hint: 'Resets their attempt count. Untick for suspected fraud.' }], confirm: 'Reject', danger: true })
          .then(function (x) { if (x) act(post('/admin/verifications/' + v.id + '/reject', { reason: x.reason, allowRetry: !!x.allowRetry }), 'ID check rejected').then(function () { location.hash = '#/verifications'; }); });
      });
      on('v-reset', function () { act(post('/admin/users/' + u.id + '/reset-attempts'), 'Attempts reset: they can verify again'); });
    }).catch(fail);
  }

  // ───────── AI listing review ─────────
  var STAGE = { rules: 'checking the rules', ai: 'AI is looking at the photos and text', deciding: 'deciding' };
  function liveBadge(st) {
    if (!st || st.status === 'done') return '';
    return st.status === 'running' ? badge('AI checking now: ' + (STAGE[st.stage] || 'working'), 'warn') : badge('AI check queued' + (st.attempts ? ' (retry ' + st.attempts + ')' : ''), 'grey');
  }
  function aiBadge(rv, st) {
    if (st && st.status !== 'done') return liveBadge(st);
    if (!rv) return badge('AI check pending', 'grey');
    if (rv.decision === 'auto_approved') return badge('Approved by AI', 'ok');
    if (rv.decision === 'error') return badge('AI check failed', 'bad');
    return badge('AI: needs a look', 'warn');
  }
  function aiSummary(rv, st) {
    if (st && st.status !== 'done') return '<div class="faint">' + liveBadge(st) + '</div>';
    if (!rv) return '';
    var reasons = (rv.reasons || []).slice(0, 3).map(esc).join(' · ');
    return '<div class="faint">' + aiBadge(rv) + ' ' + (rv.ai && rv.ai.summary ? esc(rv.ai.summary) + ' ' : '') + (reasons ? '<br>Why not auto-approved: ' + reasons : '') + '</div>';
  }
  function aiPanel(rv, p) {
    var st = p.ai_status;
    var runBtns = '<button class="btn sm" id="ai-run">Check now (report only)</button>' + (p.status === 'pending' ? '<button class="btn sm primary" id="ai-apply">Re-run automatic check</button>' : '');
    if (st && st.status !== 'done') return section('AI review', '<div class="row">' + liveBadge(st) + '<span class="faint">since ' + ago(st.since) + '. This page updates by itself.</span></div>' + (rv ? '<div class="faint">Previous result: ' + aiBadge(rv) + '</div>' : ''));
    if (!rv) return section('AI review', '<div class="faint">Not checked yet. Pending listings are checked automatically within a few minutes of their last change.</div>', '<div class="row">' + runBtns + '</div>');
    var checks = (rv.checks || []).map(function (c) { return '<div class="row" style="gap:8px"><span class="dot ' + (c.ok ? 'ok' : c.soft ? 'warn' : 'bad') + '"></span><span>' + esc(c.label) + (c.soft && !c.ok ? ' (hint, does not block)' : '') + '</span>' + (c.detail ? '<span class="faint">' + esc(c.detail) + '</span>' : '') + '</div>'; }).join('');
    var ai = rv.ai ? '<div class="stack" style="gap:6px"><div class="row">' + badge('AI verdict: ' + (rv.ai.verdict === 'approve' ? 'looks genuine' : 'needs review'), rv.ai.verdict === 'approve' ? 'ok' : 'warn') + badge(Math.round(rv.ai.confidence * 100) + '% confident', 'grey') + '</div>' +
      (rv.ai.summary ? '<div class="quote">' + esc(rv.ai.summary) + '</div>' : '') +
      (rv.ai.issues && rv.ai.issues.length ? '<div><b>Issues</b><ul style="margin:4px 0 0 18px;padding:0">' + rv.ai.issues.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>' : '') +
      (rv.ai.photos && rv.ai.photos.length ? '<div><b>Photos</b>' + rv.ai.photos.map(function (ph) { return '<div class="row" style="gap:8px"><span class="dot ' + (ph.ok ? 'ok' : 'bad') + '"></span><span class="faint">#' + (ph.index + 1) + '</span><span>' + esc(ph.shows) + '</span>' + (ph.note ? '<span class="faint">' + esc(ph.note) + '</span>' : '') + '</div>'; }).join('') + '</div>' : '') + '</div>'
      : '<div class="faint">No AI result' + (rv.model ? '' : ' (AI is not configured)') + '.</div>';
    var reasons = (rv.reasons || []).length ? '<div class="alert warn"><b>Not auto-approved because:</b><ul style="margin:4px 0 0 18px;padding:0">' + rv.reasons.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>' : '';
    return section('AI review', '<div class="row">' + aiBadge(rv) + '<span class="faint">checked ' + ago(rv.at) + (rv.model ? ' · ' + esc(rv.model) : '') + (rv.autoApproveOn ? '' : ' · auto-approval off') + '</span></div>' + reasons +
      '<div class="grid cols-2"><div class="stack" style="gap:6px"><b>Rule checks</b>' + checks + '</div>' + ai + '</div><div class="faint">The AI never rejects on its own: anything it is unsure about waits here for you.</div>', '<div class="row">' + runBtns + '</div>');
  }

  // Live view of the automatic reviewer (polls every 3 s while a listings page is open)
  var liveTimer = null, liveSeen = null;
  function stopLive() { if (liveTimer) { clearInterval(liveTimer); liveTimer = null; } liveSeen = null; }
  function startLive(render) {
    stopLive();
    var tick = function () {
      if (document.visibilityState !== 'visible') return;
      api('/admin/ai-reviews/live').then(function (live) {
        var ids = live.active.map(function (a) { return a.propertyId; }).join(',');
        var finished = liveSeen !== null && liveSeen.split(',').some(function (id) { return id && ids.indexOf(id) < 0; });
        liveSeen = ids;
        render(live, finished);
      }).catch(function () {});
    };
    tick(); liveTimer = setInterval(tick, 3000);
  }
  function renderLivePanel(live, finished) {
    var el = document.getElementById('ai-live'); if (!el) return;
    if (finished) { refreshCounts().catch(function () {}); route(); return; } // a check just finished: show the new state
    var act = live.active.map(function (a) {
      return '<div class="row between" style="padding:6px 0;border-bottom:1px solid var(--border)"><div class="row"><span class="dot ' + (a.status === 'running' ? 'warn' : '') + '"></span><a href="#/listings/' + esc(a.propertyId) + '">' + esc(a.title || 'Listing') + '</a><span class="faint">' + esc(a.area || '') + '</span></div>' +
        '<div class="row">' + liveBadge(a) + '<span class="faint">' + ago(a.since) + '</span></div></div>';
    }).join('');
    var rec = live.recent.slice(0, 6).map(function (r) {
      var b = r.decision === 'auto_approved' ? badge('Approved by AI', 'ok') : r.decision === 'error' ? badge('Check failed', 'bad') : badge('Sent to you', 'warn');
      return '<div class="row between" style="padding:6px 0;border-bottom:1px solid var(--border)"><div class="row"><a href="#/listings/' + esc(r.propertyId) + '">' + esc(r.title || 'Listing') + '</a>' + b + '</div><span class="faint">' + ago(r.at) + '</span></div>';
    }).join('');
    el.innerHTML = '<div class="card stack" style="margin-bottom:12px"><div class="row between"><h3>AI reviewer</h3><span class="faint">' +
      (live.active.length ? live.queue.running + ' checking · ' + Math.max(0, live.active.length - live.queue.running) + ' queued' : 'Idle: new listings are checked within seconds of being submitted') + ' · updates live</span></div>' +
      (act || '') + (rec ? '<div class="faint" style="margin-top:6px">Latest decisions</div>' + rec : '') + '</div>';
  }

  // ═════════ Listings ═════════
  PAGES.listings = function (r) {
    if (r.path[1]) return listingDetail(r.path[1]);
    var tab = r.q.tab || 'pending'; var page = Number(r.q.page || 1);
    shell('listings', 'Listings', 'Approve new listings, take down problem ones, and manage any listing.');
    var search = '<form class="row" id="lsearch" style="margin-bottom:12px"><input class="input" name="q" placeholder="Search title, address, area or city" value="' + esc(r.q.q || '') + '">' +
      '<select class="input" name="type"><option value="">Any type</option>' + ['apartment', 'house', 'duplex', 'bungalow', 'self_contain', 'room', 'shop', 'office', 'land', 'commercial'].map(function (x) { return '<option' + (r.q.type === x ? ' selected' : '') + ' value="' + x + '">' + label(x) + '</option>'; }).join('') + '</select><button class="btn">Search</button></form>';
    var head = tabs([['pending', 'Awaiting approval', counts.pendingProperties || ''], ['approved', 'Live'], ['rejected', 'Rejected / removed'], ['rented', 'Rented'], ['archived', 'Archived'], ['all', 'All']], tab, function (t) { return '/listings?tab=' + t; });
    var req = tab === 'pending' ? api('/admin/properties/pending').then(function (j) { return { properties: j.properties || [], total: (j.properties || []).length }; })
      : api('/admin/properties' + qs({ status: tab === 'all' ? '' : tab, q: r.q.q, type: r.q.type, page: page, limit: PAGE }));
    req.then(function (j) {
      var list = j.properties || [];
      var bulk = tab === 'pending' && list.length ? '<div class="card row between" style="margin-bottom:12px"><label class="check"><input type="checkbox" id="sel-all"><span>Select all</span></label><div class="row"><span class="faint" id="sel-n">0 selected</span><button class="btn ok sm" id="bulk-ok" disabled>Approve selected</button><button class="btn ghost-danger sm" id="bulk-no" disabled>Reject selected</button></div></div>' : '';
      view(head + (tab === 'pending' ? '<div id="ai-live"></div>' : search) + bulk + (list.length ? '<div class="stack">' + list.map(function (p) {
        var img = (p.property_media || []).slice().sort(function (a, b) { return (a.position || 0) - (b.position || 0); })[0];
        var acts = p.status === 'pending' ? '<button class="btn ok sm" data-approve="' + esc(p.id) + '">Approve</button><button class="btn ghost-danger sm" data-reject="' + esc(p.id) + '">Reject</button>'
          : ['approved', 'paused', 'unlisted'].indexOf(p.status) >= 0 ? '<button class="btn ghost-danger sm" data-down="' + esc(p.id) + '">Take down</button>'
          : p.status === 'rejected' ? '<button class="btn sm" data-restore="' + esc(p.id) + '">Restore</button>' : '';
        return '<div class="card list-item">' + (tab === 'pending' ? '<input type="checkbox" class="sel" data-id="' + esc(p.id) + '" aria-label="Select">' : '') +
          (img && safeUrl(img.url) ? '<img class="thumb" alt="" src="' + safeUrl(img.url) + '">' : '<div class="thumb"></div>') +
          '<div class="grow stack" style="gap:4px"><div class="row between"><h3><a href="#/listings/' + esc(p.id) + '">' + esc(p.title) + '</a></h3><div class="row">' + (p.is_verified ? badge('Verified', 'ok') : '') + statusBadge(p.status) + '</div></div>' +
          '<div class="muted">' + esc([p.address, p.area, p.city].filter(Boolean).join(', ')) + '</div>' +
          '<div class="row"><b class="num">' + naira(p.price_kobo) + '/' + esc(p.price_period || 'year') + '</b><span class="faint">' + label(p.property_type || '') + (p.bedrooms ? ' · ' + p.bedrooms + ' bed' : '') + '</span>' +
          (p.owner ? '<span class="faint">· by ' + userLink(Object.assign({ id: p.owner_id }, p.owner)) + ' (' + label(p.owner.role) + ')' + (p.owner.nin_verified === false ? ' ' + badge('owner not verified', 'warn') : '') + '</span>' : '') + '<span class="faint">· ' + ago(p.created_at) + '</span><span class="faint">· ' + (p.property_media || []).length + ' photos</span></div>' +
          (p.rejection_reason ? '<div class="faint">Reason: ' + esc(p.rejection_reason) + '</div>' : '') + (p.status === 'pending' ? aiSummary(p.ai_review, p.ai_status) : '') + (p.description ? '<div class="quote">' + esc(String(p.description).slice(0, 500)) + '</div>' : '') +
          '</div><div class="stack">' + acts + '<a class="btn sm" href="#/listings/' + esc(p.id) + '">Details</a></div></div>';
      }).join('') + '</div>' : '<div class="card empty">Nothing here.</div>') + (tab === 'pending' ? '' : pager(page, j.total, r.raw)));
      var sf = $('#lsearch'); if (sf) sf.onsubmit = function (e) { e.preventDefault(); location.hash = '#/listings' + qs({ tab: tab, q: e.target.q.value.trim(), type: e.target.type.value }); };
      if (tab === 'pending') startLive(renderLivePanel);
      bindListingActions();
      var selected = function () { return $$('.sel:checked').map(function (x) { return x.dataset.id; }); };
      var upd = function () { var n = selected().length; var t = $('#sel-n'); if (t) t.textContent = n + ' selected'; ['bulk-ok', 'bulk-no'].forEach(function (b) { var el = document.getElementById(b); if (el) el.disabled = !n; }); };
      $$('.sel').forEach(function (x) { x.onchange = upd; });
      var all = $('#sel-all'); if (all) all.onchange = function () { $$('.sel').forEach(function (x) { x.checked = all.checked; }); upd(); };
      on('bulk-ok', function () { var ids = selected(); act(post('/admin/properties/bulk-decision', { ids: ids, approve: true }), ids.length + ' listings approved'); });
      on('bulk-no', function () { var ids = selected(); reason('Reject ' + ids.length + ' listings', 'Reason (sent to each owner)', { confirm: 'Reject all', danger: true }).then(function (v) { if (v) act(post('/admin/properties/bulk-decision', { ids: ids, approve: false, reason: v.reason }), 'Listings rejected'); }); });
    }).catch(fail);
  };
  function bindListingActions() {
    bind('[data-approve]', function (id) { act(post('/admin/properties/' + id + '/decision', { approve: true }), 'Listing approved'); });
    bind('[data-reject]', function (id) { reason('Reject listing', 'Reason (sent to the owner)', { placeholder: 'e.g. Photos are unclear: please upload clear photos of each room', confirm: 'Reject', danger: true })
      .then(function (m) { if (m) act(post('/admin/properties/' + id + '/decision', { approve: false, reason: m.reason }), 'Listing rejected'); }); });
    bind('[data-down]', function (id) { reason('Take listing down', 'Reason (sent to the owner)', { body: 'It disappears from search immediately. The owner is notified.', confirm: 'Take down', danger: true })
      .then(function (m) { if (m) act(post('/admin/properties/' + id + '/takedown', { down: true, reason: m.reason }), 'Listing taken down'); }); });
    bind('[data-restore]', function (id) { act(post('/admin/properties/' + id + '/takedown', { down: false }), 'Listing restored'); });
  }
  function listingDetail(id) {
    shell('listings', 'Listing', '', '<a class="btn sm" href="#/listings">← Listings</a>');
    api('/admin/properties/' + encodeURIComponent(id)).then(function (j) {
      var p = j.property, o = p.owner || {};
      shell('listings', p.title, [p.address, p.area, p.city].filter(Boolean).join(', '), '<a class="btn sm" href="#/listings">← Listings</a>');
      var media = (p.property_media || []).map(function (m) {
        if (!safeUrl(m.url)) return '';
        return m.media_type === 'video' ? '<a target="_blank" rel="noopener" href="' + safeUrl(m.url) + '"><video src="' + safeUrl(m.url) + '" muted></video></a>' : '<a target="_blank" rel="noopener" href="' + safeUrl(m.url) + '"><img alt="" src="' + safeUrl(m.url) + '"></a>';
      }).join('');
      var acts = (p.status === 'pending' ? '<button class="btn ok" data-approve="' + esc(p.id) + '">Approve</button><button class="btn ghost-danger" data-reject="' + esc(p.id) + '">Reject</button>' : '') +
        (['approved', 'paused', 'unlisted'].indexOf(p.status) >= 0 ? '<button class="btn ghost-danger" data-down="' + esc(p.id) + '">Take down</button>' : '') +
        (p.status === 'rejected' ? '<button class="btn" data-restore="' + esc(p.id) + '">Restore</button>' : '') +
        '<button class="btn" id="p-status">Change status</button><button class="btn" id="p-verify">' + (p.is_verified ? 'Remove verified badge' : 'Give verified badge') + '</button>';
      view('<div class="stack"><div class="card row between"><div class="row">' + statusBadge(p.status) + (p.is_verified ? badge('Verified listing', 'ok') : badge('Not verified', 'grey')) + '<span class="faint">' + j.savedCount + ' saves · created ' + when(p.created_at) + '</span></div><div class="row">' + acts + '</div></div>' +
        (p.rejection_reason ? '<div class="alert warn">Reason given: ' + esc(p.rejection_reason) + '</div>' : '') +
        aiPanel(p.ai_review, p) +
        section('Photos & videos (' + (p.property_media || []).length + ')', media ? '<div class="gallery">' + media + '</div>' : '<div class="faint">No media</div>') +
        '<div class="grid cols-2">' + section('Details', kv([['Price', '<b>' + naira(p.price_kobo) + '</b> / ' + esc(p.price_period)], ['Type', label(p.property_type)], ['Bedrooms', esc(p.bedrooms)], ['Bathrooms', esc(p.bathrooms)],
          ['Size', p.size_sqm ? esc(p.size_sqm) + ' m²' : ''], ['Inspection fee', p.inspection_fee_kobo != null ? naira(p.inspection_fee_kobo) : ''], ['Caution fee', p.caution_fee_kobo != null ? naira(p.caution_fee_kobo) : ''], ['Agency fee', p.agency_fee_kobo != null ? naira(p.agency_fee_kobo) : ''],
          ['Amenities', (p.amenities || []).map(function (a) { return badge(a, 'grey'); }).join(' ')], ['Security', (p.security_features || []).map(function (a) { return badge(a, 'grey'); }).join(' ')], ['Title document', esc(p.title_document || '')], ['Landmark', esc(p.landmark || '')],
          ['Map', p.lat && p.lng ? '<a target="_blank" rel="noopener" href="https://www.google.com/maps?q=' + encodeURIComponent(p.lat + ',' + p.lng) + '">Open in Google Maps</a>' : '']]) + (p.description ? '<div class="quote">' + esc(p.description) + '</div>' : '')) +
        section('Owner', '<div class="row">' + avatar(o) + '<div><b>' + userLink(o) + '</b><div class="faint">' + label(o.role) + ' · ' + esc(o.phone || '') + ' · ' + esc(o.email || '') + '</div></div></div><div class="chips">' + (o.nin_verified ? badge('NIN verified', 'ok') : badge('Not verified', 'warn')) + (o.is_suspended ? badge('Suspended', 'bad') : '') + '</div>') + '</div>' +
        (j.units.length ? section('Units (' + j.units.length + ')', table(['Unit', 'Type', 'Rent / month', 'Status'], j.units, function (u) { return '<tr><td>' + esc(u.label) + '</td><td>' + label(u.unit_type) + '</td><td class="num">' + naira(u.rent_kobo) + '</td><td>' + statusBadge(u.status) + '</td></tr>'; })) : '') +
        '<div class="grid cols-2">' + section('Bookings', table(['Tenant', 'Status', 'Date', 'Amount'], j.bookings, function (b) { return '<tr class="click" data-go="#/bookings/' + esc(b.id) + '"><td>' + name(b.tenant) + '</td><td>' + statusBadge(b.status) + '</td><td class="num">' + when(b.scheduled_at) + '</td><td class="num">' + naira(b.amount_kobo) + '</td></tr>'; }, 'No bookings')) +
        section('Reviews', table(['Rating', 'By', 'Comment'], j.reviews, function (x) { return '<tr><td>' + '★'.repeat(x.rating) + (x.hidden ? ' ' + badge('hidden', 'grey') : '') + '</td><td>' + name(x.reviewer) + '</td><td class="faint">' + esc(String(x.comment || '').slice(0, 120)) + '</td></tr>'; }, 'No reviews')) + '</div>' +
        (j.tenancies.length ? section('Tenancies', table(['Tenant', 'Status', 'Rent', 'Lease'], j.tenancies, function (t) { return '<tr class="click" data-go="#/tenancies/' + esc(t.id) + '"><td>' + name(t.tenant) + '</td><td>' + statusBadge(t.status) + '</td><td class="num">' + naira(t.rent_kobo) + ' ' + label(t.frequency) + '</td><td class="num">' + day(t.lease_start) + ' – ' + day(t.lease_end) + '</td></tr>'; })) : '') +
        notesBlock('property', p.id, j.notes) + '</div>');
      bindListingActions(); bindGo(); bindNotes();
      on('p-status', function () {
        form({ title: 'Change listing status', fields: [{ name: 'status', label: 'Status', type: 'select', value: p.status, options: [['approved', 'Live (approved)'], ['pending', 'Awaiting approval'], ['unlisted', 'Unlisted'], ['rented', 'Rented'], ['rejected', 'Rejected / removed'], ['archived', 'Archived']] },
          { name: 'reason', label: 'Reason (sent to the owner)', type: 'textarea' }, { name: 'notifyOwner', label: 'Notify the owner', type: 'checkbox', value: true }], confirm: 'Save' })
          .then(function (v) { if (v) act(api('/admin/properties/' + p.id, { method: 'PATCH', body: { status: v.status, reason: v.reason, notifyOwner: v.notifyOwner } }), 'Status updated'); });
      });
      var runAi = function (apply) {
        if (apply) { post('/admin/properties/' + p.id + '/ai-review', { background: true }).then(function () { toast('Queued: watch it run here'); route(); }).catch(function (e) { toast(e.message, true); }); return; }
        toast('Checking the listing… this takes up to a minute');
        post('/admin/properties/' + p.id + '/ai-review', { apply: false }).then(function (x) {
          toast(x.review.decision === 'error' ? 'The check failed' : 'Checked (nothing changed)');
          route();
        }).catch(function (e) { toast(e.message, true); });
      };
      on('ai-run', function () { runAi(false); });
      on('ai-apply', function () { runAi(true); });
      if (p.ai_status && p.ai_status.status !== 'done') startLive(function (live) {
        var mine = live.active.filter(function (a) { return a.propertyId === p.id; })[0];
        if (!mine) { stopLive(); route(); return; }  // finished: reload to show the result
      });
      on('p-verify', function () { act(api('/admin/properties/' + p.id, { method: 'PATCH', body: { isVerified: !p.is_verified, notifyOwner: false } }), p.is_verified ? 'Badge removed' : 'Listing marked verified'); });
    }).catch(fail);
  }

  // ═════════ Artisans ═════════
  var REL = { client: 'Past client', employer: 'Employer', colleague: 'Colleague', supplier: 'Supplier', landlord: 'Landlord / Estate', other: 'Other' };
  PAGES.artisans = function (r) {
    var tab = r.q.tab || 'pending';
    shell('artisans', 'Artisans', 'Check documents and references, then approve or send back. Withdraw approval when needed.');
    api('/admin/artisans' + qs({ status: tab })).then(function (j) {
      var list = j.artisans || [];
      view(tabs([['pending', 'Awaiting review', counts.pendingArtisans || ''], ['approved', 'Approved'], ['rejected', 'Sent back'], ['draft', 'Not submitted']], tab, function (t) { return '/artisans?tab=' + t; }) + (list.length ? '<div class="stack">' + list.map(function (a) {
        var p = a.profiles || {};
        var docs = (a.artisan_documents || []).map(function (d) { return '<button class="btn sm" data-doc="' + esc(d.id) + '">View ' + label(d.doc_type) + '</button>'; }).join('') || '<span class="faint">No documents</span>';
        var refs = (a.artisan_references || []).map(function (x) {
          var socials = (x.socials || []).map(function (s) { var h = String(s.handle || ''); var href = /^https?:\/\//i.test(h) ? h : ''; return badge(s.platform + ': ' + h, 'grey') + (href ? ' <a target="_blank" rel="noopener" href="' + safeUrl(href) + '">open</a>' : ''); }).join(' ');
          return '<div class="ref"><div class="row between"><b>' + esc(x.name) + '</b>' + (x.consent ? badge('Agreed to be contacted', 'ok') : badge('No consent recorded', 'warn')) + '</div>' +
            '<div class="muted">' + esc([REL[x.relationship] || x.relationship, [x.job_title, x.company].filter(Boolean).join(' at '), x.years_known != null ? 'known ' + x.years_known + ' yr' : ''].filter(Boolean).join(' · ')) + '</div>' +
            '<div><a href="tel:' + esc(x.phone) + '">' + esc(x.phone) + '</a>' + (x.email ? ' · <a href="mailto:' + esc(x.email) + '">' + esc(x.email) + '</a>' : '') + '</div>' +
            (socials ? '<div class="chips">' + socials + '</div>' : '') + (x.note ? '<div class="faint">“' + esc(x.note) + '”</div>' : '') + '</div>';
        }).join('') || '<span class="faint">No references given</span>';
        var portfolio = (a.artisan_portfolio || []).filter(function (x) { return safeUrl(x.url); }).map(function (x) { return '<a target="_blank" rel="noopener" href="' + safeUrl(x.url) + '"><img alt="' + esc(x.caption || '') + '" src="' + safeUrl(x.url) + '"></a>'; }).join('');
        var acts = a.review_status === 'pending' ? '<button class="btn ghost-danger" data-areject="' + esc(a.user_id) + '">Send back</button><button class="btn ok" data-aapprove="' + esc(a.user_id) + '">Approve artisan</button>'
          : a.review_status === 'approved' ? '<button class="btn ghost-danger" data-arevoke="' + esc(a.user_id) + '">Withdraw approval</button>' : '';
        return '<div class="card stack"><div class="row between"><div class="row">' + avatar(p) + '<div><h3><a href="#/users/' + esc(a.user_id) + '">' + name(p) + '</a></h3><div class="faint">' + esc(p.phone || '') + ' · ' + esc(p.email || '') + '</div></div></div>' +
          '<div class="row">' + (p.nin_verified ? badge('NIN verified', 'ok') : badge('NIN not verified', 'bad')) + statusBadge(a.review_status) + '<span class="faint">' + (a.submitted_at ? 'submitted ' + ago(a.submitted_at) : '') + '</span></div></div>' +
          kv([['Primary skill', '<b>' + esc(a.skill_category || '—') + '</b>'], ['Other skills', '<div class="chips">' + ((a.additional_skills || []).map(function (s) { return badge(s, 'grey'); }).join('') || '—') + '</div>'],
            ['Service areas', '<div class="chips">' + ((a.service_areas || []).map(function (s) { return badge(s, 'grey'); }).join('') || '—') + '</div>'], ['Experience', esc(a.years_experience || 0) + ' years'],
            ['Home', esc([a.home_address, a.lga, a.state].filter(Boolean).join(', '))], a.bio ? ['Bio', esc(a.bio)] : null, a.review_note ? ['Last note', esc(a.review_note)] : null, ['Documents', '<div class="row">' + docs + '</div>']]) +
          (portfolio ? '<div><h3 style="margin-bottom:8px">Portfolio</h3><div class="gallery">' + portfolio + '</div></div>' : '') +
          '<div><h3 style="margin-bottom:8px">References</h3><div class="grid cols-2">' + refs + '</div></div>' +
          (acts ? '<div class="row" style="justify-content:flex-end">' + acts + '</div>' : '') + '</div>';
      }).join('') + '</div>' : '<div class="card empty">' + (tab === 'pending' ? 'No applications waiting. 🎉' : 'Nothing here.') + '</div>'));
      bind('[data-doc]', function (id) { api('/admin/artisan-documents/' + id + '/url').then(function (x) { window.open(x.url, '_blank', 'noopener'); }).catch(function (e) { toast(e.message, true); }); });
      bind('[data-aapprove]', function (id) { act(post('/admin/artisans/' + id + '/decision', { approve: true }), 'Artisan approved'); });
      bind('[data-areject]', function (id) { reason('Send application back', 'What needs fixing? (sent to the artisan)', { placeholder: 'e.g. Your ID photo is blurry: please upload a clearer one', confirm: 'Send back', danger: true })
        .then(function (m) { if (m) act(post('/admin/artisans/' + id + '/decision', { approve: false, reason: m.reason }), 'Application sent back'); }); });
      bind('[data-arevoke]', function (id) { reason('Withdraw artisan approval', 'Reason (sent to the artisan)', { body: 'They stop getting job alerts until they resubmit and you approve again.', confirm: 'Withdraw', danger: true })
        .then(function (m) { if (m) act(post('/admin/artisans/' + id + '/revoke', { reason: m.reason }), 'Approval withdrawn'); }); });
    }).catch(fail);
  };

  // ═════════ Reports ═════════
  PAGES.reports = function (r) {
    var tab = r.q.tab || 'open'; var page = Number(r.q.page || 1);
    shell('reports', 'Reports', 'Scam and misconduct reports filed by users.');
    api('/admin/reports' + qs({ status: tab === 'all' ? '' : tab, page: page, limit: PAGE })).then(function (j) {
      var list = j.reports || [];
      view(tabs([['open', 'Open'], ['investigating', 'Investigating'], ['resolved', 'Resolved'], ['dismissed', 'Dismissed'], ['all', 'All']], tab, function (t) { return '/reports?tab=' + t; }) +
        (list.length ? '<div class="stack">' + list.map(function (x) {
          var ev = (x.evidence_urls || []).filter(function (u) { return safeUrl(u); }).map(function (u) { return '<a target="_blank" rel="noopener" href="' + safeUrl(u) + '"><img class="thumb" alt="Evidence" src="' + safeUrl(u) + '"></a>'; }).join('');
          var agent = x.agent || {};
          return '<div class="card stack"><div class="row between"><div><h3>' + esc(x.reason) + '</h3><div class="faint">Reported ' + ago(x.created_at) + ' by ' + userLink(x.reporter) + '</div></div>' + statusBadge(x.status) + '</div>' +
            '<div class="row">Against: <b>' + userLink(agent) + '</b> <span class="faint">' + label(agent.role) + '</span>' + (agent.is_suspended ? badge('Suspended', 'bad') : '') + (x.reportsAgainstTotal > 1 ? badge(x.reportsAgainstTotal + ' reports in total', 'bad') : '') + '</div>' +
            (x.details ? '<div class="quote">' + esc(x.details) + '</div>' : '') + (ev ? '<div class="row">' + ev + '</div>' : '') + (x.admin_note ? '<div class="faint">Admin note: ' + esc(x.admin_note) + '</div>' : '') +
            '<div class="row" style="justify-content:flex-end">' + (x.booking_id ? '<a class="btn sm" href="#/bookings/' + esc(x.booking_id) + '">Booking</a>' : '') + (x.conversationId ? '<button class="btn sm" data-conv="' + esc(x.conversationId) + '">Read their chat</button>' : '') +
            (agent.id && !agent.is_suspended ? '<button class="btn ghost-danger" data-rsusp="' + esc(agent.id) + '">Suspend reported user</button>' : '') +
            '<button class="btn primary" data-rstat="' + esc(x.id) + '" data-cur="' + esc(x.status) + '">Update status</button></div></div>';
        }).join('') + '</div>' : '<div class="card empty">No reports here.</div>') + pager(page, j.total, r.raw));
      bind('[data-rstat]', function (id, el) {
        form({ title: 'Update report', fields: [{ name: 'status', label: 'Status', type: 'select', value: el.dataset.cur === 'open' ? 'investigating' : el.dataset.cur, options: [['open', 'Open'], ['investigating', 'Investigating'], ['resolved', 'Resolved: action taken'], ['dismissed', 'Dismissed: no breach']] },
          { name: 'adminNote', label: 'Internal note (optional)', type: 'textarea' }, { name: 'notifyReporter', label: 'Tell the reporter the outcome (when resolved or dismissed)', type: 'checkbox', value: true }], confirm: 'Save' })
          .then(function (m) { if (m) act(api('/admin/reports/' + id, { method: 'PATCH', body: { status: m.status, adminNote: m.adminNote, notifyReporter: !!m.notifyReporter } }), 'Report updated'); });
      });
      bind('[data-rsusp]', suspendFlow);
      bind('[data-conv]', openConversation);
    }).catch(fail);
  };
  function suspendFlow(id) {
    form({ title: 'Suspend this account?', body: 'They are signed out of the app and cannot sign in until you lift it.', fields: [
      { name: 'reason', label: 'Reason (kept in the audit log)', type: 'textarea', required: true, min: 3 },
      { name: 'notifyUser', label: 'Email them that their account is suspended (with the reason)', type: 'checkbox' }], confirm: 'Suspend', danger: true })
      .then(function (m) { if (m) act(post('/admin/users/' + id + '/suspend', { suspended: true, reason: m.reason, notifyUser: !!m.notifyUser }), 'Account suspended'); });
  }

  // ═════════ Reviews ═════════
  PAGES.reviews = function (r) {
    var tab = r.q.tab || 'true'; var page = Number(r.q.page || 1);
    shell('reviews', 'Reviews', 'Reviews flagged by agents or users.');
    api('/admin/reviews' + qs({ flagged: tab, page: page, limit: PAGE })).then(function (j) {
      var list = j.reviews || [];
      view(tabs([['true', 'Flagged'], ['hidden', 'Hidden'], ['false', 'All recent']], tab, function (t) { return '/reviews?tab=' + t; }) + (list.length ? '<div class="stack">' + list.map(function (x) {
        var reasons = (x.review_flags || []).map(function (f) { return f.reason; }).filter(Boolean);
        return '<div class="card stack"><div class="row between"><div><b>' + '★'.repeat(x.rating) + '<span class="faint">' + '★'.repeat(5 - x.rating) + '</span></b> <span class="muted">by ' + userLink(x.reviewer) + ' for ' + userLink(x.agent) + (x.properties ? ' · <a href="#/listings/' + esc(x.properties.id) + '">' + esc(x.properties.title) + '</a>' : '') + ' · ' + ago(x.created_at) + '</span></div>' +
          '<div class="row">' + (x.flag_count ? badge(x.flag_count + ' flag' + (x.flag_count === 1 ? '' : 's'), 'warn') : '') + (x.hidden ? badge('Hidden', 'grey') : '') + '</div></div>' +
          (x.comment ? '<div class="quote">' + esc(x.comment) + '</div>' : '<div class="faint">No comment</div>') + (x.reply ? '<div class="faint">Reply: ' + esc(x.reply) + '</div>' : '') + (reasons.length ? '<div class="faint">Flag reasons: ' + reasons.map(esc).join(' · ') + '</div>' : '') +
          '<div class="row" style="justify-content:flex-end">' + (x.flag_count && !x.hidden ? '<button class="btn" data-clear="' + esc(x.id) + '">Keep: clear flags</button>' : '') +
          '<button class="btn ' + (x.hidden ? '' : 'ghost-danger') + '" data-hide="' + esc(x.id) + '" data-h="' + (x.hidden ? '0' : '1') + '">' + (x.hidden ? 'Show again' : 'Hide review') + '</button></div></div>';
      }).join('') + '</div>' : '<div class="card empty">No reviews here.</div>') + pager(page, j.total, r.raw));
      bind('[data-hide]', function (id, el) { act(post('/admin/reviews/' + id + '/hide', { hidden: el.dataset.h === '1' }), el.dataset.h === '1' ? 'Review hidden' : 'Review visible again'); });
      bind('[data-clear]', function (id) { act(post('/admin/reviews/' + id + '/clear-flags'), 'Flags cleared'); });
    }).catch(fail);
  };

  // ═════════ Support ═════════
  PAGES.support = function (r) {
    var tab = r.q.tab || 'open'; var page = Number(r.q.page || 1);
    shell('support', 'Support tickets', 'Contact Support, bug reports and data requests from the app.');
    var filt = '<form class="row" id="tfilter" style="margin-bottom:12px"><input class="input" name="q" placeholder="Search subject or message" value="' + esc(r.q.q || '') + '"><select class="input" name="kind"><option value="">All kinds</option>' +
      [['support', 'Support'], ['bug', 'Bug reports'], ['data_request', 'Data requests']].map(function (x) { return '<option value="' + x[0] + '"' + (r.q.kind === x[0] ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('') + '</select><button class="btn">Filter</button></form>';
    api('/admin/tickets' + qs({ status: tab === 'all' ? '' : tab, kind: r.q.kind, q: r.q.q, page: page, limit: PAGE })).then(function (j) {
      var list = j.tickets || [];
      var kind = { support: ['Support', ''], bug: ['Bug', 'warn'], data_request: ['Data request', 'bad'] };
      view(tabs([['open', 'Open'], ['in_progress', 'In progress'], ['resolved', 'Resolved'], ['closed', 'Closed'], ['all', 'All']], tab, function (t) { return '/support' + qs({ tab: t, kind: r.q.kind }); }) + filt + (list.length ? '<div class="stack">' + list.map(function (t) {
        var k = kind[t.kind] || [t.kind, ''];
        var meta = t.meta && Object.keys(t.meta).length ? '<div class="faint">' + Object.keys(t.meta).map(function (m) { return esc(m) + ': ' + esc(typeof t.meta[m] === 'object' ? JSON.stringify(t.meta[m]) : t.meta[m]); }).join(' · ') + '</div>' : '';
        return '<div class="card stack"><div class="row between"><div class="row">' + badge(k[0], k[1]) + (t.severity ? badge(t.severity + ' severity', t.severity === 'high' ? 'bad' : 'grey') : '') + '<h3>' + esc(t.subject) + '</h3></div>' + statusBadge(t.status) + '</div>' +
          '<div class="faint">' + esc(t.category) + ' · from ' + userLink(t.user) + ' (' + esc(t.user && (t.user.email || t.user.phone) || '') + ') · ' + ago(t.created_at) + '</div>' +
          '<div class="quote">' + esc(t.message) + '</div>' + meta + (t.admin_note ? '<div class="faint">Last reply / note: ' + esc(t.admin_note) + '</div>' : '') +
          '<div class="row" style="justify-content:flex-end">' + (t.kind === 'data_request' && t.user ? '<a class="btn" href="#/users/' + esc(t.user.id) + '">Open account (export / close)</a>' : '') +
          '<button class="btn primary" data-tick="' + esc(t.id) + '" data-cur="' + esc(t.status) + '">Reply / update</button></div></div>';
      }).join('') + '</div>' : '<div class="card empty">No tickets here.</div>') + pager(page, j.total, r.raw));
      $('#tfilter').onsubmit = function (e) { e.preventDefault(); location.hash = '#/support' + qs({ tab: tab, q: e.target.q.value.trim(), kind: e.target.kind.value }); };
      bind('[data-tick]', function (id, el) {
        form({ title: 'Update ticket', fields: [{ name: 'status', label: 'Status', type: 'select', value: el.dataset.cur === 'open' ? 'in_progress' : el.dataset.cur, options: [['open', 'Open'], ['in_progress', 'In progress'], ['resolved', 'Resolved'], ['closed', 'Closed']] },
          { name: 'adminNote', label: 'Reply to the user (sent as a notification; optional)', type: 'textarea' }, { name: 'notifyUser', label: 'Send it to the user', type: 'checkbox', value: true }], confirm: 'Save' })
          .then(function (m) { if (m) act(api('/admin/tickets/' + id, { method: 'PATCH', body: { status: m.status, adminNote: m.adminNote, notifyUser: !!m.notifyUser } }), 'Ticket updated'); });
      });
    }).catch(fail);
  };

  // ═════════ Feedback ═════════
  PAGES.feedback = function (r) {
    var page = Number(r.q.page || 1); var rating = r.q.rating || '';
    shell('feedback', 'App feedback', 'What people say in “Rate RentCreeb”.');
    api('/admin/feedback' + qs({ rating: rating, page: page, limit: PAGE })).then(function (j) {
      var s = j.summary; var max = Math.max.apply(null, s.distribution.concat([1]));
      var dist = [5, 4, 3, 2, 1].map(function (n) { var c = s.distribution[n - 1]; return '<a class="bar-row" style="text-decoration:none;color:inherit" href="#/feedback?rating=' + n + '"><span>' + n + ' ★</span><div class="bar-track"><div class="bar-fill" style="width:' + Math.round(c / max * 100) + '%"></div></div><span class="num">' + c + '</span></a>'; }).join('');
      view('<div class="grid cols-2">' + section('Summary', '<div class="stat"><span class="n">' + (s.count ? s.average.toFixed(2) + ' ★' : '—') + '</span><span class="l">' + s.count + ' ratings</span></div>' + dist) + '</div>' +
        tabs([['', 'All'], ['5', '5 ★'], ['4', '4 ★'], ['3', '3 ★'], ['2', '2 ★'], ['1', '1 ★']], rating, function (t) { return '/feedback' + qs({ rating: t }); }) +
        '<div class="card">' + table(['When', 'Who', 'Rating', 'Tags', 'Comment', 'App'], j.feedback, function (f) {
          return '<tr><td class="num">' + when(f.created_at) + '</td><td>' + userLink(f.user) + '</td><td>' + '★'.repeat(f.rating) + '</td><td><div class="chips">' + (f.tags || []).map(function (t) { return badge(t, 'grey'); }).join('') + '</div></td><td>' + esc(f.comment || '') + '</td><td class="faint">' + esc([f.platform, f.app_version].filter(Boolean).join(' ')) + '</td></tr>';
        }, 'No feedback yet.') + '</div>' + pager(page, j.total, r.raw));
    }).catch(fail);
  };

  // ═════════ Users ═════════
  var ROLES = [['tenant', 'Tenant'], ['landlord', 'Landlord'], ['estate_manager', 'Estate manager'], ['agent', 'Agent'], ['artisan', 'Artisan'], ['admin', 'Admin']];
  PAGES.users = function (r) {
    if (r.path[1]) return userDetail(r.path[1]);
    var page = Number(r.q.page || 1);
    var f = { q: r.q.q, role: r.q.role, status: r.q.status, sort: r.q.sort };
    shell('users', 'Users', 'Search accounts, check activity, verify, message or suspend.', '<button class="btn sm" id="u-export">Export CSV</button>');
    var filters = '<form class="row" id="ufilter" style="margin-bottom:14px"><input class="input" name="q" placeholder="Name, email, phone or ID" value="' + esc(r.q.q || '') + '">' +
      '<select class="input" name="role"><option value="">All roles</option>' + ROLES.map(function (x) { return '<option' + (r.q.role === x[0] ? ' selected' : '') + ' value="' + x[0] + '">' + x[1] + '</option>'; }).join('') + '</select>' +
      '<select class="input" name="status"><option value="">Any status</option>' + [['verified', 'NIN verified'], ['phone_only', 'Phone verified only'], ['unverified', 'Not NIN verified'], ['active', 'Not suspended'], ['suspended', 'Suspended'], ['deleted', 'Deleted']].map(function (x) { return '<option' + (r.q.status === x[0] ? ' selected' : '') + ' value="' + x[0] + '">' + x[1] + '</option>'; }).join('') + '</select>' +
      '<select class="input" name="sort">' + [['newest', 'Newest first'], ['oldest', 'Oldest first'], ['name', 'By name']].map(function (x) { return '<option' + (r.q.sort === x[0] ? ' selected' : '') + ' value="' + x[0] + '">' + x[1] + '</option>'; }).join('') + '</select>' +
      '<button class="btn primary">Filter</button></form>';
    api('/admin/users' + qs(Object.assign({ page: page, limit: PAGE }, f))).then(function (j) {
      view(filters + '<div class="card">' + table(['Name', 'Role', 'Contact', 'Status', 'Joined'], j.users, function (u) {
        return '<tr class="click" data-go="#/users/' + esc(u.id) + '"><td><div class="row">' + avatar(u) + '<b>' + name(u) + '</b></div></td><td>' + label(u.role) + '</td><td>' + esc(u.email || '') + '<div class="faint">' + esc(u.phone || '') + '</div></td>' +
          '<td><div class="chips">' + (u.deleted_at ? badge('Deleted', 'grey') : u.is_suspended ? badge('Suspended', 'bad') : '') + (u.nin_verified ? badge('NIN verified', 'ok') : u.phone_verified ? badge('Phone only', 'warn') : badge('Unverified', 'grey')) + '</div></td><td class="num">' + when(u.created_at) + '</td></tr>';
      }, 'No users match.') + '</div>' + pager(page, j.total, r.raw));
      $('#ufilter').onsubmit = function (e) { e.preventDefault(); var x = e.target; location.hash = '#/users' + qs({ q: x.q.value.trim(), role: x.role.value, status: x.status.value, sort: x.sort.value }); };
      bindGo();
    }).catch(fail);
    on('u-export', function () { download('/admin/users/export' + qs(f), 'rentcreeb-users.csv'); });
  };

  function userDetail(id) {
    shell('users', 'User', '', '<a class="btn sm" href="#/users">← All users</a>');
    api('/admin/users/' + encodeURIComponent(id)).then(function (j) {
      var u = j.user, a = j.artisan, au = j.auth || {}, self = u.id === me.id, closed = !!u.deleted_at;
      shell('users', plainName(u) || 'User', label(u.role).replace(/&amp;/g, '&') + ' · joined ' + when(u.created_at), '<a class="btn sm" href="#/users">← All users</a>');
      var menuItems = closed ? '' : [
        '<button data-ua="edit">Edit profile</button>', self ? '' : '<button data-ua="role">Change role</button>', '<button data-ua="message">Send a message</button>', u.email ? '<button data-ua="reset">Send password reset email</button>' : '',
        '<hr>', u.nin_verified ? '<button data-ua="revoke" class="danger-text">Revoke NIN verification</button>' : '<button data-ua="verify">Mark NIN verified</button>', !u.nin_verified ? '<button data-ua="attempts">Reset verification attempts</button>' : '',
        u.phone ? (u.phone_verified ? '<button data-ua="phoneoff">Mark phone unverified</button>' : '<button data-ua="phoneon">Mark phone verified</button>') : '',
        '<hr>', '<button data-ua="credit">Credit wallet</button>', '<button data-ua="debit">Debit wallet</button>', ['agent', 'landlord', 'estate_manager'].indexOf(u.role) >= 0 ? '<button data-ua="grant">Give a subscription plan</button>' : '',
        '<hr>', self ? '' : u.is_suspended ? '<button data-ua="unsuspend">Lift suspension</button>' : '<button data-ua="suspend" class="danger-text">Suspend account</button>', self ? '' : '<button data-ua="close" class="danger-text">Close account (anonymise)</button>',
      ].join('');
      var banner = closed ? '<div class="alert grey" style="background:var(--bg)">This account was closed on ' + when(u.deleted_at) + '.</div>' : u.is_suspended ? '<div class="alert bad">Suspended' + (u.suspended_at ? ' ' + when(u.suspended_at) : '') + (u.suspended_reason ? ': ' + esc(u.suspended_reason) : '') + '</div>' : '';
      var w = j.wallet;
      view('<div class="stack">' + banner + '<div class="card row between"><div class="row">' + avatar(u) + '<div><h2>' + name(u) + '</h2><div class="chips">' + (closed ? badge('Closed', 'grey') : u.is_suspended ? badge('Suspended', 'bad') : badge('Active', 'ok')) +
        (u.nin_verified ? badge('NIN verified', 'ok') : badge('NIN not verified', 'warn')) + (u.phone_verified ? badge('Phone verified', 'ok') : '') + badge(label(u.role).replace(/&amp;/g, '&'), 'grey') + (j.presence && j.presence.online ? badge('Online now', 'ok') : '') + '</div></div></div>' +
        (menuItems ? '<div class="menu"><button class="btn primary">Actions ▾</button><div class="menu-list">' + menuItems + '</div></div>' : '') + '</div>' +
        '<div class="grid cols-2">' + section('Account', kv([['Email', esc(u.email || '') + (au.email ? (au.emailConfirmed ? ' ' + badge('confirmed', 'ok') : ' ' + badge('unconfirmed', 'warn')) : '')], ['Phone', esc(u.phone || '')], ['Username', esc(u.username || '')],
          ['Sign-in', esc((au.providers || []).join(', '))], ['Last sign-in', au.lastSignInAt ? when(au.lastSignInAt) + ' <span class="faint">' + ago(au.lastSignInAt) + '</span>' : ''], ['Last seen', j.presence && j.presence.lastSeen ? ago(j.presence.lastSeen) : ''],
          ['Push notifications', j.pushEnabled ? 'On' : 'Off'], ['Gender', label(u.gender || '')], ['Date of birth', u.date_of_birth ? day(u.date_of_birth) : ''], ['Location', esc(u.location || '')], ['Agency', esc(u.agency_name || '')], ['Licence no.', esc(u.license_number || '')],
          ['Rating', u.rating_count ? Number(u.rating_avg).toFixed(1) + ' ★ from ' + u.rating_count : ''], ['Reports filed', esc(j.reportsFiled)], ['User ID', '<span class="faint">' + esc(u.id) + '</span>']])) +
        '<div class="stack">' + section('Wallet', '<div class="stat"><span class="n">' + naira(w ? w.available_kobo : 0) + '</span><span class="l">Available balance</span></div>' +
          (j.bankAccount ? '<div class="faint">Payout account: ' + esc(j.bankAccount.bank_name || '') + ' · ' + esc(j.bankAccount.account_number) + ' · ' + esc(j.bankAccount.account_name) + '</div>' : '<div class="faint">No payout account</div>') +
          table(['When', 'Type', 'Amount', 'Description'], j.walletTransactions.slice(0, 8), function (t) { return '<tr><td class="num">' + when(t.created_at) + '</td><td>' + label(t.kind) + '</td><td class="num" style="color:var(' + (t.direction === 'credit' ? '--success' : '--danger') + ')">' + (t.direction === 'credit' ? '+' : '−') + naira(t.amount_kobo) + '</td><td class="faint">' + esc(t.description || '') + '</td></tr>'; }, 'No wallet activity')) +
          section('Identity verification', '<div class="row">' + (u.nin_verified ? badge('Verified', 'ok') : badge('Not verified', 'warn')) + '<span class="faint">Attempts used: ' + j.attempts.used + ' of ' + j.attempts.max + '</span></div>' +
            table(['Status', 'Reason', 'Score', 'When'], j.verifications, function (v) { return '<tr class="click" data-go="#/verifications/' + esc(v.id) + '"><td>' + statusBadge(v.status) + '</td><td>' + reasonBadge(v) + (v.hasSelfie || v.hasDocument ? ' 📎' : '') + '</td><td class="num">' + (v.confidence != null ? Math.round(v.confidence) + '%' : '—') + '</td><td class="num">' + when(v.created_at) + '</td></tr>'; }, 'No ID checks yet')) +
          (a ? section('Artisan profile', kv([['Status', statusBadge(a.review_status)], ['Skill', esc(a.skill_category || '')], ['Other skills', esc((a.additional_skills || []).join(', '))], ['Areas', esc((a.service_areas || []).join(', '))], a.review_note ? ['Last note', esc(a.review_note)] : null]) + '<a class="btn sm" href="#/artisans?tab=' + esc(a.review_status) + '">Open in Artisans →</a>') : '') + '</div></div>' +
        '<div class="grid cols-2">' +
        section('Listings (' + j.properties.length + ')', table(['Title', 'Status', 'Price'], j.properties, function (p) { return '<tr class="click" data-go="#/listings/' + esc(p.id) + '"><td>' + esc(p.title) + '<div class="faint">' + esc(p.area || '') + '</div></td><td>' + statusBadge(p.status) + '</td><td class="num">' + naira(p.price_kobo) + '</td></tr>'; }, 'None')) +
        section('Bookings (' + j.bookings.length + ')', table(['Property', 'As', 'Status', 'Date'], j.bookings, function (b) { return '<tr class="click" data-go="#/bookings/' + esc(b.id) + '"><td>' + esc(b.properties && b.properties.title || '—') + '</td><td>' + (b.tenant_id === u.id ? 'tenant' : 'host') + '</td><td>' + statusBadge(b.status) + '</td><td class="num">' + when(b.scheduled_at) + '</td></tr>'; }, 'None')) +
        section('Payments (' + j.payments.length + ')', table(['Purpose', 'Amount', 'Status', 'When'], j.payments, function (p) { return '<tr class="click" data-pay="' + esc(p.id) + '"><td>' + label(p.purpose) + '</td><td class="num">' + naira(p.amount_kobo) + '</td><td>' + statusBadge(p.status) + '</td><td class="num">' + when(p.paid_at || p.created_at) + '</td></tr>'; }, 'None')) +
        section('Withdrawals', table(['Amount', 'Status', 'When'], j.withdrawals, function (x) { return '<tr><td class="num">' + naira(x.amount_kobo) + '</td><td>' + statusBadge(x.status) + '</td><td class="num">' + when(x.created_at) + '</td></tr>'; }, 'None')) +
        (j.subscriptions.length ? section('Subscriptions', table(['Plan', 'Status', 'Expires'], j.subscriptions, function (s) { return '<tr><td>' + esc(s.subscription_plans && s.subscription_plans.name || '') + '</td><td>' + statusBadge(s.status) + '</td><td class="num">' + day(s.expires_at) + '</td></tr>'; })) : '') +
        (j.tenancies.length ? section('Tenancies', table(['Property', 'As', 'Status', 'Rent'], j.tenancies, function (t) { return '<tr class="click" data-go="#/tenancies/' + esc(t.id) + '"><td>' + esc(t.properties && t.properties.title || '') + '</td><td>' + (t.landlord_id === u.id ? 'landlord' : 'tenant') + '</td><td>' + statusBadge(t.status) + '</td><td class="num">' + naira(t.rent_kobo) + '</td></tr>'; })) : '') +
        (j.jobs.length ? section('Jobs', table(['Title', 'As', 'Status'], j.jobs, function (x) { return '<tr class="click" data-go="#/jobs/' + esc(x.id) + '"><td>' + esc(x.title) + '</td><td>' + (x.artisan_id === u.id ? 'artisan' : 'landlord') + '</td><td>' + statusBadge(x.status) + '</td></tr>'; })) : '') +
        (j.tickets.length ? section('Support tickets', table(['Subject', 'Kind', 'Status', 'When'], j.tickets, function (t) { return '<tr><td>' + esc(t.subject) + '</td><td>' + label(t.kind) + '</td><td>' + statusBadge(t.status) + '</td><td class="num">' + ago(t.created_at) + '</td></tr>'; })) : '') +
        section('Reports against them', table(['Reason', 'Status', 'When'], j.reportsAgainst, function (x) { return '<tr><td>' + esc(x.reason) + '</td><td>' + statusBadge(x.status) + '</td><td class="num">' + when(x.created_at) + '</td></tr>'; }, 'None')) +
        (j.reviewsAbout.length ? section('Reviews about them', table(['Rating', 'Comment', 'When'], j.reviewsAbout, function (x) { return '<tr><td>' + '★'.repeat(x.rating) + (x.hidden ? ' ' + badge('hidden', 'grey') : '') + '</td><td class="faint">' + esc(String(x.comment || '').slice(0, 100)) + '</td><td class="num">' + ago(x.created_at) + '</td></tr>'; })) : '') +
        section('Conversations', '<div id="u-convs"><button class="btn sm" id="u-loadconv">Show their conversations</button></div>') +
        '</div>' + notesBlock('user', u.id, j.notes) + '</div>');
      bindGo(); bindMenus(); bindNotes(); bind('[data-pay]', paymentDialog);
      on('u-loadconv', function () {
        api('/admin/conversations' + qs({ userId: u.id })).then(function (c) {
          $('#u-convs').innerHTML = table(['With', 'About', 'Started', ''], c.conversations, function (x) {
            var other = x.a && x.a.id === u.id ? x.b : x.a;
            return '<tr><td>' + userLink(other) + '</td><td>' + label(x.context_type) + '</td><td class="num">' + day(x.created_at) + '</td><td><button class="btn sm" data-conv="' + esc(x.id) + '">Read</button></td></tr>';
          }, 'No conversations');
          bind('[data-conv]', openConversation);
        }).catch(function (e) { toast(e.message, true); });
      });
      var A = {
        edit: function () { form({ title: 'Edit profile', fields: [{ name: 'firstName', label: 'First name', value: u.first_name, required: true }, { name: 'lastName', label: 'Last name', value: u.last_name, required: true },
          { name: 'phone', label: 'Phone', value: u.phone, hint: 'Changing it marks the phone as unverified.' }, { name: 'reason', label: 'Reason (audit log)', type: 'textarea' }], confirm: 'Save' })
          .then(function (v) { if (v) act(api('/admin/users/' + u.id, { method: 'PATCH', body: { firstName: v.firstName, lastName: v.lastName, phone: v.phone || null, reason: v.reason } }), 'Profile updated'); }); },
        role: function () { form({ title: 'Change role', body: 'Making someone an admin gives them full access to this dashboard.', fields: [{ name: 'role', label: 'Role', type: 'select', value: u.role, options: ROLES }, { name: 'reason', label: 'Reason (audit log)', type: 'textarea', required: true, min: 3 }], confirm: 'Change role', danger: true })
          .then(function (v) { if (v && v.role !== u.role) act(api('/admin/users/' + u.id, { method: 'PATCH', body: { role: v.role, reason: v.reason } }), 'Role changed'); }); },
        message: function () { form({ title: 'Message ' + plainName(u), body: 'Arrives as an in-app notification and push.', fields: [{ name: 'title', label: 'Title', required: true }, { name: 'body', label: 'Message', type: 'textarea', required: true }, { name: 'email', label: 'Also send by email', type: 'checkbox', value: !!u.email }], confirm: 'Send' })
          .then(function (v) { if (v) act(post('/admin/users/' + u.id + '/notify', { title: v.title, body: v.body, email: !!v.email }), 'Message sent'); }); },
        reset: function () { form({ title: 'Send a password reset email?', body: 'A reset link goes to ' + u.email + '.', confirm: 'Send' }).then(function (v) { if (v) act(post('/admin/users/' + u.id + '/password-reset'), 'Reset email sent'); }); },
        verify: function () { form({ title: 'Mark NIN verified?', body: 'Only after checking their ID document against this account (for example on a video call). Uses their open review if they have one.', fields: [{ name: 'note', label: 'How did you check? (audit log)', type: 'textarea', required: true, min: 3 }], confirm: 'Verify' })
          .then(function (v) { if (v) act(post('/admin/users/' + u.id + '/verify', { note: v.note }), 'User verified'); }); },
        revoke: function () { form({ title: 'Revoke NIN verification', body: 'They lose full access and the NIN is freed so its real owner can verify.', fields: [{ name: 'reason', label: 'Reason (sent to the user)', type: 'textarea', required: true, min: 3 }, { name: 'notifyUser', label: 'Notify the user', type: 'checkbox', value: true }], confirm: 'Revoke', danger: true })
          .then(function (v) { if (v) act(post('/admin/users/' + u.id + '/revoke-verification', { reason: v.reason, notifyUser: !!v.notifyUser }), 'Verification revoked'); }); },
        attempts: function () { act(post('/admin/users/' + u.id + '/reset-attempts'), 'Attempts reset: they can verify again'); },
        phoneon: function () { act(api('/admin/users/' + u.id, { method: 'PATCH', body: { phoneVerified: true, reason: 'Marked by admin' } }), 'Phone marked verified'); },
        phoneoff: function () { act(api('/admin/users/' + u.id, { method: 'PATCH', body: { phoneVerified: false, reason: 'Marked by admin' } }), 'Phone marked unverified'); },
        credit: function () { walletFlow('credit'); }, debit: function () { walletFlow('debit'); },
        grant: function () {
          api('/admin/plans').then(function (p) {
            form({ title: 'Give a subscription plan', body: 'No payment is taken. Any current plan is ended.', fields: [{ name: 'planId', label: 'Plan', type: 'select', options: p.plans.map(function (x) { return [x.id, x.name + ' (' + naira(x.price_kobo) + ')']; }) },
              { name: 'days', label: 'Days', type: 'number', value: 30, required: true }, { name: 'reason', label: 'Reason (audit log)', type: 'textarea', required: true, min: 3 }], confirm: 'Give plan' })
              .then(function (v) { if (v) act(post('/admin/subscriptions/grant', { userId: u.id, planId: v.planId, days: v.days, reason: v.reason }), 'Plan given'); });
          }).catch(function (e) { toast(e.message, true); });
        },
        suspend: function () { suspendFlow(u.id); },
        unsuspend: function () { act(post('/admin/users/' + u.id + '/suspend', { suspended: false }), 'Suspension lifted'); },
        close: function () {
          form({ title: 'Close this account?', body: 'Their name, email, phone and photo are removed, listings are archived and sign-in is blocked. Payments and bookings stay for other users. This cannot be undone.',
            fields: [{ name: 'reason', label: 'Reason (audit log)', type: 'textarea', required: true, min: 3, placeholder: 'e.g. Data deletion request, ticket #…' },
              { name: 'force', label: 'Close even with a wallet balance or upcoming bookings', type: 'checkbox' }, { name: 'confirm', label: 'Type CLOSE to confirm', required: true }], confirm: 'Close account', danger: true })
            .then(function (v) { if (!v) return; if (v.confirm !== 'CLOSE') { toast('Type CLOSE to confirm', true); return; } act(post('/admin/users/' + u.id + '/close', { confirm: 'CLOSE', reason: v.reason, force: !!v.force }), 'Account closed'); });
        },
      };
      function walletFlow(dir) {
        form({ title: dir === 'credit' ? 'Credit wallet' : 'Debit wallet', body: 'Balance now: ' + naira(w ? w.available_kobo : 0) + '. The user is notified. Use for goodwill refunds or fixing mistakes.',
          fields: [{ name: 'amount', label: 'Amount (₦)', type: 'money', required: true }, { name: 'reason', label: 'Reason (shown to the user and in the audit log)', type: 'textarea', required: true, min: 5 }], confirm: dir === 'credit' ? 'Credit' : 'Debit', danger: dir === 'debit' })
          .then(function (v) { if (v) act(post('/admin/users/' + u.id + '/wallet-adjust', { direction: dir, amountKobo: v.amount, reason: v.reason }), 'Wallet ' + (dir === 'credit' ? 'credited' : 'debited')); });
      }
      bind('[data-ua]', function (k) { $$('.menu.open').forEach(function (x) { x.classList.remove('open'); }); if (A[k]) A[k](); });
    }).catch(fail);
  }

  // ═════════ Finance ═════════
  PAGES.finance = function (r) {
    var days = Number(r.q.days || 30);
    shell('finance', 'Finance', 'Money in, revenue and what RentCreeb is holding for users.');
    api('/admin/finance' + qs({ days: days })).then(function (j) {
      var stat = function (n, l, href) { return (href ? '<a class="card stat" href="' + href + '">' : '<div class="card stat">') + '<span class="n">' + n + '</span><span class="l">' + esc(l) + '</span>' + (href ? '</a>' : '</div>'); };
      view(tabs([['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['365', '12 months']], String(days), function (t) { return '/finance?days=' + t; }) +
        '<h2 class="section-title">Last ' + j.days + ' days</h2><div class="grid cols-4">' + stat(naira(j.grossKobo), 'Successful payments', '#/payments?status=success') + stat(naira(j.revenue.totalKobo), 'RentCreeb revenue (plans + fees)') +
        stat(naira(j.revenue.subscriptionsKobo), 'Subscription revenue', '#/subscriptions') + stat(naira(j.revenue.escrowFeesKobo), 'Fees on released escrow', '#/escrow?tab=released') + stat(j.failedPayments, 'Failed payments', '#/payments?status=failed') + '</div>' +
        '<h2 class="section-title">Held for users right now</h2><div class="grid cols-4">' + stat(naira(j.liabilities.escrowHeldKobo), 'In escrow', '#/escrow') + stat(naira(j.liabilities.walletBalancesKobo), 'In user wallets') + stat(naira(j.liabilities.pendingWithdrawalsKobo), 'Withdrawals in progress', '#/withdrawals?tab=pending') + '</div>' +
        '<div class="grid cols-2" style="margin-top:14px">' + section('Payments per day', chart(j.daily, naira)) +
        section('By purpose', table(['Purpose', 'Amount'], Object.keys(j.byPurpose).sort(function (a, b) { return j.byPurpose[b] - j.byPurpose[a]; }), function (k) { return '<tr><td><a href="#/payments?status=success&purpose=' + esc(k) + '">' + label(k) + '</a></td><td class="num"><b>' + naira(j.byPurpose[k]) + '</b></td></tr>'; }, 'No payments')) + '</div>');
    }).catch(fail);
  };

  // ═════════ Payments ═════════
  var PURPOSES = ['inspection', 'subscription', 'rent', 'rentsave', 'job_escrow', 'job_topup'];
  PAGES.payments = function (r) {
    var page = Number(r.q.page || 1);
    var f = { q: r.q.q, status: r.q.status, purpose: r.q.purpose, from: r.q.from, to: r.q.to };
    shell('payments', 'Payments', 'Every Paystack payment. Re-check stuck ones with Paystack.', '<button class="btn sm" id="p-export">Export CSV</button>');
    var filters = '<form class="row" id="pfilter" style="margin-bottom:14px"><input class="input" name="q" placeholder="Reference, payment or user ID" value="' + esc(r.q.q || '') + '">' +
      '<select class="input" name="status"><option value="">Any status</option>' + ['success', 'pending', 'failed', 'refunded'].map(function (x) { return '<option' + (r.q.status === x ? ' selected' : '') + '>' + x + '</option>'; }).join('') + '</select>' +
      '<select class="input" name="purpose"><option value="">Any purpose</option>' + PURPOSES.map(function (x) { return '<option value="' + x + '"' + (r.q.purpose === x ? ' selected' : '') + '>' + label(x) + '</option>'; }).join('') + '</select>' +
      '<input class="input" type="date" name="from" value="' + esc(r.q.from || '') + '" aria-label="From"><input class="input" type="date" name="to" value="' + esc(r.q.to || '') + '" aria-label="To"><button class="btn primary">Filter</button></form>';
    api('/admin/payments' + qs(Object.assign({ page: page, limit: PAGE }, f))).then(function (j) {
      view(filters + '<div class="card">' + table(['When', 'Payer', 'Purpose', 'Amount', 'Status', 'Channel', 'Reference'], j.payments, function (p) {
        return '<tr class="click" data-pay="' + esc(p.id) + '"><td class="num">' + when(p.paid_at || p.created_at) + '</td><td>' + name(p.user) + '</td><td>' + label(p.purpose) + '</td><td class="num"><b>' + naira(p.amount_kobo) + '</b></td><td>' + statusBadge(p.status) + '</td><td>' + esc(p.channel || '—') + '</td><td class="faint">' + esc(p.reference) + '</td></tr>';
      }, 'No payments match.') + '</div>' + pager(page, j.total, r.raw));
      $('#pfilter').onsubmit = function (e) { e.preventDefault(); var x = e.target; location.hash = '#/payments' + qs({ q: x.q.value.trim(), status: x.status.value, purpose: x.purpose.value, from: x.from.value, to: x.to.value }); };
      bind('[data-pay]', paymentDialog);
    }).catch(fail);
    on('p-export', function () { download('/admin/payments/export' + qs(f), 'rentcreeb-payments.csv'); });
  };
  function paymentDialog(id) {
    api('/admin/payments/' + id).then(function (j) {
      var p = j.payment;
      var links = [p.booking_id ? '<a href="#/bookings/' + esc(p.booking_id) + '">Booking</a>' : '', p.job_id ? '<a href="#/jobs/' + esc(p.job_id) + '">Job</a>' : '', p.tenancy_id ? '<a href="#/tenancies/' + esc(p.tenancy_id) + '">Tenancy</a>' : ''].filter(Boolean).join(' · ');
      var html = kv([['Amount', '<b>' + naira(p.amount_kobo) + '</b>'], ['Status', statusBadge(p.status)], ['Purpose', label(p.purpose)], ['Payer', userLink(p.user) + ' <span class="faint">' + esc(p.user && (p.user.email || p.user.phone) || '') + '</span>'],
        ['Reference', '<span class="faint">' + esc(p.reference) + '</span>'], ['Channel', esc(p.channel || '')], ['Created', when(p.created_at)], ['Paid', when(p.paid_at)], ['Linked to', links]]) +
        (j.escrows.length ? '<h3>Escrow</h3>' + table(['Kind', 'Amount', 'Fee', 'Status'], j.escrows, function (e) { return '<tr><td>' + label(e.kind) + '</td><td class="num">' + naira(e.amount_kobo) + '</td><td class="num">' + naira(e.fee_kobo) + '</td><td>' + statusBadge(e.status) + '</td></tr>'; }) : '') +
        (p.status === 'pending' ? '<div class="alert warn">Still pending. If the person says they paid, re-check with Paystack: it is safe to do more than once.</div>' : '');
      form({ title: 'Payment', html: html, wide: true, confirm: p.status === 'pending' ? 'Re-check with Paystack' : false }).then(function (v) {
        if (v) act(post('/admin/payments/' + p.id + '/recheck'), null).then(function (x) { toast('Paystack says: ' + x.status + (x.before !== x.status ? ' (was ' + x.before + ')' : ' (no change)')); });
      });
    }).catch(function (e) { toast(e.message, true); });
  }

  // ═════════ Bookings ═════════
  var BSTATUS = ['pending_payment', 'paid', 'confirmed', 'completed', 'cancelled', 'refunded', 'expired', 'declined'];
  PAGES.bookings = function (r) {
    if (r.path[1]) return bookingDetail(r.path[1]);
    var tab = r.q.tab || 'all'; var page = Number(r.q.page || 1);
    shell('bookings', 'Bookings', 'Property inspections booked and paid for in the app.');
    api('/admin/bookings' + qs({ status: tab === 'all' ? '' : tab, q: r.q.q, page: page, limit: PAGE })).then(function (j) {
      view(tabs([['all', 'All']].concat(BSTATUS.map(function (s) { return [s, String(s).replace('_', ' ')]; })), tab, function (t) { return '/bookings?tab=' + t; }) +
        '<div class="card">' + table(['Property', 'Tenant', 'Host', 'Inspection', 'Amount', 'Status'], j.bookings, function (b) {
          return '<tr class="click" data-go="#/bookings/' + esc(b.id) + '"><td>' + esc(b.properties && b.properties.title || '—') + '<div class="faint">' + esc(b.properties && b.properties.area || '') + '</div></td><td>' + name(b.tenant) + '</td><td>' + name(b.host) + '</td><td class="num">' + when(b.scheduled_at) + '</td><td class="num">' + naira(b.amount_kobo) + '</td><td>' + statusBadge(b.status) + '</td></tr>';
        }, 'No bookings.') + '</div>' + pager(page, j.total, r.raw));
      bindGo();
    }).catch(fail);
  };
  function bookingDetail(id) {
    shell('bookings', 'Booking', '', '<a class="btn sm" href="#/bookings">← Bookings</a>');
    api('/admin/bookings/' + encodeURIComponent(id)).then(function (j) {
      var b = j.booking; var held = j.escrows.filter(function (e) { return e.status === 'held'; })[0];
      shell('bookings', 'Booking: ' + (b.properties && b.properties.title || ''), 'Inspection ' + when(b.scheduled_at), '<a class="btn sm" href="#/bookings">← Bookings</a>');
      var canCancel = ['pending_payment', 'paid', 'confirmed'].indexOf(b.status) >= 0, canComplete = ['paid', 'confirmed'].indexOf(b.status) >= 0;
      view('<div class="stack"><div class="card row between"><div class="row">' + statusBadge(b.status) + (held ? badge(naira(held.amount_kobo) + ' held in escrow', 'warn') : '') + '</div><div class="row">' +
        (j.conversationId ? '<button class="btn" data-conv="' + esc(j.conversationId) + '">Read their chat</button>' : '') +
        (canComplete ? '<button class="btn ok" id="b-complete">Mark done & pay host</button>' : '') + (canCancel ? '<button class="btn ghost-danger" id="b-cancel">Cancel' + (b.status !== 'pending_payment' ? ' & refund' : '') + '</button>' : '') + '</div></div>' +
        '<div class="grid cols-2">' + section('Details', kv([['Property', b.properties ? '<a href="#/listings/' + esc(b.properties.id) + '">' + esc(b.properties.title) + '</a>' : ''], ['Tenant', userLink(b.tenant) + ' <span class="faint">' + esc(b.tenant && b.tenant.phone || '') + '</span>'],
          ['Host', userLink(b.host) + ' <span class="faint">' + esc(b.host && b.host.phone || '') + '</span>'], ['Inspection', when(b.scheduled_at)], ['Amount', naira(b.amount_kobo)], ['Platform fee', naira(b.fee_kobo)], ['Refunded', b.refund_kobo ? naira(b.refund_kobo) : ''],
          ['Booked', when(b.created_at)], ['Confirmed', when(b.confirmed_at)], ['Completed', when(b.completed_at)], ['Cancel reason', esc(b.cancelled_reason || '')]])) +
        '<div class="stack">' + section('Payments', table(['Reference', 'Amount', 'Status'], j.payments, function (p) { return '<tr class="click" data-pay="' + esc(p.id) + '"><td class="faint">' + esc(p.reference) + '</td><td class="num">' + naira(p.amount_kobo) + '</td><td>' + statusBadge(p.status) + '</td></tr>'; }, 'No payment')) +
        section('Escrow', table(['Amount', 'Fee', 'Status', 'Since'], j.escrows, function (e) { return '<tr><td class="num">' + naira(e.amount_kobo) + '</td><td class="num">' + naira(e.fee_kobo) + '</td><td>' + statusBadge(e.status) + '</td><td class="num">' + when(e.released_at || e.created_at) + '</td></tr>'; }, 'No escrow')) +
        (j.reports.length ? section('Reports', table(['Reason', 'Status'], j.reports, function (x) { return '<tr class="click" data-go="#/reports?tab=all"><td>' + esc(x.reason) + '</td><td>' + statusBadge(x.status) + '</td></tr>'; })) : '') + '</div></div>' +
        notesBlock('booking', b.id, j.notes) + '</div>');
      bindGo(); bindNotes(); bind('[data-conv]', openConversation); bind('[data-pay]', paymentDialog);
      on('b-cancel', function () {
        var fields = [{ name: 'reason', label: 'Reason (sent to tenant and host)', type: 'textarea', required: true, min: 3 }];
        if (b.status !== 'pending_payment') fields.push({ name: 'refund', label: 'Refund to tenant (₦)', type: 'money', value: (Number(held ? held.amount_kobo : b.amount_kobo) / 100).toString(), hint: 'Full amount by default. Refunds go back through Paystack.' });
        form({ title: 'Cancel this booking', fields: fields, confirm: 'Cancel booking', danger: true }).then(function (v) { if (v) act(post('/admin/bookings/' + b.id + '/cancel', { reason: v.reason, refundKobo: v.refund == null ? undefined : v.refund }), 'Booking cancelled'); });
      });
      on('b-complete', function () { reason('Mark inspection done?', 'Why are you completing it? (audit log)', { body: 'Releases the inspection fee from escrow to the host’s wallet.', placeholder: 'e.g. Tenant confirmed by phone that the inspection happened', confirm: 'Complete & pay host' })
        .then(function (v) { if (v) act(post('/admin/bookings/' + b.id + '/complete', { reason: v.reason }), 'Booking completed'); }); });
    }).catch(fail);
  }

  // ═════════ Escrow ═════════
  PAGES.escrow = function (r) {
    var tab = r.q.tab || 'held'; var page = Number(r.q.page || 1);
    shell('escrow', 'Escrow', 'Money held between payer and payee until an inspection or job is done. Settle disputes here.');
    api('/admin/escrows' + qs({ status: tab, kind: r.q.kind, page: page, limit: PAGE })).then(function (j) {
      view(tabs([['held', 'Held'], ['released', 'Released'], ['refunded', 'Refunded']], tab, function (t) { return '/escrow?tab=' + t; }) +
        '<div class="card">' + table(['Since', 'Kind', 'Payer', 'Payee', 'Amount', 'Fee', 'For', ''], j.escrows, function (e) {
          var link = e.booking_id ? '<a href="#/bookings/' + esc(e.booking_id) + '">booking</a>' : e.job_id ? '<a href="#/jobs/' + esc(e.job_id) + '">job</a>' : '';
          var acts = e.status === 'held' ? '<div class="row"><button class="btn ok sm" data-erel="' + esc(e.id) + '" data-amt="' + esc(e.amount_kobo - e.fee_kobo) + '">Release</button><button class="btn ghost-danger sm" data-eref="' + esc(e.id) + '" data-amt="' + esc(e.amount_kobo) + '">Refund</button></div>' : statusBadge(e.status);
          return '<tr><td class="num">' + when(e.created_at) + '<div class="faint">' + ago(e.created_at) + '</div></td><td>' + label(e.kind) + '</td><td>' + userLink(e.payer) + '</td><td>' + userLink(e.payee) + '</td><td class="num"><b>' + naira(e.amount_kobo) + '</b></td><td class="num">' + naira(e.fee_kobo) + '</td><td>' + link + '</td><td>' + acts + '</td></tr>';
        }, 'Nothing here.') + '</div>' + pager(page, j.total, r.raw));
      bind('[data-erel]', function (id, el) { reason('Release to payee?', 'Reason (audit log)', { body: naira(el.dataset.amt) + ' (after fee) goes to the payee’s wallet.', confirm: 'Release' }).then(function (v) { if (v) act(post('/admin/escrows/' + id + '/release', { reason: v.reason }), 'Escrow released'); }); });
      bind('[data-eref]', function (id, el) {
        form({ title: 'Refund the payer', body: 'Refunds go back through Paystack to their card or bank.', fields: [{ name: 'amount', label: 'Amount (₦)', type: 'money', value: (Number(el.dataset.amt) / 100).toString(), required: true }, { name: 'reason', label: 'Reason (sent to the payer)', type: 'textarea', required: true, min: 3 }], confirm: 'Refund', danger: true })
          .then(function (v) { if (v) act(post('/admin/escrows/' + id + '/refund', { amountKobo: v.amount, reason: v.reason }), 'Refund started'); });
      });
    }).catch(fail);
  };

  // ═════════ Withdrawals ═════════
  PAGES.withdrawals = function (r) {
    var tab = r.q.tab || 'pending'; var page = Number(r.q.page || 1);
    shell('withdrawals', 'Withdrawals', 'Payouts from user wallets to their banks. Resolve ones stuck at pending.');
    api('/admin/withdrawals' + qs({ status: tab === 'all' ? '' : tab, page: page, limit: PAGE })).then(function (j) {
      view(tabs([['pending', 'Pending'], ['success', 'Sent'], ['failed', 'Failed'], ['reversed', 'Reversed'], ['all', 'All']], tab, function (t) { return '/withdrawals?tab=' + t; }) +
        '<div class="card">' + table(['Requested', 'User', 'Amount', 'Bank', 'Reference', 'Status'], j.withdrawals, function (w) {
          var acts = w.status === 'pending' ? '<div class="row">' + statusBadge(w.status) + '<button class="btn sm" data-wok="' + esc(w.id) + '">Mark sent</button><button class="btn ghost-danger sm" data-wno="' + esc(w.id) + '">Failed: refund wallet</button></div>' : statusBadge(w.status);
          return '<tr><td class="num">' + when(w.created_at) + '<div class="faint">' + ago(w.created_at) + '</div></td><td>' + userLink(w.user) + '</td><td class="num"><b>' + naira(w.amount_kobo) + '</b></td><td>' + (w.bank ? esc(w.bank.bank_name || '') + '<div class="faint">' + esc(w.bank.account_number + ' · ' + w.bank.account_name) + '</div>' : '—') + '</td><td class="faint">' + esc(w.reference) + '</td><td>' + acts + '</td></tr>';
        }, 'Nothing here.') + '</div>' + pager(page, j.total, r.raw) + '<p class="faint">Check the transfer in the Paystack dashboard before resolving by hand. “Failed” puts the money back in the user’s wallet.</p>');
      bind('[data-wok]', function (id) { reason('Mark as sent?', 'How did you confirm it? (audit log)', { placeholder: 'e.g. Paystack shows transfer successful', confirm: 'Mark sent' }).then(function (v) { if (v) act(post('/admin/withdrawals/' + id + '/resolve', { outcome: 'success', reason: v.reason }), 'Marked as sent'); }); });
      bind('[data-wno]', function (id) { reason('Mark as failed?', 'Reason (sent to the user)', { body: 'The amount goes back into their wallet.', confirm: 'Mark failed', danger: true }).then(function (v) { if (v) act(post('/admin/withdrawals/' + id + '/resolve', { outcome: 'failed', reason: v.reason }), 'Marked failed, wallet refunded'); }); });
    }).catch(fail);
  };

  // ═════════ Subscriptions & plans ═════════
  PAGES.subscriptions = function (r) {
    var tab = r.q.tab || 'active'; var page = Number(r.q.page || 1);
    shell('subscriptions', 'Subscriptions & plans', 'Agent and landlord plans: who is on what, and what each plan costs.', '<button class="btn sm primary" id="plan-new">New plan</button>');
    Promise.all([api('/admin/plans'), api('/admin/subscriptions' + qs({ status: tab === 'all' ? '' : tab, page: page, limit: PAGE }))]).then(function (res) {
      var plans = res[0].plans, j = res[1];
      view(section('Plans', table(['Plan', 'Price', 'Period', 'Listing limit', 'Active subscribers', 'Status', ''], plans, function (p) {
        return '<tr><td><b>' + esc(p.name) + '</b></td><td class="num">' + naira(p.price_kobo) + '</td><td>' + esc(p.interval_days) + ' days</td><td>' + (p.listing_limit == null ? 'Unlimited' : esc(p.listing_limit)) + '</td><td class="num">' + esc(p.activeSubscribers) + '</td><td>' + (p.active ? badge('On sale', 'ok') : badge('Hidden', 'grey')) + '</td><td><button class="btn sm" data-plan="' + esc(p.id) + '">Edit</button></td></tr>';
      })) + '<h2 class="section-title">Subscriptions</h2>' + tabs([['active', 'Active'], ['pending', 'Pending'], ['expired', 'Expired'], ['cancelled', 'Cancelled'], ['all', 'All']], tab, function (t) { return '/subscriptions?tab=' + t; }) +
        '<div class="card">' + table(['Subscriber', 'Plan', 'Status', 'Started', 'Expires', ''], j.subscriptions, function (s) {
          var acts = ['active', 'pending', 'expired'].indexOf(s.status) >= 0 ? '<div class="row"><button class="btn sm" data-sext="' + esc(s.id) + '">Extend</button>' + (s.status !== 'expired' ? '<button class="btn ghost-danger sm" data-scan="' + esc(s.id) + '">Cancel</button>' : '') + '</div>' : '';
          return '<tr><td>' + userLink(s.agent) + '<div class="faint">' + label(s.agent && s.agent.role) + '</div></td><td>' + esc(s.subscription_plans && s.subscription_plans.name || '') + '<div class="faint">' + esc(s.billing_cycle || '') + '</div></td><td>' + statusBadge(s.status) + '</td><td class="num">' + day(s.starts_at) + '</td><td class="num">' + day(s.expires_at) + '</td><td>' + acts + '</td></tr>';
        }, 'Nothing here.') + '</div>' + pager(page, j.total, r.raw));
      var planForm = function (p) {
        p = p || {};
        form({ title: p.id ? 'Edit ' + p.name : 'New plan', body: p.id ? 'Price changes apply to new purchases and renewals.' : '', fields: [{ name: 'name', label: 'Name', value: p.name, required: true }, { name: 'price', label: 'Price (₦)', type: 'money', value: p.price_kobo != null ? String(p.price_kobo / 100) : '', required: true },
          { name: 'intervalDays', label: 'Period (days)', type: 'number', value: p.interval_days || 30, required: true }, { name: 'listingLimit', label: 'Listing limit (blank = unlimited)', type: 'number', value: p.listing_limit == null ? '' : p.listing_limit },
          { name: 'active', label: 'On sale in the app', type: 'checkbox', value: p.active !== false }], confirm: 'Save' })
          .then(function (v) {
            if (!v) return;
            var body = { name: v.name, priceKobo: v.price, intervalDays: v.intervalDays, listingLimit: v.listingLimit == null ? null : v.listingLimit, active: !!v.active };
            act(p.id ? api('/admin/plans/' + p.id, { method: 'PATCH', body: body }) : post('/admin/plans', body), 'Plan saved');
          });
      };
      on('plan-new', function () { planForm(); });
      bind('[data-plan]', function (id) { planForm(plans.filter(function (p) { return p.id === id; })[0]); });
      bind('[data-sext]', function (id) { form({ title: 'Extend subscription', fields: [{ name: 'days', label: 'Days to add', type: 'number', value: 30, required: true }, { name: 'reason', label: 'Reason (audit log)', type: 'textarea', required: true, min: 3 }], confirm: 'Extend' })
        .then(function (v) { if (v) act(post('/admin/subscriptions/' + id + '/extend', { days: v.days, reason: v.reason }), 'Subscription extended'); }); });
      bind('[data-scan]', function (id) { reason('Cancel subscription', 'Reason (sent to the subscriber)', { body: 'Their plan stops now. No refund is made automatically.', confirm: 'Cancel plan', danger: true }).then(function (v) { if (v) act(post('/admin/subscriptions/' + id + '/cancel', { reason: v.reason }), 'Subscription cancelled'); }); });
    }).catch(fail);
  };

  // ═════════ Tenancies ═════════
  PAGES.tenancies = function (r) {
    if (r.path[1]) return tenancyDetail(r.path[1]);
    var tab = r.q.tab || 'active'; var page = Number(r.q.page || 1);
    shell('tenancies', 'Tenancies', 'Leases managed in RentCreeb, with overdue rent.');
    api('/admin/tenancies' + qs({ status: tab === 'all' ? '' : tab, page: page, limit: PAGE })).then(function (j) {
      view(tabs([['active', 'Active'], ['ended', 'Ended'], ['all', 'All']], tab, function (t) { return '/tenancies?tab=' + t; }) +
        '<div class="card">' + table(['Property', 'Landlord', 'Tenant', 'Rent', 'Next due', 'Overdue', 'Status'], j.tenancies, function (t) {
          var tenant = t.tenant ? name(t.tenant) : '<span class="faint">Invited: ' + esc(t.invite_email || t.invite_phone || '') + '</span>';
          return '<tr class="click" data-go="#/tenancies/' + esc(t.id) + '"><td>' + esc(t.properties && t.properties.title || '') + (t.unit_label ? '<div class="faint">' + esc(t.unit_label) + '</div>' : '') + '</td><td>' + name(t.landlord) + '</td><td>' + tenant + '</td><td class="num">' + naira(t.rent_kobo) + '<div class="faint">' + label(t.frequency) + '</div></td><td class="num">' + day(t.next_due_date) + '</td><td class="num">' + (t.overdueKobo ? '<b style="color:var(--danger)">' + naira(t.overdueKobo) + '</b>' : '—') + '</td><td>' + statusBadge(t.status) + '</td></tr>';
        }, 'Nothing here.') + '</div>' + pager(page, j.total, r.raw));
      bindGo();
    }).catch(fail);
  };
  function tenancyDetail(id) {
    shell('tenancies', 'Tenancy', '', '<a class="btn sm" href="#/tenancies">← Tenancies</a>');
    api('/admin/tenancies/' + encodeURIComponent(id)).then(function (j) {
      var t = j.tenancy;
      shell('tenancies', 'Tenancy: ' + (t.properties && t.properties.title || ''), t.unit_label || '', '<a class="btn sm" href="#/tenancies">← Tenancies</a>');
      view('<div class="stack"><div class="grid cols-2">' + section('Lease', kv([['Status', statusBadge(t.status)], ['Property', t.properties ? '<a href="#/listings/' + esc(t.properties.id) + '">' + esc(t.properties.title) + '</a>' : ''], ['Landlord', userLink(t.landlord)],
        ['Tenant', t.tenant ? userLink(t.tenant) : esc('Invited: ' + (t.invite_name || '') + ' ' + (t.invite_email || t.invite_phone || ''))], ['Rent', naira(t.rent_kobo) + ' ' + label(t.frequency)], ['Lease', day(t.lease_start) + ' – ' + day(t.lease_end)], ['Next due', day(t.next_due_date)],
        ['Notice given', when(t.notice_given_at)], ['Ends on', day(t.terminates_on)], ['Termination reason', esc(t.termination_reason || '')], ['Emergency contact', esc([t.emergency_contact_name, t.emergency_contact_phone].filter(Boolean).join(' · '))]])) +
        section('Maintenance', table(['Category', 'Urgency', 'Status', 'When'], j.maintenance, function (m) { return '<tr><td>' + esc(m.category) + '</td><td>' + label(m.urgency) + '</td><td>' + statusBadge(m.status) + '</td><td class="num">' + ago(m.created_at) + '</td></tr>'; }, 'None')) + '</div>' +
        section('Rent payments', table(['Due', 'Amount', 'Status', 'Paid'], j.rentPayments, function (p) { return '<tr' + (p.payment_id ? ' class="click" data-pay="' + esc(p.payment_id) + '"' : '') + '><td class="num">' + day(p.due_date) + '</td><td class="num">' + naira(p.amount_kobo) + '</td><td>' + statusBadge(p.status) + '</td><td class="num">' + when(p.paid_at) + '</td></tr>'; }, 'None')) +
        notesBlock('tenancy', t.id, j.notes) + '</div>');
      bindNotes(); bind('[data-pay]', paymentDialog);
    }).catch(fail);
  }

  // ═════════ Jobs ═════════
  PAGES.jobs = function (r) {
    if (r.path[1]) return jobDetail(r.path[1]);
    var tab = r.q.tab || 'all'; var page = Number(r.q.page || 1);
    shell('jobs', 'Jobs', 'Maintenance jobs between landlords and artisans.');
    var st = ['open', 'assigned', 'diagnosing', 'awaiting_approval', 'approved', 'in_progress', 'awaiting_confirmation', 'completed', 'cancelled'];
    api('/admin/jobs' + qs({ status: tab === 'all' ? '' : tab, page: page, limit: PAGE })).then(function (j) {
      view(tabs([['all', 'All']].concat(st.map(function (s) { return [s, s.replace(/_/g, ' ')]; })), tab, function (t) { return '/jobs?tab=' + t; }) +
        '<div class="card">' + table(['Job', 'Property', 'Landlord', 'Artisan', 'Budget', 'Status', 'Posted'], j.jobs, function (x) {
          return '<tr class="click" data-go="#/jobs/' + esc(x.id) + '"><td><b>' + esc(x.title) + '</b><div class="faint">' + esc(x.category) + (x.urgency === 'urgent' ? ' · ' + badge('urgent', 'bad') : '') + '</div></td><td>' + esc(x.properties && x.properties.title || '') + '</td><td>' + name(x.landlord) + '</td><td>' + (x.artisan ? name(x.artisan) : '—') + '</td><td class="num">' + naira(x.budget_min_kobo) + '–' + naira(x.budget_max_kobo) + '</td><td>' + statusBadge(x.status) + '</td><td class="num">' + ago(x.created_at) + '</td></tr>';
        }, 'Nothing here.') + '</div>' + pager(page, j.total, r.raw));
      bindGo();
    }).catch(fail);
  };
  function jobDetail(id) {
    shell('jobs', 'Job', '', '<a class="btn sm" href="#/jobs">← Jobs</a>');
    api('/admin/jobs/' + encodeURIComponent(id)).then(function (j) {
      var x = j.job;
      shell('jobs', x.title, x.category, '<a class="btn sm" href="#/jobs">← Jobs</a>');
      var media = j.media.filter(function (m) { return safeUrl(m.url); }).map(function (m) { return '<a target="_blank" rel="noopener" href="' + safeUrl(m.url) + '" title="' + esc(m.kind) + '"><img alt="' + esc(m.kind) + '" src="' + safeUrl(m.url) + '"></a>'; }).join('');
      view('<div class="stack"><div class="card row between"><div class="row">' + statusBadge(x.status) + (x.urgency === 'urgent' ? badge('Urgent', 'bad') : '') + '</div><div class="row">' + (j.conversationId ? '<button class="btn" data-conv="' + esc(j.conversationId) + '">Read their chat</button>' : '') + '<a class="btn" href="#/escrow">Escrow</a></div></div>' +
        '<div class="grid cols-2">' + section('Details', kv([['Property', x.properties ? '<a href="#/listings/' + esc(x.properties.id) + '">' + esc(x.properties.title) + '</a>' : ''], ['Landlord', userLink(x.landlord)], ['Artisan', x.artisan ? userLink(x.artisan) : ''],
          ['Budget', naira(x.budget_min_kobo) + ' – ' + naira(x.budget_max_kobo)], ['Access notes', esc(x.access_notes || '')], ['Posted', when(x.created_at)], ['Started', when(x.started_at)], ['Completed', when(x.completed_at)]]) + '<div class="quote">' + esc(x.description) + '</div>') +
        '<div class="stack">' + section('Quotes', table(['Artisan', 'Amount', 'ETA', 'Status'], j.quotes, function (q) { return '<tr><td>' + userLink(q.artisan) + '</td><td class="num">' + naira(q.amount_kobo) + '</td><td>' + esc(q.eta || '') + '</td><td>' + statusBadge(q.status) + '</td></tr>'; }, 'No quotes')) +
        section('Escrow', table(['Amount', 'Fee', 'Status'], j.escrows, function (e) { return '<tr><td class="num">' + naira(e.amount_kobo) + '</td><td class="num">' + naira(e.fee_kobo) + '</td><td>' + statusBadge(e.status) + '</td></tr>'; }, 'No escrow')) + '</div></div>' +
        (media ? section('Photos', '<div class="gallery">' + media + '</div>') : '') + notesBlock('job', x.id, j.notes) + '</div>');
      bindNotes(); bind('[data-conv]', openConversation);
    }).catch(fail);
  }

  // ═════════ RentSave ═════════
  PAGES.rentsave = function (r) {
    var tab = r.q.tab || 'all'; var page = Number(r.q.page || 1);
    shell('rentsave', 'RentSave', 'Tenants saving towards rent.');
    api('/admin/rentsave' + qs({ status: tab === 'all' ? '' : tab, page: page, limit: PAGE })).then(function (j) {
      view('<div class="grid cols-4" style="margin-bottom:14px"><div class="card stat"><span class="n">' + naira(j.summary.savedKobo) + '</span><span class="l">Saved in total</span></div><div class="card stat"><span class="n">' + j.summary.active + '</span><span class="l">Active plans</span></div></div>' +
        tabs([['all', 'All'], ['active', 'Active'], ['paused', 'Paused'], ['completed', 'Completed']], tab, function (t) { return '/rentsave?tab=' + t; }) +
        '<div class="card">' + table(['Tenant', 'Plan', 'Saved', 'Target', 'Contribution', 'Status', 'Target date'], j.plans, function (p) {
          var pct = p.target_kobo ? Math.min(100, Math.round(p.saved_kobo / p.target_kobo * 100)) : 0;
          return '<tr><td>' + userLink(p.tenant) + '</td><td>' + esc(p.name) + '</td><td class="num"><b>' + naira(p.saved_kobo) + '</b> <span class="faint">' + pct + '%</span></td><td class="num">' + naira(p.target_kobo) + '</td><td class="num">' + naira(p.contribution_kobo) + ' ' + label(p.frequency) + '</td><td>' + statusBadge(p.status) + '</td><td class="num">' + day(p.target_date) + '</td></tr>';
        }, 'Nothing here.') + '</div>' + pager(page, j.total, r.raw));
    }).catch(fail);
  };

  // ═════════ Announcements ═════════
  PAGES.announcements = function (r) {
    var page = Number(r.q.page || 1);
    shell('announcements', 'Announcements', 'Send a notification to everyone, or to a group.');
    api('/admin/announcements' + qs({ page: page, limit: PAGE })).then(function (j) {
      var roleChecks = ROLES.filter(function (x) { return x[0] !== 'admin'; }).map(function (x) { return '<label class="check"><input type="checkbox" name="role" value="' + x[0] + '"><span>' + x[1] + '</span></label>'; }).join('');
      view((j.available ? '' : '<div class="alert warn" style="margin-bottom:14px">Apply migration 013_admin_tools.sql in Supabase to keep a history of announcements. Sending still works.</div>') +
        '<div class="grid cols-2"><form class="card stack" id="ann"><h3>New announcement</h3><label class="field stack" style="gap:6px"><span>Title</span><input class="input" name="title" maxlength="80" required></label>' +
        '<label class="stack" style="gap:6px"><span>Message</span><textarea class="input" name="body" maxlength="1000" required></textarea></label>' +
        '<div class="stack" style="gap:6px"><span>Who gets it</span><div class="checks">' + roleChecks + '</div><span class="faint">Tick none to send to every role. Suspended and closed accounts are skipped.</span></div>' +
        '<label class="stack" style="gap:6px"><span>Verification</span><select class="input" name="verification"><option value="any">Anyone</option><option value="verified">NIN-verified only</option><option value="unverified">Not yet verified (e.g. a reminder to verify)</option></select></label>' +
        '<label class="check"><input type="checkbox" name="email"><span>Also send by email</span></label>' +
        '<div class="row" style="justify-content:flex-end"><button type="button" class="btn" id="ann-preview">Count recipients</button><button class="btn primary">Send…</button></div></form>' +
        section('Sent', table(['When', 'Title', 'Audience', 'Recipients', 'By'], j.announcements, function (a) {
          var aud = a.audience || {};
          return '<tr><td class="num">' + when(a.created_at) + '</td><td><b>' + esc(a.title) + '</b><div class="faint">' + esc(String(a.body).slice(0, 100)) + '</div></td><td class="faint">' + esc(((aud.roles || []).join(', ') || 'everyone') + (aud.verification && aud.verification !== 'any' ? ' · ' + aud.verification : '') + (aud.email ? ' · +email' : '')) + '</td><td class="num">' + esc(a.recipients) + '</td><td>' + name(a.admin) + '</td></tr>';
        }, 'Nothing sent yet.')) + '</div>');
      var payload = function (dry) {
        var f = $('#ann');
        return { title: f.title.value.trim(), body: f.body.value.trim(), email: f.email.checked, dryRun: dry,
          audience: { roles: $$('input[name=role]:checked', f).map(function (x) { return x.value; }), verification: f.verification.value } };
      };
      on('ann-preview', function () { var p = payload(true); if (!p.title) p.title = 'Preview'; if (!p.body) p.body = 'Preview'; post('/admin/announcements', p).then(function (x) { toast(x.recipients + ' people would get this'); }).catch(function (e) { toast(e.message, true); }); });
      $('#ann').onsubmit = function (e) {
        e.preventDefault(); var p = payload(true);
        if (p.title.length < 2 || p.body.length < 2) { toast('Add a title and a message', true); return; }
        post('/admin/announcements', p).then(function (x) {
          return form({ title: 'Send to ' + x.recipients + ' people?', body: '“' + p.title + '”: this cannot be unsent.', confirm: 'Send now' }).then(function (ok) {
            if (ok) { p.dryRun = false; act(post('/admin/announcements', p), 'Sending to ' + x.recipients + ' people'); }
          });
        }).catch(function (err) { toast(err.message, true); });
      };
    }).catch(fail);
  };

  // ═════════ System & settings ═════════
  PAGES.system = function () {
    shell('system', 'System & settings', 'App switches, health of every outside service, and the admin team.');
    view('<div class="spinner">Checking every service… this takes a few seconds.</div>');
    Promise.all([api('/admin/system'), api('/admin/admins')]).then(function (res) {
      var s = res[0], admins = res[1].admins, st = s.settings;
      var tone = function (h) { return h && h.ok ? 'ok' : 'bad'; };
      var card = function (title, h, body) { return '<div class="card health ' + tone(h) + '"><div class="row between"><h3>' + esc(title) + '</h3><span class="row"><span class="dot ' + tone(h) + '"></span>' + (h && h.ok ? 'OK' : 'Problem') + '</span></div>' + (body || '') + (h && h.detail ? '<div class="faint">' + esc(h.detail) + '</div>' : '') + (h && h.ms != null ? '<div class="faint">checked in ' + h.ms + ' ms</div>' : '') + '</div>'; };
      var bal = function (b) { if (b == null) return ''; if (Array.isArray(b)) return b.map(function (x) { return esc(x.currency) + ' ' + naira(x.balance); }).join(', '); return esc(typeof b === 'object' ? JSON.stringify(b) : b); };
      var missing = (s.migrations || []).filter(function (m) { return !m.applied; });
      var tones = { info: 'info', warning: 'warn', success: 'ok' };
      view('<div class="stack">' + (missing.length ? '<div class="alert warn"><b>Database updates not applied:</b> ' + missing.map(function (m) { return esc(m.name); }).join(', ') + '. Run the matching files from backend/supabase/migrations in the Supabase SQL editor.</div>' : '') +
        '<div class="grid cols-2">' +
        section('Maintenance mode', '<p class="muted" style="margin:0">When on, the app shows the message below and blocks everything except sign-in. Admins keep working here.</p>' +
          '<div class="row">' + (st.maintenanceMode ? badge('ON: app is blocked', 'bad') : badge('Off', 'ok')) + '</div>' +
          '<textarea class="input" id="mm-msg" maxlength="300">' + esc(st.maintenanceMessage) + '</textarea><div class="row" style="justify-content:flex-end"><button class="btn" id="mm-save">Save message</button><button class="btn ' + (st.maintenanceMode ? 'ok' : 'danger') + '" id="mm-toggle">' + (st.maintenanceMode ? 'Turn off maintenance' : 'Turn on maintenance') + '</button></div>') +
        section('Automatic listing approval', '<p class="muted" style="margin:0">New listings are checked by rules and AI within a few minutes. When this is on, listings that pass every check go live without waiting for an admin. Anything doubtful always waits for a person.</p>' +
          '<div class="row">' + (st.listingAutoApprove ? badge('On', 'ok') : badge('Off: every listing waits for an admin', 'grey')) + (s.ai && s.ai.ok ? '' : badge('AI not available', 'bad')) + '</div>' +
          '<div class="row" style="justify-content:flex-end"><button class="btn ' + (st.listingAutoApprove ? '' : 'primary') + '" id="aa-toggle">' + (st.listingAutoApprove ? 'Turn off auto-approval' : 'Turn on auto-approval') + '</button></div>') +
        section('App banner', '<p class="muted" style="margin:0">A message shown at the top of the app (returned by /config as <code>banner</code>).</p>' +
          (st.banner ? '<div class="banner-preview alert ' + (tones[st.banner.tone] || 'info') + '">' + esc(st.banner.message) + (st.banner.until ? ' <span class="faint">until ' + when(st.banner.until) + '</span>' : '') + '</div>' : '<div class="faint">No banner showing.</div>') +
          '<div class="row" style="justify-content:flex-end">' + (st.banner ? '<button class="btn ghost-danger" id="bn-clear">Remove banner</button>' : '') + '<button class="btn primary" id="bn-edit">' + (st.banner ? 'Edit banner' : 'Add banner') + '</button></div>') + '</div>' +
        '<h2 class="section-title">Services</h2><div class="grid cols-3">' +
        card('API server', s.server, kv([['Environment', esc(s.server.env)], ['Node', esc(s.server.node)], ['Up for', esc(Math.round(s.server.uptimeSec / 60)) + ' min'], ['Memory', esc(s.server.memoryMb) + ' MB']])) +
        card('Database (Supabase)', s.database, s.database.latencyMs != null ? '<div class="faint">' + s.database.latencyMs + ' ms</div>' : '') +
        card('SMS (' + esc(s.sms.provider || '') + ')', s.sms, s.sms.balance != null ? kv([['Balance', bal(s.sms.balance)]]) : '') +
        card('NIN checks (Bytid)', s.bytid, kv([['Key mode', esc(s.bytid.mode || '')], ['Balance', s.bytid.balance != null ? esc(s.bytid.balance) + ' ' + esc(s.bytid.currency || '') : '']])) +
        card('Payments (Paystack)', s.paystack, kv([['Key mode', esc(s.paystack.mode || '')], ['Balance', bal(s.paystack.balance)]])) +
        card('AI (listing review)', s.ai, kv([['Model', esc(s.ai && s.ai.model || '')]])) +
        card('Call relay (TURN)', s.turn, s.turn.relays != null ? '<div class="faint">' + s.turn.relays + ' relay addresses</div>' : '') +
        card('Email (Resend)', s.email) + card('File storage (Bunny)', s.storage) + '</div>' +
        '<h2 class="section-title">Database updates</h2><div class="card">' + table(['Migration', 'Applied'], s.migrations, function (m) { return '<tr><td>' + esc(m.name) + '</td><td>' + (m.applied ? badge('Yes', 'ok') : badge('No', 'bad')) + '</td></tr>'; }) + '</div>' +
        '<h2 class="section-title">Admin team</h2><div class="card">' + table(['Name', 'Email', 'Since'], admins, function (a) { return '<tr class="click" data-go="#/users/' + esc(a.id) + '"><td><div class="row">' + avatar(a) + name(a) + (a.id === me.id ? ' ' + badge('you', 'grey') : '') + '</div></td><td>' + esc(a.email || '') + '</td><td class="num">' + day(a.created_at) + '</td></tr>'; }) +
        '<p class="faint">To add an admin, open their account in Users → Actions → Change role → Admin.</p></div></div>');
      bindGo();
      var put = function (body, msg) { return act(api('/admin/settings', { method: 'PUT', body: body }), msg).then(function () { return refreshCounts(); }).then(route).catch(function () {}); };
      on('mm-save', function () { put({ maintenanceMessage: $('#mm-msg').value.trim() }, 'Message saved'); });
      on('mm-toggle', function () {
        if (st.maintenanceMode) return put({ maintenanceMode: false }, 'Maintenance mode off');
        form({ title: 'Turn on maintenance mode?', body: 'Everyone except admins is blocked from the app until you turn it off.', confirm: 'Turn on', danger: true }).then(function (v) { if (v) put({ maintenanceMode: true, maintenanceMessage: $('#mm-msg') ? $('#mm-msg').value.trim() : undefined }, 'Maintenance mode on'); });
      });
      on('aa-toggle', function () { put({ listingAutoApprove: !st.listingAutoApprove }, st.listingAutoApprove ? 'Auto-approval off' : 'Auto-approval on'); });
      on('bn-clear', function () { put({ banner: null }, 'Banner removed'); });
      on('bn-edit', function () {
        var b = st.banner || {};
        form({ title: 'App banner', fields: [{ name: 'message', label: 'Message', type: 'textarea', value: b.message, required: true, min: 3 }, { name: 'tone', label: 'Style', type: 'select', value: b.tone || 'info', options: [['info', 'Information'], ['warning', 'Warning'], ['success', 'Good news']] },
          { name: 'until', label: 'Hide automatically after (optional)', type: 'date', value: b.until ? String(b.until).slice(0, 10) : '' }], confirm: 'Show banner' })
          .then(function (v) { if (v) put({ banner: { message: v.message, tone: v.tone, until: v.until ? new Date(v.until + 'T23:59:59').toISOString() : null } }, 'Banner updated'); });
      });
    }).catch(fail);
  };

  // ═════════ Audit log ═════════
  PAGES.audit = function (r) {
    var page = Number(r.q.page || 1);
    shell('audit', 'Audit log', 'Every admin action, newest first.');
    var filters = '<form class="row" id="afilter" style="margin-bottom:14px"><select class="input" name="action"><option value="">All actions</option>' +
      ['user', 'verification', 'property', 'artisan', 'report', 'review', 'ticket', 'booking', 'escrow', 'withdrawal', 'wallet', 'subscription', 'plan', 'conversation', 'announcement', 'settings', 'export', 'note'].map(function (x) { return '<option' + (r.q.action === x ? ' selected' : '') + '>' + x + '</option>'; }).join('') +
      '</select><input class="input" name="targetId" placeholder="Target ID" value="' + esc(r.q.targetId || '') + '"><button class="btn primary">Filter</button></form>';
    api('/admin/actions' + qs({ action: r.q.action, targetId: r.q.targetId, page: page, limit: PAGE })).then(function (j) {
      view(filters + '<div class="card">' + actionsTable(j.actions) + '</div>' + pager(page, j.total, r.raw));
      $('#afilter').onsubmit = function (e) { e.preventDefault(); location.hash = '#/audit' + qs({ action: e.target.action.value, targetId: e.target.targetId.value.trim() }); };
    }).catch(function (e) { view('<div class="err">' + esc(e.code === 'FEATURE_UNAVAILABLE' ? 'Run migration 011_admin_audit.sql in Supabase to turn on the audit log.' : e.message) + '</div>'); });
  };

  // Keep nav badges fresh without reloading everything.
  setInterval(function () {
    if (!me || document.visibilityState !== 'visible') return;
    refreshCounts().then(function () {
      $$('.nav').forEach(function (a) {
        var n = ALL_NAV.filter(function (x) { return a.getAttribute('href') === '#/' + x[0]; })[0]; if (!n || !n[2]) return;
        var b = a.querySelector('.badge'); var c = counts[n[2]];
        if (c && !b) a.insertAdjacentHTML('beforeend', '<span class="badge">' + c + '</span>'); else if (b) { if (c) b.textContent = c; else b.remove(); }
      });
    }).catch(function () {});
  }, 60000);

  route();
})();
