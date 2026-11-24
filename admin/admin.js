/* RentCreeb admin dashboard — plain JS, no build step. Served by the API at /admin; talks to /api/v1/admin. */
(function () {
  'use strict';
  var API = '/api/v1';
  var PAGE = 20;
  var KEY = 'rc_admin_session';
  var session = load();
  var me = null;
  var counts = {};
  var agent = { available: false, known: false, seen: {} }; // live-chat availability + chats already announced

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
    archived: 'grey', expired: 'grey', ended: 'grey', draft: 'grey',
    subscribed: 'ok', sent: 'ok', delivered: 'ok', sending: 'warn', scheduled: 'warn', queued: 'warn', unsubscribed: 'grey', skipped: 'grey', bounced: 'bad', complained: 'bad' };
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

  /** Multipart upload (POST /uploads?folder=…) with the admin's token. Resolves to the first stored file. */
  function uploadFile(folder, file, retried) {
    var fd = new FormData(); fd.append('files', file, file.name);
    return fetch(API + '/uploads?folder=' + encodeURIComponent(folder), { method: 'POST', headers: { Authorization: 'Bearer ' + session.access_token }, body: fd }).then(function (res) {
      if (res.status === 401 && !retried) return refreshSession().then(function () { return uploadFile(folder, file, true); });
      return res.json().catch(function () { return {}; }).then(function (j) {
        if (!res.ok) throw new Error((j.error && j.error.message) || ('Upload failed (' + res.status + ')'));
        return j.files[0];
      });
    });
  }
  /** Full-screen photo viewer. */
  function lightbox(url, caption) {
    if (!safeUrl(url)) return;
    var root = $('#modal-root');
    root.innerHTML = '<div class="backdrop lightbox" role="dialog" aria-modal="true" aria-label="Photo"><img alt="" src="' + safeUrl(url) + '">' +
      '<div class="lightbox-bar"><span>' + esc(caption || '') + '</span><a class="btn sm" target="_blank" rel="noopener" href="' + safeUrl(url) + '">Open original</a><button class="btn sm" id="lb-close">Close</button></div></div>';
    var close = function () { root.innerHTML = ''; document.removeEventListener('keydown', onKey); };
    var onKey = function (e) { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    $('#lb-close').onclick = close;
    $('.lightbox').onclick = function (e) { if (e.target.classList.contains('lightbox')) close(); };
  }
  /** Video tour cards for listing links; titles and thumbnails load from the host (cached by the API). */
  var YT = /(?:youtube(?:-nocookie)?\.com\/(?:watch\?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/;
  function videoCards(urls) {
    return '<div class="video-cards">' + (urls || []).map(function (u) {
      var yt = YT.exec(u); var thumb = yt ? 'https://i.ytimg.com/vi/' + yt[1] + '/hqdefault.jpg' : '';
      return '<a class="video-card" target="_blank" rel="noopener" href="' + safeUrl(u) + '" data-vurl="' + esc(u) + '"><div class="vthumb"' + (thumb ? ' style="background-image:url(' + esc(thumb) + ')"' : '') + '><span class="play">\u25B6</span></div>' +
        '<div class="vmeta"><b class="vtitle">' + esc(u.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60)) + '</b><span class="faint vprov">Video link</span></div></a>';
    }).join('') + '</div>';
  }
  function fillVideoCards() {
    $$('[data-vurl]').forEach(function (el) {
      api('/properties/video-preview' + qs({ url: el.dataset.vurl })).then(function (j) {
        var p = j.preview; if (!p) return;
        if (p.thumbnail && safeUrl(p.thumbnail)) $('.vthumb', el).style.backgroundImage = 'url("' + p.thumbnail.replace(/"/g, '') + '")';
        $('.vtitle', el).textContent = p.title || p.url.replace(/^https?:\/\/(www\.)?/, '');
        $('.vprov', el).textContent = p.providerName + (p.author ? ' \u00b7 ' + p.author : '');
      }).catch(function () {});
    });
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
      ['reports', 'Reports', 'openReports'], ['scam', 'Scam alerts', 'scamAlerts'], ['reviews', 'Reviews', 'flaggedReviews'], ['support', 'Support', 'openTickets'], ['feedback', 'App feedback']]],
    ['People', [['users', 'Users'], ['waitlist', 'Waitlist']]],
    ['Money', [['finance', 'Finance'], ['payments', 'Payments', 'stuckPayments'], ['bookings', 'Bookings'], ['escrow', 'Escrow'], ['withdrawals', 'Withdrawals', 'pendingWithdrawals'], ['subscriptions', 'Subscriptions & plans']]],
    ['Operations', [['tenancies', 'Tenancies'], ['jobs', 'Jobs'], ['rentsave', 'RentSave']]],
    ['Mailing', [['mailing', 'Overview'], ['mail-campaigns', 'Campaigns'], ['mail-automations', 'Automations'], ['mail-contacts', 'Contacts'], ['mail-lists', 'Lists & sign-up form'], ['mail-templates', 'Templates']]],
    ['Platform', [['media', 'Files & images'], ['assistant', 'AI Assistant'], ['announcements', 'Announcements'], ['audit', 'Audit log']]],
  ];
  // Admin managers (role admin_manager) see only these sections; the API enforces the same limits (src/routes/admin/access.ts).
  var MANAGER_SECTIONS = ['overview', 'verifications', 'listings', 'artisans', 'reports', 'scam', 'reviews', 'support', 'feedback', 'users', 'waitlist', 'bookings', 'tenancies', 'jobs', 'rentsave'];
  function isAdminRole(role) { return role === 'admin' || role === 'admin_manager'; }
  function isManager() { return !!me && me.role === 'admin_manager'; }
  function canSee(section) { return !isManager() || MANAGER_SECTIONS.indexOf(section) >= 0; }
  function visibleNav() { return NAV.map(function (g) { return [g[0], g[1].filter(function (n) { return canSee(n[0]); })]; }).filter(function (g) { return g[1].length; }); }
  var ALL_NAV = []; NAV.forEach(function (g) { ALL_NAV = ALL_NAV.concat(g[1]); });
  // Line icons (24×24, stroke) for the sidebar and controls.
  var ICON_PATHS = {
    overview: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
    system: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
    verifications: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4',
    listings: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
    artisans: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z',
    reports: 'M4 22V4M4 4h12l-2 4 2 4H4',
    scam: 'M12 2 3 6v6c0 5 3.8 9.4 9 10 5.2-.6 9-5 9-10V6zM12 8v5M12 16h.01',
    reviews: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z',
    support: 'M3 14v-2a9 9 0 0 1 18 0v2M21 14v3a2 2 0 0 1-2 2h-1v-6h3zM3 14v3a2 2 0 0 0 2 2h1v-6H3z',
    feedback: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12zM8.5 13.5s1.2 1.5 3.5 1.5 3.5-1.5 3.5-1.5M9 9.5h.01M15 9.5h.01',
    waitlist: 'M9 3h6v3H9zM6 4H5a1 1 0 0 0-1 1v15a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1h-1M8 12h8M8 16h5',
    users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
    finance: 'M3 3v18h18M7 15v2M11 11v6M15 7v10M19 12v5',
    payments: 'M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2zM2 10h20M6 15h4',
    bookings: 'M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM16 2v4M8 2v4M3 10h18',
    escrow: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
    withdrawals: 'M12 19V5M5 12l7-7 7 7M5 21h14',
    subscriptions: 'M12 2 2 7l10 5 10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
    tenancies: 'M7.5 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM11 12h10M18 12v3M21 12v2',
    jobs: 'M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM9 6V4h6v2M3 13h18',
    rentsave: 'M5 6a7 3 0 1 0 14 0a7 3 0 1 0-14 0M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6',
    mailing: 'M3 5h18v14H3zM3 6l9 7 9-7',
    'mail-campaigns': 'M22 2 11 13M22 2l-7 20-4-9-9-4z',
    'mail-automations': 'M13 2 3 14h9l-1 8 10-12h-9z',
    'mail-contacts': 'M4 4a2 2 0 0 1 2-2h12v20H6a2 2 0 0 1-2-2zM12 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8 17a4 4 0 0 1 8 0',
    'mail-lists': 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
    'mail-templates': 'M3 3h18v18H3zM3 9h18M9 21V9',
    announcements: 'M3 11v2a1 1 0 0 0 1 1h3l7 5V5L7 10H4a1 1 0 0 0-1 1zM18 8a5 5 0 0 1 0 8',
    audit: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2',
    assistant: 'M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9zM5 3l.6 1.4L7 5l-1.4.6L5 7l-.6-1.4L3 5l1.4-.6z',
    media: 'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5L5 21',
    upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
    search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
    light: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
    dark: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
    auto: 'M2 4h20v13H2zM8 21h8M12 17v4',
    logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
    menu: 'M3 6h18M3 12h18M3 18h18',
    check: 'M20 6 9 17l-5-5',
  };
  function icon(k, cls) {
    return '<svg class="' + (cls || 'ico') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + (ICON_PATHS[k] || ICON_PATHS.overview) + '"/></svg>';
  }

  // Theme: follows the OS unless the admin picks light or dark (remembered in this browser).
  var THEME_KEY = 'rc_admin_theme';
  var THEMES = { auto: 'System', light: 'Light', dark: 'Dark' };
  function getTheme() { try { return localStorage.getItem(THEME_KEY) || 'auto'; } catch (e) { return 'auto'; } }
  function applyTheme(t) {
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t); else document.documentElement.removeAttribute('data-theme');
    try { t === 'auto' ? localStorage.removeItem(THEME_KEY) : localStorage.setItem(THEME_KEY, t); } catch (e) {}
  }
  applyTheme(getTheme());

  // "/" jumps to search from anywhere (except while typing).
  document.addEventListener('keydown', function (e) {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    var t = e.target; if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
    var s = document.querySelector('#gsearch input'); if (s) { e.preventDefault(); s.focus(); s.select(); }
  });

  function shell(section, title, sub, actions) {
    var group = '';
    var nav = visibleNav().map(function (g) {
      return '<div class="nav-group">' + esc(g[0]) + '</div>' + g[1].map(function (n) {
        if (section === n[0]) group = g[0];
        var c = n[2] && counts[n[2]] ? '<span class="badge">' + counts[n[2]] + '</span>' : '';
        return '<a class="nav' + (section === n[0] ? ' on' : '') + '" href="#/' + n[0] + '"' + (section === n[0] ? ' aria-current="page"' : '') + '>' + icon(n[0]) + '<span class="txt">' + esc(n[1]) + '</span>' + c + '</a>';
      }).join('');
    }).join('');
    var theme = getTheme();
    $('#app').innerHTML = '<div class="shell"><aside class="side" id="side" aria-label="Sections"><div class="brand"><img src="logo-white.svg" alt="RentCreeb" height="22"> <span>Admin</span></div>' + nav +
      '<div class="side-foot"><div class="side-user">' + avatar(me) + '<div style="min-width:0"><b>' + name(me) + '</b><small>Administrator</small></div></div>' +
      '<button id="avail" class="avail' + (agent.available ? ' on' : '') + '" title="When on, chats handed over by the AI Assistant can be assigned to you"><span class="sw"></span><span>' + (agent.available ? 'Available for live chats' : 'Away from live chats') + '</span></button>' +
      '<div class="side-actions"><button id="theme" title="Theme: ' + THEMES[theme] + ' (click to change)">' + icon(theme, '') + THEMES[theme] + '</button><button id="logout">' + icon('logout', '') + 'Sign out</button></div></div></aside>' +
      '<div class="side-scrim" id="scrim"></div>' +
      '<main class="main"><div class="head"><div>' + (group ? '<div class="crumb">' + esc(group) + '</div>' : '') +
      '<div class="row"><button class="btn sm menu-btn" id="menu" aria-label="Open menu">' + icon('menu', '') + '</button><h1>' + esc(title) + '</h1></div>' +
      (sub ? '<p>' + esc(sub) + '</p>' : '') + '</div><div class="row">' + (actions || '') +
      '<form class="head-search" id="gsearch" role="search">' + icon('search', '') + '<input class="input" name="q" placeholder="Search people, listings, references…" aria-label="Search"><kbd>/</kbd></form></div></div>' +
      (counts.maintenanceMode ? '<div class="alert bad" style="margin-bottom:16px"><b>Maintenance mode is ON.</b> The app is blocked for everyone except admins. <a href="#/system">Turn it off</a></div>' : '') +
      '<div id="view"><div class="spinner" role="status" aria-label="Loading">Loading…</div></div></main></div>';
    $('#logout').onclick = function () { setAvailable(false, true); api('/auth/logout', { method: 'POST' }).catch(function () {}); logout(); };
    $('#avail').onclick = function () { setAvailable(!agent.available); };
    $('#theme').onclick = function () { var order = ['auto', 'light', 'dark']; applyTheme(order[(order.indexOf(getTheme()) + 1) % 3]); var b = $('#theme'); var t = getTheme(); b.innerHTML = icon(t, '') + THEMES[t]; b.title = 'Theme: ' + THEMES[t] + ' (click to change)'; };
    var closeSide = function () { $('#side').classList.remove('open'); };
    $('#menu').onclick = function () { $('#side').classList.toggle('open'); };
    $('#scrim').onclick = closeSide;
    $$('.side .nav').forEach(function (a) { a.addEventListener('click', closeSide); });
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
    var w = 600, h = 100, gap = 3, bw = (w - gap * (series.length - 1)) / series.length;
    var total = series.reduce(function (t, d) { return t + d.value; }, 0);
    var f = function (v) { return fmt ? fmt(v) : Number(v).toLocaleString('en-NG'); };
    var dayLabel = function (d) { return new Date(d + 'T12:00:00').toLocaleDateString('en-NG', { day: 'numeric', month: 'short' }); };
    var grid = [0.25, 0.5, 0.75].map(function (p) { return '<line x1="0" x2="' + w + '" y1="' + (h * p).toFixed(1) + '" y2="' + (h * p).toFixed(1) + '" class="gridline"/>'; }).join('');
    var bars = series.map(function (d, i) {
      var bh = Math.max(d.value ? 3 : 0, Math.round((d.value / max) * (h - 4)));
      return '<rect class="bar" x="' + (i * (bw + gap)).toFixed(1) + '" y="' + (h - bh) + '" width="' + bw.toFixed(1) + '" height="' + bh + '" rx="2"><title>' + esc(dayLabel(d.day) + ': ' + f(d.value)) + '</title></rect>';
    }).join('');
    return '<div class="chart-box"><div class="chart-sum"><b>' + esc(f(total)) + '</b><span>total \u00b7 peak ' + esc(f(max === 1 && !total ? 0 : max)) + '/day</span></div>' +
      '<svg class="chart" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" role="img" aria-label="Daily chart, total ' + esc(f(total)) + '">' + grid + '<line x1="0" x2="' + w + '" y1="' + h + '" y2="' + h + '" class="axis"/>' + bars + '</svg>' +
      '<div class="chart-axis"><span>' + esc(dayLabel(series[0].day)) + '</span><span>' + esc(dayLabel(series[series.length - 1].day)) + '</span></div></div>';
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
    if (isManager()) { toast('Only a full admin can read private conversations.'); return; }
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
  var pageTimer = null; // per-page polling (support thread, sending campaign); cleared on every navigation
  var pageStream = null; // live updates for the current page (server-sent events); closed on every navigation
  function stopPage() { if (pageTimer) { clearInterval(pageTimer); pageTimer = null; } if (pageStream) { pageStream.close(); pageStream = null; } }

  /**
   * Server-sent events from GET /admin/live, read with fetch so the token goes in a header. Reconnects by itself
   * (with a fresh token after a 401) until close() is called. onEvent(type, data); onState(true|false) for the "live" dot.
   */
  function liveStream(params, onEvent, onState) {
    var closed = false; var ctrl = null; var retry = 1000;
    var setState = function (s) { if (onState) onState(s); };
    var connect = function () {
      if (closed) return;
      ctrl = new AbortController();
      fetch(API + '/admin/live' + qs(params), { headers: { Authorization: 'Bearer ' + session.access_token, Accept: 'text/event-stream' }, signal: ctrl.signal }).then(function (res) {
        if (res.status === 401) return refreshSession().then(function () { throw new Error('reauth'); });
        if (!res.ok || !res.body) throw new Error('live ' + res.status);
        setState(true); retry = 1000;
        var reader = res.body.getReader(); var dec = new TextDecoder(); var buf = '';
        var pump = function () {
          return reader.read().then(function (r) {
            if (r.done) throw new Error('ended');
            buf += dec.decode(r.value, { stream: true });
            var parts = buf.split('\n\n'); buf = parts.pop();
            parts.forEach(function (chunk) {
              var ev = 'message', data = '';
              chunk.split('\n').forEach(function (ln) { if (ln.indexOf('event:') === 0) ev = ln.slice(6).trim(); else if (ln.indexOf('data:') === 0) data += ln.slice(5).trim(); });
              if (!data) return;
              try { onEvent(ev, JSON.parse(data)); } catch (e) { /* ignore a bad event */ }
            });
            return pump();
          });
        };
        return pump();
      }).catch(function () {
        setState(false);
        if (closed) return;
        setTimeout(connect, retry); retry = Math.min(retry * 2, 20000);
      });
    };
    connect();
    return { close: function () { closed = true; if (ctrl) ctrl.abort(); } };
  }
  function route() {
    $('#modal-root').innerHTML = ''; // never carry a dialog over to another page
    stopLive(); stopPage();
    if (!session) return renderLogin();
    if (!me) return api('/users/me').then(function (r) {
      var p = r.profile || r.user || r;
      if (!p || !isAdminRole(p.role)) { logout('This account is not an admin.'); return; }
      me = p; refreshCounts().catch(function () {}).then(route);
    }).catch(function () { logout(); });
    var r = parse(); var s = r.path[0] || 'overview';
    if (!canSee(s)) { shell('overview', 'Not available', ''); view('<div class="alert info">Your manager account can\'t open this section. Ask a full admin if you need something here.</div>'); return; }
    (PAGES[s] || PAGES.overview)(r);
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);
  function logout(msg) { save(null); me = null; renderLogin(msg); }

  // ───────── login ─────────
  function renderLogin(msg) {
    var point = function (t) { return '<li>' + icon('check', '') + esc(t) + '</li>'; };
    $('#app').innerHTML = '<div class="login"><section class="login-art" aria-hidden="true"><img src="logo-white.svg" alt="" height="26" style="position:relative;z-index:1">' +
      '<div><h2>Run RentCreeb from one place.</h2><p>Review listings and ID checks, answer support, move money safely and talk to your users.</p>' +
      '<ul>' + point('Review queues with everything you need to decide') + point('Support conversations in real time') + point('Finance, escrow and payouts at a glance') + point('Campaigns, automations and mailing lists') + '</ul></div>' +
      '<div class="foot">Admins only · every action is recorded in the audit log</div></section>' +
      '<div class="login-pane"><form class="card" id="login"><div><img src="logo.svg" alt="RentCreeb" height="28" class="login-logo"><h1 style="margin-top:18px">Welcome back</h1><p class="muted" style="margin:6px 0 0">Sign in with your admin account.</p></div>' +
      (msg ? '<div class="err">' + esc(msg) + '</div>' : '') +
      '<label>Email<input class="input" name="email" type="email" autocomplete="username" placeholder="you@rentcreeb.com" required></label>' +
      '<label>Password<input class="input" name="password" type="password" autocomplete="current-password" required></label>' +
      '<button class="btn primary" type="submit">Sign in</button></form></div></div>';
    $('#login').onsubmit = function (e) {
      e.preventDefault();
      var f = e.target; var btn = f.querySelector('button'); btn.disabled = true; btn.textContent = 'Signing in…';
      api('/auth/login', { method: 'POST', body: { identifier: f.email.value.trim(), password: f.password.value } }).then(function (r) {
        if (!r.profile || !isAdminRole(r.profile.role)) { renderLogin('This account is not an admin.'); return; }
        save(r.session); me = r.profile;
        refreshCounts().catch(function () {}).then(function () { if (!location.hash || location.hash === '#/') location.hash = '#/overview'; else route(); });
      }).catch(function (err) { renderLogin(err.status === 401 ? 'Wrong email or password.' : err.message); });
    };
  }

  // ═════════ Overview ═════════
  // Renders the last result straight away when you come back to it (no spinner), then refreshes in the background.
  var lastOverview = null;
  function changePct(cur, prev) { cur = Number(cur || 0); prev = Number(prev || 0); if (!prev) return cur ? null : 0; return Math.round(((cur - prev) / prev) * 100); }
  function delta(cur, prev, label) {
    var p = changePct(cur, prev);
    if (p === null) return '<span class="delta up" title="Nothing in the 7 days before">new</span>';
    var cls = p > 0 ? 'up' : p < 0 ? 'down' : 'flat';
    return '<span class="delta ' + cls + '" title="' + esc(label || 'vs the 7 days before') + '">' + (p > 0 ? '▲ ' : p < 0 ? '▼ ' : '') + Math.abs(p) + '%</span>';
  }
  /** Tiny line of the last 14 days for a KPI tile. */
  function spark(series) {
    if (!series || series.length < 2) return '';
    var s = series.slice(-14), w = 120, h = 30;
    var max = Math.max.apply(null, s.map(function (d) { return Number(d.value); }).concat([1]));
    var pts = s.map(function (d, i) { return (i * (w / (s.length - 1))).toFixed(1) + ',' + (h - 2 - (Number(d.value) / max) * (h - 4)).toFixed(1); });
    return '<svg class="spark" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" aria-hidden="true"><polyline points="0,' + h + ' ' + pts.join(' ') + ' ' + w + ',' + h + '" class="area"/><polyline points="' + pts.join(' ') + '" class="line"/></svg>';
  }
  function kpi(value, labelText, extra, href, series) {
    var tag = href ? 'a' : 'div';
    return '<' + tag + ' class="card stat kpi"' + (href ? ' href="' + href + '"' : '') + '><span class="l">' + esc(labelText) + '</span><span class="n">' + value + '</span><div class="row between kpi-foot">' + (extra || '<span></span>') + spark(series) + '</div></' + tag + '>';
  }
  /** Horizontal bars: [[label, value, href?, tone?]] */
  function hbars(items, fmt, empty) {
    items = (items || []).filter(function (x) { return Number(x[1]) > 0; });
    if (!items.length) return '<div class="empty">' + esc(empty || 'Nothing yet.') + '</div>';
    var max = Math.max.apply(null, items.map(function (x) { return Number(x[1]); }));
    var total = items.reduce(function (t, x) { return t + Number(x[1]); }, 0);
    return '<div class="hbars">' + items.map(function (x) {
      var w = Math.max(2, Math.round((Number(x[1]) / max) * 100));
      var lab = x[2] ? '<a href="' + x[2] + '">' + esc(x[0]) + '</a>' : esc(x[0]);
      return '<div class="hbar"><div class="hbar-top"><span>' + lab + '</span><span class="num">' + esc(fmt ? fmt(x[1]) : num(x[1])) + ' <span class="faint">' + Math.round((Number(x[1]) / total) * 100) + '%</span></span></div>' +
        '<div class="hbar-track"><div class="hbar-fill ' + (x[3] || '') + '" style="width:' + w + '%"></div></div></div>';
    }).join('') + '</div>';
  }
  /** Each step as a share of the first. */
  function funnel(steps) {
    var top = Number(steps[0][1]) || 1;
    return '<div class="funnel">' + steps.map(function (s, i) {
      var p = Math.round((Number(s[1]) / top) * 100);
      return '<div class="funnel-step"><div class="funnel-bar" style="width:' + Math.max(p, 3) + '%"></div><div class="funnel-txt"><span>' + esc(s[0]) + '</span><span class="num"><b>' + num(s[1]) + '</b> <span class="faint">' + (i ? p + '%' : '') + '</span></span></div></div>';
    }).join('') + '</div>';
  }
  var PURPOSE = { inspection: 'Inspection fees', subscription: 'Subscriptions', rent: 'Rent', rentsave: 'RentSave', job_escrow: 'Job payments', job_topup: 'Job top-ups', bill: 'Bills', utility: 'Utilities', wallet_topup: 'Wallet top-ups' };
  var ROLE_NAMES = { tenant: 'Tenants', landlord: 'Landlords', estate_manager: 'Estate managers', agent: 'Agents', artisan: 'Artisans', developer: 'Developers', investor: 'Investors', admin: 'Admins', admin_manager: 'Admin managers' };
  var LISTING_STATUS = { approved: ['Live', 'ok'], pending: ['Awaiting approval', 'warn'], rejected: ['Rejected', 'bad'], rented: ['Rented', 'violet'], archived: ['Archived', 'grey'], unlisted: ['Unlisted', 'grey'] };

  PAGES.overview = function () {
    var head = function (o) {
      var when_ = o && o.generatedAt ? 'Updated ' + ago(o.generatedAt) : '';
      shell('overview', 'Overview', 'What needs attention, and how RentCreeb is doing.', '<span class="faint" id="ov-upd">' + esc(when_) + '</span><button class="btn sm" id="ov-refresh">Refresh</button>');
      on('ov-refresh', function () { $('#ov-upd').textContent = 'Refreshing…'; api('/admin/overview?fresh=1').then(function (x) { counts = Object.assign({}, x.queues); lastOverview = x; draw(x); }).catch(function (e) { toast(e.message, true); }); });
    };
    var draw = function (o) {
      head(o);
      var q = o.queues || {}, u = o.users || {}, a = o.activity || {}, m = o.money, l = o.listings || {}, t = o.trends || {}, rc = o.recent || {};
      var full = !isManager() && !!m;
      var banner = o.settings && o.settings.maintenanceMode ? '<div class="alert bad" style="margin-bottom:14px">Maintenance mode is ON: the app is closed to users. <a href="#/system">Turn it off</a></div>'
        : o.settings && o.settings.banner ? '<div class="alert info" style="margin-bottom:14px">App banner showing: “' + esc(o.settings.banner.message) + '” · <a href="#/system">edit</a></div>' : '';

      // 1. Queues: what needs a person
      var queue = [['manualVerifications', 'ID checks', '#/verifications'], ['pendingProperties', 'Listings to approve', '#/listings'], ['pendingArtisans', 'Artisan applications', '#/artisans'],
        ['openReports', 'Open reports', '#/reports'], ['scamAlerts', 'Scam alerts', '#/scam'], ['flaggedReviews', 'Flagged reviews', '#/reviews'], ['openTickets', 'Support tickets', '#/support']]
        .concat(full ? [['pendingWithdrawals', 'Withdrawals over 1h', '#/withdrawals?tab=pending'], ['stuckPayments', 'Stuck payments', '#/payments?status=pending']] : []);
      var waiting = queue.reduce(function (n, x) { return n + Number(q[x[0]] || 0); }, 0);
      var queues = '<div class="queue-grid">' + queue.map(function (x) {
        var n = Number(q[x[0]] || 0);
        return '<a class="queue' + (n ? ' hot' : '') + '" href="' + x[2] + '"><span class="qn">' + num(n) + '</span><span class="ql">' + esc(x[1]) + '</span></a>';
      }).join('') + '</div>';

      // 2. KPIs, last 7 days vs the 7 before
      var kpis = '<div class="grid cols-' + (full ? 5 : 4) + '">' +
        kpi(num(u.new7d), 'New users · 7 days', delta(u.new7d, u.newPrev7d), '#/users', t.signups) +
        kpi(num(a.bookings7d), 'Bookings · 7 days', delta(a.bookings7d, a.bookingsPrev7d), '#/bookings') +
        (full ? kpi(esc(naira(m.payments7dKobo)), 'Payments · 7 days', delta(m.payments7dKobo, m.paymentsPrev7dKobo), '#/finance', t.paymentsKobo) : '') +
        kpi(num(l.new7d), 'New listings · 7 days', delta(l.new7d, l.newPrev7d), '#/listings', t.listings) +
        kpi(num(a.waitlist), 'On the waitlist', '<span class="delta up">+' + num(a.waitlist7d) + ' this week</span>', '#/waitlist') + '</div>';

      // 3. Money
      var money = full ? '<h2 class="section-title">Money</h2><div class="grid cols-3 money-grid">' +
        kpi(esc(naira(m.revenue30dKobo)), 'RentCreeb revenue · 30 days', '<span class="faint">plans + escrow fees</span>', '#/finance') +
        kpi(esc(naira(m.payments30dKobo)), 'Payments · 30 days', '<span class="faint">' + num(m.paymentsCount30d) + ' payments' + (m.failed7d ? ' · ' + num(m.failed7d) + ' failed this week' : '') + '</span>', '#/payments') +
        kpi(esc(naira(Number(m.escrowHeldKobo) + Number(m.walletsKobo) + Number(m.withdrawalsPendingKobo))), 'Money held for users', '<span class="faint">escrow ' + esc(naira(m.escrowHeldKobo)) + ' · wallets ' + esc(naira(m.walletsKobo)) + ' · payouts ' + esc(naira(m.withdrawalsPendingKobo)) + '</span>', '#/escrow') +
        '</div>' : '';

      // 4. Trends
      var trends = '<div class="grid cols-2" style="margin-top:14px">' + section('Sign-ups, last 30 days', chart(t.signups)) +
        (full && t.paymentsKobo ? section('Payments, last 30 days', chart(t.paymentsKobo, naira)) : section('New listings, last 30 days', chart(t.listings))) + '</div>';

      // 5. People and listings
      var byRole = Object.keys(u.byRole || {}).map(function (k) { return [ROLE_NAMES[k] || k, u.byRole[k], '#/users?role=' + k]; }).sort(function (x, y) { return y[1] - x[1]; });
      if (!byRole.length) byRole = [['Tenants', u.tenants], ['Landlords & estate managers', u.landlords], ['Agents', u.agents], ['Artisans', u.artisans]];
      var byStatus = Object.keys(l.byStatus || {}).map(function (k) { var s = LISTING_STATUS[k] || [k, '']; return [s[0], l.byStatus[k], '#/listings?tab=' + k, s[1]]; }).sort(function (x, y) { return y[1] - x[1]; });
      var people = '<h2 class="section-title">People & listings</h2><div class="grid cols-3">' +
        section('Users by role', hbars(byRole, null, 'No users yet.'), '<span class="faint">' + num(u.total) + ' total' + (u.today ? ' · ' + num(u.today) + ' today' : '') + '</span>') +
        section('Verification funnel', funnel([['Signed up', u.total], ['Finished onboarding', u.onboarded], ['Phone verified', u.phoneVerified], ['NIN verified', u.verified]].filter(function (x) { return x[1] != null; })) +
          (u.suspended ? '<div class="faint" style="margin-top:8px"><a href="#/users?status=suspended">' + num(u.suspended) + ' suspended</a></div>' : '')) +
        section('Listings by status', hbars(byStatus, null, 'No listings yet.'), '<span class="faint">' + num(a.liveProperties) + ' live</span>') + '</div>';

      // 6. Where, and what money is for
      var cities = (l.topCities || []);
      var where = '<div class="grid cols-' + (full ? 2 : 1) + '" style="margin-top:14px">' +
        section('Top cities (live listings)', cities.length ? table(['City', 'Live listings', 'Average price'], cities, function (c) {
          return '<tr><td><b>' + esc(c.city) + '</b></td><td class="num">' + num(c.n) + '</td><td class="num">' + esc(naira(c.avgKobo)) + '</td></tr>'; }) : '<div class="empty">No live listings yet.</div>') +
        (full ? section('What people paid for · 30 days', hbars((m.byPurpose30d || []).map(function (p) { return [PURPOSE[p.purpose] || p.purpose, p.kobo, '#/payments?purpose=' + p.purpose]; }), naira, 'No payments in the last 30 days.')) : '') + '</div>';

      // 7. Operations
      var ops = '<h2 class="section-title">Operations</h2><div class="ops">' + [
        [a.activeTenancies, 'Active tenancies', '#/tenancies'], [a.openJobs, 'Open repair jobs', '#/jobs'], [a.heldEscrows, 'Escrows held', full ? '#/escrow' : null],
        [a.activeSubscriptions, 'Active subscriptions', full ? '#/subscriptions' : null], [a.tickets7d, 'Support tickets this week', '#/support'], [a.liveProperties, 'Live listings', '#/listings?tab=approved'],
      ].filter(function (x) { return x[0] != null; }).map(function (x) {
        return (x[2] ? '<a class="op" href="' + x[2] + '">' : '<div class="op">') + '<b>' + num(x[0]) + '</b><span>' + esc(x[1]) + '</span>' + (x[2] ? '</a>' : '</div>');
      }).join('') + '</div>';

      // 8. Recent
      var signups = (rc.signups || []).map(function (p) {
        return '<a class="feed-row" href="#/users/' + esc(p.id) + '">' + avatar(p) + '<div class="grow"><b>' + name(p) + '</b><div class="faint">' + label(ROLE_NAMES[p.role] ? ROLE_NAMES[p.role].replace(/s$/, '') : p.role) + ' · ' + esc(p.email || '') + '</div></div>' +
          '<div class="feed-meta">' + (p.nin_verified ? badge('NIN', 'ok') : p.phone_verified ? badge('Phone', 'warn') : '') + '<span class="faint">' + esc(ago(p.created_at)) + '</span></div></a>';
      }).join('') || '<div class="empty">No sign-ups yet.</div>';
      var pays = full ? (rc.payments || []).map(function (p) {
        return '<div class="feed-row">' + '<div class="pay-ico">₦</div><div class="grow"><b>' + esc(naira(p.amount_kobo)) + '</b> <span class="faint">' + esc(PURPOSE[p.purpose] || p.purpose) + '</span><div class="faint">' + (p.user ? userLink(p.user) : '—') + '</div></div>' +
          '<div class="feed-meta">' + statusBadge(p.status) + '<span class="faint">' + esc(ago(p.paid_at || p.created_at)) + '</span></div></div>';
      }).join('') || '<div class="empty">No payments yet.</div>' : '';
      var recent = '<h2 class="section-title">Latest</h2><div class="grid cols-' + (full ? 2 : 1) + '">' + section('New sign-ups', '<div class="feed">' + signups + '</div>', '<a class="btn sm" href="#/users">All users →</a>') +
        (full ? section('Latest payments', '<div class="feed">' + pays + '</div>', '<a class="btn sm" href="#/payments">All payments →</a>') : '') + '</div>';

      var activity = full ? '<h2 class="section-title">Recent admin activity <a class="btn sm" href="#/audit">Full audit log →</a></h2><div class="card">' + actionsTable(o.recentActions) + '</div>' : '';

      view(banner + '<h2 class="section-title">Needs attention ' + (waiting ? badge(num(waiting) + ' waiting', 'bad') : badge('All clear', 'ok')) + '</h2>' + queues +
        '<h2 class="section-title">Last 7 days</h2>' + kpis + money + trends + people + where + ops + recent + activity);
    };
    if (lastOverview) draw(lastOverview); else head(null);
    refreshCounts().then(function (o) { lastOverview = o; if ((parse().path[0] || 'overview') === 'overview') draw(o); }).catch(function (e) { if (!lastOverview) fail(e); });
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
          (safeUrl(u.avatar_url) ? fig(u.avatar_url, 'Profile photo', 'on the account') : '') + '</div><div class="faint">Photos open full size in a new tab. Links expire after 10 minutes. The selfie is deleted once you decide; the NIMC card and NIN response are kept on file.</div>') +
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
        ((p.video_urls || []).length ? section('Video tour links (' + p.video_urls.length + ')', videoCards(p.video_urls) + '<div class="faint">Check the video shows this property before approving.</div>') : '') +
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
      bindListingActions(); fillVideoCards(); bindGo(); bindNotes();
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
  // Every ticket is a chat thread in the user's Messages. Replies land there instantly; closing locks the thread.
  var KIND = { support: ['Support', ''], bug: ['Bug', 'warn'], data_request: ['Data request', 'bad'] };
  PAGES.support = function (r) {
    if (r.path[1]) return ticketPage(r.path[1]);
    var tab = r.q.tab || 'awaiting'; var page = Number(r.q.page || 1);
    shell('support', 'Support', 'Requests, bug reports and data requests. Each one is a conversation in the user’s Messages.');
    var filt = '<form class="row" id="tfilter" style="margin-bottom:12px"><input class="input" name="q" placeholder="Search subject or message" value="' + esc(r.q.q || '') + '"><select class="input" name="kind"><option value="">All kinds</option>' +
      [['support', 'Support'], ['bug', 'Bug reports'], ['data_request', 'Data requests']].map(function (x) { return '<option value="' + x[0] + '"' + (r.q.kind === x[0] ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('') + '</select><button class="btn">Filter</button></form>';
    var query = tab === 'awaiting' ? { awaiting: 'staff' } : tab === 'mine' ? { assigned: 'me' } : tab === 'unassigned' ? { assigned: 'none' } : tab === 'all' ? {} : { status: tab };
    var fetchList = function () { return api('/admin/tickets' + qs(Object.assign({}, query, { kind: r.q.kind, q: r.q.q, page: page, limit: PAGE }))).then(function (j) {
      var list = j.tickets || [];
      view(tabs([['awaiting', 'Needs a reply'], ['mine', 'Assigned to me'], ['unassigned', 'Unassigned'], ['open', 'Open'], ['in_progress', 'In progress'], ['resolved', 'Resolved'], ['closed', 'Closed'], ['all', 'All']], tab, function (t) { return '/support' + qs({ tab: t, kind: r.q.kind }); }) + filt +
        (list.length ? '<div class="card">' + table(['', 'Request', 'From', 'Status', 'Last activity'], list, function (t) {
          var k = KIND[t.kind] || [t.kind, ''];
          return '<tr class="click" data-go="#/support/' + esc(t.id) + '"><td>' + (t.awaiting === 'staff' ? '<span class="dot hot" title="Waiting for support"></span>' : '<span class="dot"></span>') + '</td>' +
            '<td><div class="row" style="gap:6px">' + badge(k[0], k[1]) + (t.severity ? badge(t.severity, t.severity === 'high' ? 'bad' : 'grey') : '') + '<b>' + esc(t.subject) + '</b></div><div class="faint clamp">' + esc(t.admin_note && t.awaiting === 'user' ? 'You: ' + t.admin_note : t.message) + '</div></td>' +
            '<td>' + name(t.user) + '<div class="faint">' + esc(t.category) + (t.assignee ? ' \u00b7 ' + (t.assignee.id === me.id ? 'you' : esc(t.assignee.first_name || 'agent')) : '') + '</div></td><td>' + statusBadge(t.status) + (t.awaiting === 'user' ? '<div class="faint">waiting for user</div>' : '') + '</td><td class="num">' + ago(t.last_message_at || t.created_at) + '</td></tr>';
        }) + '</div>' : '<div class="card empty">' + (tab === 'awaiting' ? 'All caught up: nobody is waiting for a reply.' : 'No tickets here.') + '</div>') + pager(page, j.total, r.raw));
      $('#tfilter').onsubmit = function (e) { e.preventDefault(); location.hash = '#/support' + qs({ tab: tab, q: e.target.q.value.trim(), kind: e.target.kind.value }); };
      bindGo();
    }).catch(fail); };
    fetchList();
    // New requests and replies appear on their own (debounced; never while you're typing in the filter).
    var soon = null;
    pageStream = liveStream({ inbox: '1' }, function (type) {
      if (type !== 'ticket') return;
      clearTimeout(soon);
      soon = setTimeout(function () { var a = document.activeElement; if (!a || !a.closest || !a.closest('#tfilter')) fetchList(); }, 400);
    });
  };

  function ticketPage(id) {
    shell('support', 'Support request', '');
    var last = null; var draft = ''; var pending = null; var pendingUrl = null;
    var userTyping = false; var typingOff = null; var userId = null; var liveOn = false;
    var paintTyping = function () { var el = $('#typing-ind'); if (el) el.hidden = !userTyping; var d = $('#live-dot'); if (d) { d.className = 'live-dot' + (liveOn ? ' on' : ''); d.title = liveOn ? 'Live: new messages appear instantly' : 'Reconnecting…'; } };
    // Tell the user "Support is typing…" (throttled; stops after a pause or when the reply is sent).
    var myTyping = false; var lastPing = 0; var idle = null;
    var pingTyping = function (on) {
      clearTimeout(idle);
      if (on) { idle = setTimeout(function () { pingTyping(false); }, 4000); if (Date.now() - lastPing < 3000 && myTyping) return; lastPing = Date.now(); }
      if (!on && !myTyping) return;
      myTyping = on; post('/admin/tickets/' + id + '/typing', { typing: on }).catch(function () {});
    };
    var showChip = function () {
      var c = $('#reply-chip'); if (!c) return;
      if (pendingUrl) { URL.revokeObjectURL(pendingUrl); pendingUrl = null; }
      if (!pending) { c.innerHTML = ''; return; }
      var isImg = /^image\//.test(pending.type); if (isImg) pendingUrl = URL.createObjectURL(pending);
      c.innerHTML = '<div class="file-chip">' + (isImg ? '<img alt="" src="' + pendingUrl + '">' : '<span class="fi">PDF</span>') + '<div><b>' + esc(pending.name) + '</b><div class="faint">' + Math.max(1, Math.round(pending.size / 1024)) + ' KB \u00b7 sent with your reply</div></div><button type="button" class="btn sm" id="chip-x" aria-label="Remove attachment">\u2715</button></div>';
      on('chip-x', function () { pending = null; showChip(); });
    };
    var STATUS = [['open', 'Open'], ['in_progress', 'In progress'], ['resolved', 'Resolved'], ['closed', 'Closed']];
    function load(first) {
      return api('/admin/tickets/' + id).then(function (j) {
        var t = j.ticket; var u = t.user || {};
        var staff = {}; (j.staff || []).forEach(function (s) { staff[s.id] = s; });
        var tail = j.messages.length ? j.messages[j.messages.length - 1] : null;
        var sig = j.messages.length + ':' + (tail ? tail.id + tail.read_at : '') + ':' + t.status + ':' + j.closed;
        if (!first && sig === last) return; last = sig;
        var box = $('#reply-body'); if (box) draft = box.value;
        var k = KIND[t.kind] || [t.kind, ''];
        var thread = j.messages.map(function (m) {
          if (m.system) return '<div class="msg system">' + esc(m.body) + '<div class="meta">' + when(m.created_at) + '</div></div>';
          var att = m.attachment && safeUrl(m.attachment) ? (/^image\//.test(m.attachment_type || '') ? '<button type="button" class="att-btn" data-photo="' + safeUrl(m.attachment) + '" aria-label="View photo"><img class="att" alt="" loading="lazy" src="' + safeUrl(m.attachment) + '"></button>' : '<div><a target="_blank" rel="noopener" href="' + safeUrl(m.attachment) + '">📎 ' + esc(m.attachment_name || 'Attachment') + '</a></div>') : '';
          var who = m.staff ? (staff[m.sender_id] ? plainName(staff[m.sender_id]) : 'Support') + ' (support)' : plainName(u);
          return '<div class="msg' + (m.staff ? ' right' : '') + '">' + esc(m.body || '') + att + '<div class="meta">' + esc(who) + ' · ' + when(m.created_at) + (m.staff ? (m.read_at ? ' · seen' : ' · sent') : '') + '</div></div>';
        }).join('');
        var composer = j.closed
          ? '<div class="alert info">This conversation is closed. The user can no longer send messages here. <button class="btn sm" data-st="in_progress">Reopen</button></div>'
          : '<form class="stack" id="reply"><textarea class="input" id="reply-body" placeholder="Reply to ' + esc(plainName(u) || 'the user') + '… (Ctrl+Enter to send)" style="min-height:90px"></textarea>' +
            '<div id="reply-chip"></div><input type="file" id="reply-file" accept="image/jpeg,image/png,image/webp,application/pdf" hidden>' +
            '<div class="row between"><div class="row"><button type="button" class="btn" id="reply-attach">\uD83D\uDCCE Photo or file</button><span class="faint">Arrives in their Messages, as a push and by email.</span></div><div class="row">' +
            '<button type="button" class="btn" id="reply-resolve">Send &amp; resolve</button><button type="button" class="btn ghost-danger" id="reply-close">Send &amp; close</button><button class="btn primary">Send reply</button></div></div></form>';
        view('<div class="row" style="margin-bottom:12px"><a class="btn sm" href="#/support">← All requests</a></div><div class="grid ticket-grid">' +
          '<div class="card stack"><div class="row between"><div class="row">' + badge(k[0], k[1]) + (t.severity ? badge(t.severity + ' severity', t.severity === 'high' ? 'bad' : 'grey') : '') + '<h2>' + esc(t.subject) + '</h2></div><div class="row"><span id="live-dot" class="live-dot' + (liveOn ? ' on' : '') + '"></span>' + statusBadge(t.status) + '</div></div>' +
          '<div class="msgs thread" id="thread">' + (thread || '<div class="empty">No messages yet.</div>') + '</div>' +
          '<div class="typing-ind" id="typing-ind" hidden><span class="dots"><i></i><i></i><i></i></span>' + esc(u.first_name || 'They') + ' is typing\u2026</div>' + composer + '</div>' +
          '<div class="stack">' + section('Person', '<div class="row">' + avatar(u) + '<div>' + userLink(u) + '<div class="faint">' + label(u.role) + (u.is_suspended ? ' · suspended' : '') + '</div></div></div>' +
            kv([['Email', esc(u.email || '')], ['Phone', esc(u.phone || '')], ['Member since', day(u.created_at)]])) +
          section('Assigned to', '<div class="row between"><span>' + (t.assignee ? (t.assignee.id === me.id ? '<b>You</b>' : name(t.assignee)) : '<span class="faint">Nobody yet</span>') + '</span>' +
            (t.assignee && t.assignee.id === me.id ? '<button class="btn sm" id="t-unassign">Unassign</button>' : '<button class="btn sm primary" id="t-take">Take this chat</button>') + '</div>' +
            (t.meta && t.meta.assistantConversationId ? '<button class="btn sm" id="t-transcript">\u2728 View AI Assistant chat</button><div class="faint">The user started with the AI Assistant' + (t.meta.reason ? ': \u201c' + esc(t.meta.reason) + '\u201d' : '') + '</div>' : '')) +
          section('Status', '<div class="row">' + STATUS.map(function (s) { return '<button class="btn sm' + (t.status === s[0] ? ' primary' : '') + '" data-st="' + s[0] + '"' + (t.status === s[0] ? ' disabled' : '') + '>' + s[1] + '</button>'; }).join('') + '</div>' +
            '<div class="faint">Resolved keeps the chat open (a reply from the user re-opens the ticket). Closed locks the chat until you reopen it.</div>' +
            kv([['Category', esc(t.category)], ['Opened', when(t.created_at)], ['Closed', t.closed_at ? when(t.closed_at) : '']])) +
          (t.meta && Object.keys(t.meta).filter(function (m) { return ['source', 'assistantConversationId', 'reason'].indexOf(m) < 0; }).length ? section('Device', kv(Object.keys(t.meta).filter(function (m) { return ['source', 'assistantConversationId', 'reason'].indexOf(m) < 0; }).map(function (m) { return [m, esc(typeof t.meta[m] === 'object' ? JSON.stringify(t.meta[m]) : t.meta[m])]; }))) : '') +
          (t.kind === 'data_request' ? section('Data request', '<p class="faint">Export or erase their data from the account page.</p><a class="btn" href="#/users/' + esc(u.id) + '">Open account</a>') : '') +
          ((j.otherTickets || []).length ? section('Their other requests', table(['Subject', 'Status'], j.otherTickets, function (o) { return '<tr class="click" data-go="#/support/' + esc(o.id) + '"><td>' + esc(o.subject) + '<div class="faint">' + ago(o.created_at) + '</div></td><td>' + statusBadge(o.status) + '</td></tr>'; })) : '') +
          notesBlock('ticket', t.id, j.notes) + '</div></div>');
        userId = u.id; paintTyping();
        var th = $('#thread'); if (th) th.scrollTop = th.scrollHeight;
        var rb = $('#reply-body'); if (rb) { rb.value = draft; if (first) rb.focus(); }
        bindGo(); bindNotes(); showChip();
        on('t-take', function () { act(api('/admin/tickets/' + id, { method: 'PATCH', body: { assignedTo: me.id } }), 'Assigned to you'); });
        on('t-unassign', function () { act(api('/admin/tickets/' + id, { method: 'PATCH', body: { assignedTo: null } }), 'Unassigned'); });
        on('t-transcript', function () { showAssistantChat(t.meta.assistantConversationId); });
        $$('[data-photo]').forEach(function (b) { b.onclick = function () { lightbox(b.dataset.photo, plainName(u)); }; });
        var fi = $('#reply-file'); if (fi) {
          on('reply-attach', function () { fi.click(); });
          fi.onchange = function () {
            var f = fi.files && fi.files[0]; fi.value = ''; if (!f) return;
            if (f.size > 25 * 1024 * 1024) { toast('That file is larger than 25 MB', true); return; }
            if (!/^(image\/(jpeg|png|webp)|application\/pdf)$/.test(f.type)) { toast('Send a JPG, PNG, WebP or PDF', true); return; }
            pending = f; showChip();
          };
          // Paste a screenshot straight into the reply box.
          rb.onpaste = function (e) { var it = [].slice.call((e.clipboardData || {}).items || []).filter(function (x) { return /^image\//.test(x.type); })[0]; if (it) { var f = it.getAsFile(); if (f) { pending = new File([f], 'screenshot-' + Date.now() + '.png', { type: f.type }); showChip(); e.preventDefault(); } } };
        }
        bind('[data-st]', function (st) {
          var go = function () { act(api('/admin/tickets/' + id, { method: 'PATCH', body: { status: st } }), st === 'closed' ? 'Closed: the user can no longer reply' : 'Status updated'); };
          if (st === 'closed') form({ title: 'Close this conversation?', body: 'The user’s chat is locked straight away and they can’t send more messages on this request.', confirm: 'Close', danger: true }).then(function (v) { if (v) go(); });
          else go();
        });
        var send = function (status) {
          var body = ($('#reply-body').value || '').trim(); if (!body && !pending) { toast('Write a reply or attach a photo', true); return; }
          pingTyping(false);
          $$('#reply button').forEach(function (b) { b.disabled = true; });
          var file = pending;
          (file ? uploadFile('chat-files', file).then(function (up) { return { path: up.path, name: up.name || file.name, type: up.mime || file.type, size: up.size || file.size }; }) : Promise.resolve(undefined))
            .then(function (attachment) { return post('/admin/tickets/' + id + '/messages', { body: body, status: status, attachment: attachment }); })
            .then(function () { pending = null; showChip(); }).then(function () { draft = ''; $('#reply-body').value = ''; toast(status === 'closed' ? 'Sent and closed' : status === 'resolved' ? 'Sent and resolved' : 'Reply sent'); last = null; return load(); })
            .catch(function (e) { toast(e.message, true); $$('#reply button').forEach(function (b) { b.disabled = false; }); });
        };
        var f = $('#reply'); if (f) {
          f.onsubmit = function (e) { e.preventDefault(); send(); };
          rb.onkeydown = function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } };
          rb.oninput = function () { pingTyping(!!rb.value.trim()); };
          on('reply-resolve', function () { send('resolved'); });
          on('reply-close', function () { form({ title: 'Send and close?', body: 'The user’s chat locks right after your reply.', confirm: 'Send & close', danger: true }).then(function (v) { if (v) send('closed'); }); });
        }
      });
    }
    load(true).catch(fail);
    // New messages from the user show up without a reload.
    var soon = null;
    var refresh = function () { clearTimeout(soon); soon = setTimeout(function () { if (!$('#modal-root').innerHTML) load().catch(function () {}); }, 120); };
    pageStream = liveStream({ ticketId: id }, function (type, e) {
      if (type === 'message') { if (e.op === 'insert') { userTyping = false; paintTyping(); } refresh(); }
      else if (type === 'typing' && e.userId === userId) {
        userTyping = !!e.on; paintTyping();
        clearTimeout(typingOff); if (userTyping) typingOff = setTimeout(function () { userTyping = false; paintTyping(); }, 7000);
      }
    }, function (on) { liveOn = on; paintTyping(); if (on) refresh(); });
    pageTimer = setInterval(function () { if (document.visibilityState === 'visible' && !$('#modal-root').innerHTML) load().catch(function () {}); }, liveOn ? 60000 : 30000);
  }

  // ═════════ Scam alerts ═════════
  // Warnings raised in chats by services/scamGuard.ts. The warned person sees them in the chat; the suspect never does.
  var SCAM_CAT = { off_platform_payment: 'Payment outside RentCreeb', advance_fee: 'Money before inspection', credential_phishing: 'Asked for OTP / PIN / password', fake_listing: 'Fake listing story',
    impersonation: 'Pretends to be RentCreeb', off_platform_contact: 'Moving off RentCreeb', pressure: 'Pressure to pay', other: 'Other' };
  var SCAM_STATUS = { open: ['New', 'warn'], reported: ['Reported by user', 'bad'], dismissed: ['User said it’s fine', 'grey'], confirmed: ['Confirmed scam', 'bad'], cleared: ['False alarm', 'ok'] };
  PAGES.scam = function (r) {
    var page = Number(r.q.page || 1); var tab = r.q.tab || 'todo';
    shell('scam', 'Scam alerts', 'Chats where the AI spotted a likely scam. The person at risk was warned in the chat.');
    api('/admin/scam-alerts' + qs({ tab: tab, page: page, limit: PAGE })).then(function (j) {
      if (j.missing) return view('<div class="err">Run migration 024_scam_alerts.sql in Supabase to turn on scam alerts.</div>');
      var c = j.counts || {};
      view(tabs([['todo', 'To review', String((c.open || 0) + (c.reported || 0))], ['reported', 'Reported by user', String(c.reported || 0)], ['confirmed', 'Confirmed'], ['cleared', 'False alarms'], ['dismissed', 'User said fine'], ['all', 'All']], tab, function (t) { return '/scam' + qs({ tab: t }); }) +
        '<div class="card">' + table(['When', 'Risk', 'Suspect', 'Warned', 'What was said', 'Status', ''], j.alerts, function (a) {
          var st = SCAM_STATUS[a.status] || [a.status, ''];
          var sus = a.suspect ? userLink(a.suspect) + '<div class="chips">' + (a.suspect.is_suspended ? badge('Suspended', 'bad') : '') + (a.suspectAlertCount > 1 ? badge(a.suspectAlertCount + ' alerts', 'bad') : '') + '</div>' : '—';
          return '<tr><td class="num">' + when(a.created_at) + '</td><td>' + badge(a.risk === 'high' ? 'High' : 'Medium', a.risk === 'high' ? 'bad' : 'warn') + '<div class="faint">' + esc(SCAM_CAT[a.category] || label(a.category)) + '</div><div class="faint">' + (a.source === 'ai' ? 'AI' : 'Rules') + '</div></td>' +
            '<td>' + sus + '</td><td>' + userLink(a.recipient) + '</td>' +
            '<td style="max-width:360px"><div style="white-space:pre-wrap">' + esc((a.excerpt || '').slice(0, 300)) + '</div><div class="faint" style="margin-top:6px">Warning shown: ' + esc(a.reason) + '</div>' +
            ((a.signals || []).length ? '<div class="chips" style="margin-top:6px">' + a.signals.map(function (x) { return badge(x, 'grey'); }).join('') + '</div>' : '') +
            (a.admin_note ? '<div class="faint" style="margin-top:6px;white-space:pre-wrap">' + esc(a.admin_note) + '</div>' : '') + '</td>' +
            '<td>' + badge(st[0], st[1]) + '</td>' +
            '<td><div class="row" style="justify-content:flex-end;flex-wrap:wrap;gap:6px"><button class="btn sm" data-conv="' + esc(a.conversation_id) + '">Read chat</button>' +
            (a.status !== 'confirmed' ? '<button class="btn sm danger" data-sconfirm="' + esc(a.id) + '">Confirm scam</button>' : '') +
            (a.status !== 'cleared' ? '<button class="btn sm" data-sclear="' + esc(a.id) + '">False alarm</button>' : '') + '</div></td></tr>';
        }, tab === 'todo' ? 'Nothing to review. 🎉' : 'No alerts here.') + '</div>' + pager(page, j.total, r.raw));
      bind('[data-conv]', function (id) { openConversation(id); });
      bind('[data-sconfirm]', function (id) {
        var a = j.alerts.filter(function (x) { return x.id === id; })[0];
        form({ title: 'Confirm this was a scam?', body: 'The warned person is told it was confirmed. To stop the suspect, suspend them from their user page.', confirm: 'Confirm scam', danger: true,
          fields: [{ name: 'note', label: 'Note (kept with the alert)', type: 'textarea' }, { name: 'tellRecipient', label: 'Notify the person who was warned', type: 'checkbox', value: true }] }).then(function (v) {
          if (!v) return;
          act(api('/admin/scam-alerts/' + id, { method: 'PATCH', body: { status: 'confirmed', note: v.note, tellRecipient: !!v.tellRecipient } }), 'Marked as a scam').then(function () {
            if (a && a.suspect && !a.suspect.is_suspended) form({ title: 'Suspend ' + plainName(a.suspect) + '?', body: 'Open their user page to suspend them (this also blocks sign-in).', confirm: 'Open user page' }).then(function (go) { if (go) location.hash = '#/users/' + a.suspect.id; });
          });
        });
      });
      bind('[data-sclear]', function (id) {
        form({ title: 'Mark as a false alarm?', body: 'The warning disappears from the chat.', confirm: 'False alarm', fields: [{ name: 'note', label: 'Note (optional)', type: 'textarea' }] }).then(function (v) {
          if (v) act(api('/admin/scam-alerts/' + id, { method: 'PATCH', body: { status: 'cleared', note: v.note } }), 'Marked as a false alarm');
        });
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

  // ═════════ Waitlist ═════════
  // Website "Join the waitlist" sign-ups (mailing contacts tagged "waitlist"). API: src/routes/admin/waitlist.ts.
  var WL_STATUS = [['pending', 'Pending'], ['contacted', 'Contacted'], ['invited', 'Invited'], ['joined', 'Joined the app'], ['declined', 'Not interested']];
  var WL_TONE = { pending: 'warn', contacted: '', invited: '', joined: 'ok', declined: 'grey' };
  function wlLabel(s) { var f = WL_STATUS.filter(function (x) { return x[0] === s; })[0]; return f ? f[1] : s; }
  PAGES.waitlist = function (r) {
    var page = Number(r.q.page || 1); var f = { q: r.q.q, status: r.q.status };
    shell('waitlist', 'Waitlist', 'People who joined the waitlist on rentcreeb.com. New sign-ups get the “Waitlist welcome” email straight away (Mailing → Automations).',
      isManager() ? '' : '<button class="btn sm" id="wl-export">Export CSV</button><a class="btn sm primary" href="#/mail-campaigns/new?for=waitlist">Email the waitlist</a>');
    api('/admin/waitlist' + qs(Object.assign({ page: page, limit: PAGE }, f))).then(function (j) {
      var s = j.summary; var items = j.items;
      var stat = function (n, l) { return '<div class="card stat"><span class="n">' + num(n) + '</span><span class="l">' + esc(l) + '</span></div>'; };
      view('<div class="grid cols-4" style="margin-bottom:16px">' + stat(s.total, 'On the waitlist') + stat(s.lastWeek, 'Joined in the last 7 days') + stat(s.byStatus.pending || 0, 'Not contacted yet') + stat(s.byStatus.joined || 0, 'Joined the app') + '</div>' +
        tabs([['', 'All', String(s.total)]].concat(WL_STATUS.map(function (x) { return [x[0], x[1], String(s.byStatus[x[0]] || 0)]; })), f.status || '', function (t) { return '/waitlist' + qs({ q: f.q, status: t }); }) +
        '<form class="row" id="wlf" style="margin:12px 0"><input class="input" name="q" placeholder="Search name or email" value="' + esc(f.q || '') + '"><button class="btn">Search</button></form>' +
        '<div class="card">' + table(['Joined', 'Person', 'I am', 'Interested in', 'Location', 'Status', ''], items, function (x, i) {
          return '<tr class="click" data-wl="' + i + '"><td class="num">' + when(x.createdAt) + '</td><td><b>' + esc(x.name || '—') + '</b><div class="faint">' + esc(x.email) + (x.phone ? ' · ' + esc(x.phone) : '') + '</div></td>' +
            '<td>' + esc(x.iAm || '—') + '</td><td><div class="chips">' + x.interest.map(function (t) { return badge(t, 'grey'); }).join('') + '</div></td>' +
            '<td class="faint">' + esc([x.city, x.lga, x.state].filter(Boolean).join(', ') || '—') + '</td><td>' + badge(wlLabel(x.status), WL_TONE[x.status]) + (x.notes ? ' <span class="faint" title="Has notes">✎</span>' : '') + '</td>' +
            '<td><button class="btn sm" data-wl="' + i + '">Open</button></td></tr>';
        }, f.q || f.status ? 'Nobody matches.' : 'Nobody has joined the waitlist yet.') + '</div>' + pager(page, j.total, r.raw));
      $('#wlf').onsubmit = function (e) { e.preventDefault(); location.hash = '#/waitlist' + qs({ q: e.target.q.value.trim(), status: f.status }); };
      bind('[data-wl]', function (i) { waitlistEntry(items[Number(i)]); });
    }).catch(fail);
    on('wl-export', function () { download('/admin/waitlist.csv' + qs(f), 'rentcreeb-waitlist.csv'); });
  };
  function waitlistEntry(x) {
    var rowOf = function (k, v) { return v ? '<div class="row between" style="gap:12px;padding:6px 0;border-bottom:1px solid var(--line, #e5e7eb)"><span class="faint">' + esc(k) + '</span><span style="text-align:right">' + v + '</span></div>' : ''; };
    var info = '<div style="margin:8px 0 4px">' + rowOf('Email', '<a href="mailto:' + esc(x.email) + '">' + esc(x.email) + '</a>') + rowOf('Phone', x.phone ? '<a href="tel:' + esc(x.phone) + '">' + esc(x.phone) + '</a>' : '') +
      rowOf('I am', esc(x.iAm)) + rowOf('Interested in', esc(x.interest.join(', '))) + rowOf('Location', esc([x.city, x.lga, x.state].filter(Boolean).join(', '))) +
      rowOf('Joined', when(x.createdAt)) + rowOf('Source', esc(x.source)) + rowOf('Mailing', x.mailStatus ? '<a href="#/mail-contacts/' + esc(x.id) + '">' + label(x.mailStatus) + '</a>' : '') +
      (x.message ? '<div style="padding:8px 0"><div class="faint">Message</div><div style="white-space:pre-wrap">' + esc(x.message) + '</div></div>' : '') + '</div>';
    form({ title: x.name || x.email, wide: true, html: info, confirm: 'Save',
      fields: [{ name: 'status', label: 'Status', type: 'select', options: WL_STATUS, value: x.status }, { name: 'notes', label: 'Internal notes', type: 'textarea', value: x.notes, placeholder: 'e.g. Called on Monday, wants a 2-bed in Lekki' }] }).then(function (v) {
      if (!v) return;
      act(api('/admin/waitlist/' + encodeURIComponent(x.id), { method: 'PATCH', body: { status: v.status, notes: v.notes || '' } }), 'Saved');
    });
    var foot = $('.modal .sticky-actions');
    if (foot) {
      var rm = document.createElement('button'); rm.type = 'button'; rm.className = 'btn danger'; rm.textContent = 'Remove from waitlist'; rm.style.marginRight = 'auto';
      rm.onclick = function () {
        $('#m-cancel').click(); // closes the entry dialog properly before the confirmation opens
        form({ title: 'Remove ' + (x.name || x.email) + ' from the waitlist?', body: 'They stay on the mailing list. This does not email them.', confirm: 'Remove', danger: true }).then(function (ok) {
          if (ok) act(api('/admin/waitlist/' + encodeURIComponent(x.id), { method: 'DELETE' }), 'Removed from the waitlist');
        });
      };
      foot.insertBefore(rm, foot.firstChild);
    }
  }

  // ═════════ Users ═════════
  var ROLES = [['tenant', 'Tenant'], ['landlord', 'Landlord'], ['estate_manager', 'Estate manager'], ['agent', 'Agent'], ['artisan', 'Artisan'], ['developer', 'Developer'], ['investor', 'Investor'], ['admin_manager', 'Admin manager'], ['admin', 'Admin']];
  PAGES.users = function (r) {
    if (r.path[1]) return userDetail(r.path[1]);
    var page = Number(r.q.page || 1);
    var f = { q: r.q.q, role: r.q.role, status: r.q.status, sort: r.q.sort };
    shell('users', 'Users', 'Search accounts, check activity, verify, message or suspend.', isManager() ? '' : '<button class="btn sm" id="u-export">Export CSV</button>');
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
      var u = j.user, a = j.artisan, au = j.auth || {}, self = u.id === me.id, closed = !!u.deleted_at, full = !isManager(), staff = isAdminRole(u.role);
      shell('users', plainName(u) || 'User', label(u.role).replace(/&amp;/g, '&') + ' · joined ' + when(u.created_at), '<a class="btn sm" href="#/users">← All users</a>');
      var delItem = full && !self && u.role !== 'admin' ? '<button data-ua="delete" class="danger-text">Delete permanently</button>' : '';
      var menuItems = closed ? delItem : [
        full || !staff || self ? '<button data-ua="edit">Edit profile</button>' : '', self || !full ? '' : '<button data-ua="role">Change role</button>', '<button data-ua="message">Send a message</button>', u.email ? '<button data-ua="reset">Send password reset email</button>' : '',
        '<hr>', u.nin_verified ? '<button data-ua="revoke" class="danger-text">Revoke NIN verification</button>' : '<button data-ua="verify">Mark NIN verified</button>', !u.nin_verified ? '<button data-ua="attempts">Reset verification attempts</button>' : '',
        u.phone ? (u.phone_verified ? '<button data-ua="phoneoff">Mark phone unverified</button>' : '<button data-ua="phoneon">Mark phone verified</button>') : '',
        full ? '<hr>' : '', full ? '<button data-ua="credit">Credit wallet</button>' : '', full ? '<button data-ua="debit">Debit wallet</button>' : '', full && ['agent', 'landlord', 'estate_manager'].indexOf(u.role) >= 0 ? '<button data-ua="grant">Give a subscription plan</button>' : '',
        '<hr>', self || (!full && staff) ? '' : u.is_suspended ? '<button data-ua="unsuspend">Lift suspension</button>' : '<button data-ua="suspend" class="danger-text">Suspend account</button>', self || !full ? '' : '<button data-ua="close" class="danger-text">Close account (anonymise)</button>', delItem,
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
        role: function () { form({ title: 'Change role', body: 'Admin gives full access to this dashboard. Admin manager gives moderation and support only (no money, mailing, settings or role changes).', fields: [{ name: 'role', label: 'Role', type: 'select', value: u.role, options: ROLES }, { name: 'reason', label: 'Reason (audit log)', type: 'textarea', required: true, min: 3 }], confirm: 'Change role', danger: true })
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
        delete: function () {
          form({ title: 'Delete this account permanently?', danger: true, confirm: 'Delete permanently',
            body: 'This removes ' + plainName(u) + '\u2019s sign-in, profile, listings, chats, bookings, tenancies, jobs, reviews, documents and photos, including records shared with the other people involved. Payments and escrow records are kept without their name. This cannot be undone. It is refused while they have money in their wallet, RentSave or escrow, a pending withdrawal, an active tenancy or a paid booking.',
            fields: [{ name: 'reason', label: 'Reason (audit log)', type: 'textarea', required: true, min: 3, placeholder: 'e.g. Data deletion request, ticket #…' }, { name: 'confirm', label: 'Type DELETE to confirm', required: true }] })
            .then(function (v) {
              if (!v) return; if (v.confirm !== 'DELETE') { toast('Type DELETE to confirm', true); return; }
              post('/admin/users/' + u.id + '/delete', { confirm: 'DELETE', reason: v.reason })
                .then(function () { toast('Account deleted permanently'); location.hash = '#/users'; })
                .catch(function (e) { toast(e.message, true); });
            });
        },
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
      var canCancel = !isManager() && ['pending_payment', 'paid', 'confirmed'].indexOf(b.status) >= 0, canComplete = !isManager() && ['paid', 'confirmed'].indexOf(b.status) >= 0;
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
  // ═════════ Files & images ═════════
  // Upload images and files to the CDN and copy their public links (emails, website, announcements).
  function fmtBytes(n) { n = Number(n || 0); return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }
  function copyText(text, okMsg) {
    var done = function () { toast(okMsg || 'Copied'); };
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(done, function () { fallback(); });
    fallback();
    function fallback() { var t = document.createElement('textarea'); t.value = text; t.style.position = 'fixed'; t.style.opacity = '0'; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); done(); } catch (e) { toast('Copy failed: select the link and copy it', true); } t.remove(); }
  }
  /** Multipart upload with the admin token (api() only sends JSON). Retries once after refreshing an expired session. */
  function uploadFiles(files, onProgress, retried) {
    return new Promise(function (resolve, reject) {
      var fd = new FormData(); Array.prototype.forEach.call(files, function (f) { fd.append('files', f, f.name); });
      var x = new XMLHttpRequest(); x.open('POST', API + '/admin/media');
      if (session && session.access_token) x.setRequestHeader('Authorization', 'Bearer ' + session.access_token);
      x.upload.onprogress = function (e) { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
      x.onload = function () {
        var j = {}; try { j = JSON.parse(x.responseText || '{}'); } catch (e) {}
        if (x.status === 401 && !retried && session && session.refresh_token) return refreshSession().then(function () { return uploadFiles(files, onProgress, true); }).then(resolve, reject);
        if (x.status >= 200 && x.status < 300) resolve(j); else reject(new Error((j.error && j.error.message) || ('Upload failed (' + x.status + ')')));
      };
      x.onerror = function () { reject(new Error('Upload failed: check your connection')); };
      x.send(fd);
    });
  }
  var FILE_ICON = { pdf: 'PDF', doc: 'DOC', docx: 'DOC', xls: 'XLS', xlsx: 'XLS', csv: 'CSV', ppt: 'PPT', pptx: 'PPT', txt: 'TXT', zip: 'ZIP', mp3: 'MP3', wav: 'WAV' };

  PAGES.media = function (r) {
    var filter = r.q.q || '', kind = r.q.kind || '';
    shell('media', 'Files & images', 'Upload images and files, then copy their link to use in emails, the website or announcements.');
    var render = function (j) {
      var all = j.files || [];
      var shown = all.filter(function (f) { return (!kind || (kind === 'file' ? f.kind !== 'image' : f.kind === kind)) && (!filter || f.name.toLowerCase().indexOf(filter.toLowerCase()) >= 0); });
      var nImg = all.filter(function (f) { return f.kind === 'image'; }).length;
      view('<label class="dropzone card" id="drop" tabindex="0"><input type="file" id="media-input" multiple hidden accept="' + esc((j.accepted || []).map(function (e) { return '.' + e; }).join(',')) + '">' +
          '<div class="drop-ico">' + icon('upload', '') + '</div><b>Drop images or files here, or click to choose</b>' +
          '<span class="faint">Up to 10 at a time, ' + fmtBytes(j.maxBytes) + ' each · ' + esc((j.accepted || []).join(', ')) + '</span>' +
          '<div class="progress" id="up-prog" hidden><div></div></div></label>' +
        '<div id="just-up"></div>' +
        '<div class="row between" style="margin:18px 0 10px"><div class="row">' + tabs([['', 'All', String(all.length)], ['image', 'Images', String(nImg)], ['file', 'Other files', String(all.length - nImg)]], kind, function (t) { return '/media' + qs({ q: filter, kind: t }); }) + '</div>' +
          '<form class="row" id="mf"><input class="input" name="q" placeholder="Search by file name" value="' + esc(filter) + '"><button class="btn">Search</button></form></div>' +
        '<div class="faint" style="margin-bottom:10px">' + num(all.length) + ' files · ' + fmtBytes(j.totalBytes) + ' in total. Links are public: anyone with a link can open the file.</div>' +
        (shown.length ? '<div class="media-grid">' + shown.map(function (f, i) {
          var thumb = f.kind === 'image' ? '<img loading="lazy" alt="" src="' + safeUrl(f.url) + '">' : f.kind === 'video' ? '<video preload="metadata" muted src="' + safeUrl(f.url) + '"></video>' : '<span class="file-ext">' + esc(FILE_ICON[f.ext] || String(f.ext || 'FILE').toUpperCase()) + '</span>';
          return '<div class="media-card card"><a class="media-thumb" href="' + safeUrl(f.url) + '" target="_blank" rel="noopener" title="Open">' + thumb + '</a>' +
            '<div class="media-body"><div class="media-name" title="' + esc(f.name) + '">' + esc(f.name) + '</div><div class="faint">' + fmtBytes(f.size) + ' · ' + esc(ago(f.createdAt)) + '</div>' +
            '<div class="url-row"><input class="input sm" readonly value="' + esc(f.url) + '" aria-label="Link"><button class="btn sm primary" data-copy="' + i + '">Copy link</button></div>' +
            '<div class="row media-acts">' + (f.kind === 'image' ? '<button class="btn sm" data-copyimg="' + i + '">Copy &lt;img&gt;</button>' : '') +
              '<a class="btn sm" href="' + safeUrl(f.url) + '" target="_blank" rel="noopener">Open</a><button class="btn sm ghost-danger" data-del="' + i + '">Delete</button></div></div></div>';
        }).join('') + '</div>' : '<div class="card empty">' + (all.length ? 'No files match.' : 'No uploads yet. Drop your first image above.') + '</div>'));

      $$('.url-row input').forEach(function (inp) { inp.onclick = function () { inp.select(); }; });
      bind('[data-copy]', function (i) { copyText(shown[i].url, 'Link copied'); });
      bind('[data-copyimg]', function (i) { var f = shown[i]; copyText('<img src="' + f.url + '" alt="' + f.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/"/g, '') + '" style="max-width:100%;height:auto;border-radius:10px">', 'Image HTML copied'); });
      bind('[data-del]', function (i) {
        var f = shown[i];
        form({ title: 'Delete ' + f.name + '?', body: 'The link stops working everywhere it is used (emails already sent, the website…). This cannot be undone.', confirm: 'Delete file', danger: true }).then(function (v) {
          if (!v) return;
          api('/admin/media?path=' + encodeURIComponent(f.path), { method: 'DELETE' }).then(function () { toast('File deleted'); load(); }).catch(function (e) { toast(e.message, true); });
        });
      });
      $('#mf').onsubmit = function (e) { e.preventDefault(); location.hash = '#/media' + qs({ q: e.target.q.value.trim(), kind: kind }); };

      var input = $('#media-input'), drop = $('#drop'), prog = $('#up-prog');
      var send = function (files) {
        if (!files || !files.length) return;
        if (files.length > 10) { toast('Up to 10 files at a time', true); return; }
        var big = Array.prototype.filter.call(files, function (f) { return f.size > j.maxBytes; });
        if (big.length) { toast(big[0].name + ' is larger than ' + fmtBytes(j.maxBytes), true); return; }
        prog.hidden = false; prog.firstChild.style.width = '0%'; drop.classList.add('busy');
        uploadFiles(files, function (p) { prog.firstChild.style.width = Math.round(p * 100) + '%'; }).then(function (res) {
          toast(res.files.length === 1 ? 'Uploaded' : res.files.length + ' files uploaded');
          return load().then(function () {
            $('#just-up').innerHTML = '<div class="alert ok just-up"><b>Uploaded.</b> ' + res.files.map(function (f, k) { return '<div class="url-row"><span class="grow">' + esc(f.name) + '</span><input class="input sm" readonly value="' + esc(f.url) + '"><button class="btn sm primary" data-newcopy="' + k + '">Copy link</button></div>'; }).join('') + '</div>';
            bind('[data-newcopy]', function (k) { copyText(res.files[k].url, 'Link copied'); });
          });
        }).catch(function (e) { toast(e.message, true); }).then(function () { prog.hidden = true; drop.classList.remove('busy'); });
      };
      input.onchange = function () { send(input.files); input.value = ''; };
      drop.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } };
      ['dragenter', 'dragover'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
      ['dragleave', 'drop'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
      drop.addEventListener('drop', function (e) { send(e.dataTransfer && e.dataTransfer.files); });
    };
    var load = function () { return api('/admin/media').then(render).catch(fail); };
    load();
  };

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

  // ═════════ Mailing ═════════
  // Contacts, lists, templates, campaigns and automations. Rules (consent, suppression) live in services/mailing.ts.
  var ROLE_OPTS = [['tenant', 'Tenants'], ['landlord', 'Landlords'], ['estate_manager', 'Estate managers'], ['agent', 'Agents'], ['artisan', 'Artisans'], ['admin', 'Admins']];
  var MERGE_TAGS = [['{{first_name|there}}', 'First name'], ['{{full_name}}', 'Full name'], ['{{email}}', 'Email'], ['{{attributes.city}}', 'Custom field (city)'], ['{{preferences_url}}', 'Preferences link'], ['{{unsubscribe_url}}', 'Unsubscribe link'], ['{{app_url}}', 'Website link']];
  var BTN_STYLE = 'display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:9px;font-weight:600';
  var SNIPPETS = {
    heading: '<h1>Your headline</h1>\n', para: '<p>Write something here.</p>\n',
    button: '<p><a href="https://rentcreeb.com" style="' + BTN_STYLE + '">Call to action</a></p>\n',
    image: '<p><img src="https://" alt="" style="max-width:100%;border-radius:10px"></p>\n',
    divider: '<hr style="border:0;border-top:1px solid #e3e7f0;margin:22px 0">\n',
  };
  var STARTER = 'Hi {{first_name|there}},\n\nWrite your message here. Plain text works: blank lines become paragraphs, **bold** and [links](https://rentcreeb.com) are supported, or switch to HTML any time.\n\nThe RentCreeb team';
  function pct(n) { return (n || 0).toLocaleString('en-NG', { maximumFractionDigits: 1 }) + '%'; }
  function num(n) { return Number(n || 0).toLocaleString('en-NG'); }
  function mailNotReady(st) {
    if (!st) return '';
    var miss = [];
    if (!st.provider) miss.push('<b>RESEND_API_KEY</b> (the email provider key)');
    if (!st.publicUrl) miss.push('<b>API_PUBLIC_URL</b> (this server’s public address, used for unsubscribe links)');
    var warn = miss.length ? '<div class="alert bad" style="margin-bottom:14px">Emails can’t be sent yet. Add ' + miss.join(' and ') + ' to the server environment, then redeploy.</div>' : '';
    if (!miss.length && !st.webhook) warn += '<div class="alert info" style="margin-bottom:14px">Tip: add a Resend webhook pointing to <code>' + esc((st.publicUrl || '') + '/mail/webhooks/resend') + '</code> and set <b>RESEND_WEBHOOK_SECRET</b>, so bounces and spam complaints stop future sends automatically.</div>';
    return warn;
  }
  function mailMissing(e) { return e && (e.code === 'FEATURE_UNAVAILABLE' || /mailing_/.test(e.message || '')); }
  function mailFail(e) { view('<div class="err">' + esc(mailMissing(e) ? 'Run migration 018_support_chat_and_mailing.sql in Supabase to turn on the mailing list.' : e.message) + '</div>'); }

  // ── content + audience editors (shared by campaigns and automations) ──
  function contentEditor(d) {
    var tools = '<div class="row toolbar">' + [['heading', 'Heading'], ['para', 'Paragraph'], ['button', 'Button'], ['image', 'Image'], ['divider', 'Divider']].map(function (x) { return '<button type="button" class="btn sm" data-snip="' + x[0] + '">+ ' + x[1] + '</button>'; }).join('') +
      '<select class="input sm" id="ed-tag" aria-label="Insert personalisation"><option value="">Insert personalisation…</option>' + MERGE_TAGS.map(function (t) { return '<option value="' + esc(t[0]) + '">' + esc(t[1]) + '</option>'; }).join('') + '</select></div>';
    return '<div class="grid cols-2 tight"><label class="field"><span>Subject line</span><input class="input" id="ed-subject" maxlength="200" value="' + esc(d.subject || '') + '" placeholder="e.g. New homes in Lekki this week, {{first_name|there}}"></label>' +
      '<label class="field"><span>Preview text <span class="faint">(shown after the subject in the inbox)</span></span><input class="input" id="ed-preheader" maxlength="200" value="' + esc(d.preheader || '') + '"></label>' +
      '<label class="field"><span>Sender name</span><input class="input" id="ed-from" maxlength="80" value="' + esc(d.from_name || '') + '" placeholder="RentCreeb"></label>' +
      '<label class="field"><span>Reply-to email <span class="faint">(optional)</span></span><input class="input" id="ed-reply" type="email" value="' + esc(d.reply_to || '') + '" placeholder="hello@rentcreeb.com"></label></div>' +
      '<div class="editor"><div class="stack"><div class="row between"><b>Email body</b><span class="faint">Plain text or HTML</span></div>' + tools +
      '<textarea class="input code" id="ed-html" spellcheck="true">' + esc(d.html || STARTER) + '</textarea></div>' +
      '<div class="stack"><div class="row between"><b>Preview</b><span class="faint" id="ed-pstatus"></span></div><iframe id="ed-preview" class="preview" sandbox="" title="Email preview"></iframe><div class="faint" id="ed-psubject"></div></div></div>';
  }
  function readContent() {
    return { subject: $('#ed-subject').value.trim(), preheader: $('#ed-preheader').value.trim() || null, from_name: $('#ed-from').value.trim() || null, reply_to: $('#ed-reply').value.trim() || null, html: $('#ed-html').value };
  }
  function bindEditor(kindOf) {
    var ta = $('#ed-html'); var timer = null;
    var insert = function (txt) { var a = ta.selectionStart, b = ta.selectionEnd; ta.value = ta.value.slice(0, a) + txt + ta.value.slice(b); ta.focus(); ta.selectionStart = ta.selectionEnd = a + txt.length; refresh(); };
    bind('[data-snip]', function (k) { insert(SNIPPETS[k]); });
    $('#ed-tag').onchange = function (e) { if (e.target.value) insert(e.target.value); e.target.value = ''; };
    var refresh = function () {
      clearTimeout(timer); $('#ed-pstatus').textContent = 'updating…';
      timer = setTimeout(function () {
        post('/admin/mailing/preview', Object.assign(readContent(), { kind: kindOf() })).then(function (p) {
          var fr = $('#ed-preview'); if (!fr) return; fr.srcdoc = p.html; $('#ed-psubject').textContent = 'Subject: ' + p.subject; $('#ed-pstatus').textContent = 'sample person: Ada Okafor';
        }).catch(function (e) { var s = $('#ed-pstatus'); if (s) s.textContent = e.message; });
      }, 500);
    };
    ['#ed-html', '#ed-subject', '#ed-preheader'].forEach(function (s) { $(s).addEventListener('input', refresh); });
    refresh();
    return refresh;
  }
  function audienceEditor(a, lists) {
    a = a || {};
    var checks = function (name, opts, vals) { return '<div class="checks">' + opts.map(function (o) { return '<label class="check"><input type="checkbox" name="' + name + '" value="' + esc(o[0]) + '"' + ((vals || []).indexOf(o[0]) >= 0 ? ' checked' : '') + '><span>' + esc(o[1]) + '</span></label>'; }).join('') + '</div>'; };
    return '<div class="stack" id="aud">' +
      '<label class="field"><span>Who</span><select class="input" id="aud-source"><option value="all"' + (a.source === 'all' || !a.source ? ' selected' : '') + '>Everyone (app users and outside contacts)</option><option value="app_users"' + (a.source === 'app_users' ? ' selected' : '') + '>App users only</option><option value="contacts"' + (a.source === 'contacts' ? ' selected' : '') + '>Outside contacts only (not app users)</option></select></label>' +
      '<div class="field"><label class="check"><input type="checkbox" id="aud-wl"' + (a.waitlist ? ' checked' : '') + '><span><b>Only people on the waitlist</b> (everyone who joined on rentcreeb.com, including before the welcome email existed)</span></label>' +
        '<div id="aud-wl-st" style="margin-top:6px"' + (a.waitlist ? '' : ' hidden') + '><span class="faint">Waitlist status <span class="faint">(none ticked = all)</span></span>' + checks('aud-wls', WL_STATUS, a.waitlistStatuses) + '</div></div>' +
      (lists.length ? '<div class="field"><span>Only people on these lists <span class="faint">(none ticked = no list filter)</span></span>' + checks('aud-list', lists.map(function (l) { return [l.id, l.name + ' (' + l.members + ')']; }), a.listIds) + '</div>' : '') +
      '<div class="field"><span>App users with these roles <span class="faint">(none = any role)</span></span>' + checks('aud-role', ROLE_OPTS, a.roles) + '</div>' +
      '<div class="grid cols-2 tight"><label class="field"><span>ID verification</span><select class="input" id="aud-ver"><option value="any">Any</option><option value="verified"' + (a.verification === 'verified' ? ' selected' : '') + '>NIN-verified only</option><option value="unverified"' + (a.verification === 'unverified' ? ' selected' : '') + '>Not verified yet</option></select></label>' +
      '<label class="field"><span>Has any of these tags</span><input class="input" id="aud-tags" placeholder="e.g. lekki, investor" value="' + esc((a.tags || []).join(', ')) + '"></label>' +
      '<label class="field"><span>Leave out people tagged</span><input class="input" id="aud-xtags" placeholder="e.g. do-not-email" value="' + esc((a.excludeTags || []).join(', ')) + '"></label></div>' +
      '<div class="row"><button type="button" class="btn" id="aud-est-btn">Count recipients</button><span id="aud-est" class="faint"></span></div></div>';
  }
  document.addEventListener('change', function (e) { if (e.target && e.target.id === 'aud-wl') { var st = $('#aud-wl-st'); if (st) st.hidden = !e.target.checked; } });
  function splitTags(v) { return String(v || '').split(/[,;]/).map(function (t) { return t.trim().toLowerCase(); }).filter(Boolean); }
  function readAudience() {
    var vals = function (n) { return $$('input[name="' + n + '"]:checked').map(function (x) { return x.value; }); };
    var wl = $('#aud-wl').checked;
    return { source: $('#aud-source').value, listIds: vals('aud-list'), roles: vals('aud-role'), verification: $('#aud-ver').value, tags: splitTags($('#aud-tags').value), excludeTags: splitTags($('#aud-xtags').value),
      waitlist: wl, waitlistStatuses: wl ? vals('aud-wls') : [] };
  }
  function estimate(kind) {
    var el = $('#aud-est'); el.textContent = 'Counting…';
    return post('/admin/mailing/estimate', { audience: readAudience(), kind: kind }).then(function (e) {
      var ex = Object.keys(e.excluded || {}).map(function (k) { return num(e.excluded[k]) + ' ' + k; }).join(', ');
      el.innerHTML = '<b>' + num(e.recipients) + ' will receive it</b>' + (e.matched !== e.recipients ? ' · ' + num(e.matched - e.recipients) + ' matched but left out' + (ex ? ' (' + esc(ex) + ')' : '') : '');
      return e;
    }).catch(function (err) { el.textContent = err.message; throw err; });
  }

  // ── overview ──
  PAGES.mailing = function () {
    shell('mailing', 'Mailing list', 'Newsletters, announcements and automated emails to app users and outside contacts.',
      '<a class="btn primary" href="#/mail-campaigns/new">New campaign</a>');
    api('/admin/mailing/overview').then(function (o) {
      if (!o.available) return view(mailNotReady(o.status) + '<div class="err">Run migration 018_support_chat_and_mailing.sql in Supabase to turn on the mailing list.</div>');
      var c = o.contacts;
      var card = function (n, l, href) { return '<a class="card stat" href="' + href + '"><span class="n">' + n + '</span><span class="l">' + esc(l) + '</span></a>'; };
      view(mailNotReady(o.status) + '<div class="grid cols-4">' +
        card(num(c.subscribed), 'Subscribed contacts', '#/mail-contacts?status=subscribed') + card(num(c.appUsers), 'App users synced', '#/mail-contacts?source=app_users') +
        card(num(c.marketingConsent), 'App users allowing marketing', '#/mail-contacts?source=app_users') + card(num(c.unsubscribed), 'Unsubscribed', '#/mail-contacts?status=unsubscribed') +
        card(num(c.bounced + c.complained), 'Bounced or spam complaints', '#/mail-contacts?status=bounced') + card(num(c.pending), 'Waiting to confirm', '#/mail-contacts?status=pending') +
        card(num(o.sent30), 'Emails sent, last 30 days', '#/mail-campaigns') + card(num(o.activeAutomations), 'Automations running', '#/mail-automations') + '</div>' +
        '<div class="grid cols-2" style="margin-top:14px">' + section('New contacts, last 30 days', chart(o.trends.newContacts)) + section('Opens, last 30 days', chart(o.trends.opens)) + '</div>' +
        '<h2 class="section-title">Recent campaigns <a class="btn sm" href="#/mail-campaigns">All campaigns →</a></h2><div class="card">' +
        table(['Campaign', 'Type', 'Status', 'Recipients', 'When'], o.recentCampaigns, function (x) {
          return '<tr class="click" data-go="#/mail-campaigns/' + esc(x.id) + '"><td>' + esc(x.name) + '</td><td>' + label(x.kind) + '</td><td>' + statusBadge(x.status) + '</td><td class="num">' + num(x.recipients) + '</td><td class="num">' + when(x.finished_at || x.started_at || x.scheduled_at) + '</td></tr>';
        }, 'No campaigns yet. Start with “New campaign”.') + '</div>' +
        '<div class="card stack" style="margin-top:14px"><h3>How consent works</h3><p class="muted" style="margin:0"><b>Marketing</b> emails go only to subscribed contacts, and app users must also have <i>Privacy → Marketing</i> switched on in the app (it is off by default). Every marketing email carries an unsubscribe link and a one-click unsubscribe header. ' +
        '<b>Service</b> emails (account news, policy changes) go to every app user with an account, even if they unsubscribed from marketing. Bounced addresses and spam complaints are never emailed again.</p></div>');
      bindGo();
    }).catch(mailFail);
  };

  // ── campaigns ──
  PAGES['mail-campaigns'] = function (r) {
    if (r.path[1] === 'new') {
      shell('mail-campaigns', 'New campaign', '');
      if (r.q.for === 'waitlist') return api('/admin/mailing/templates').then(function (t) {
        var tpl = (t.templates || []).filter(function (x) { return x.name === 'Waitlist update'; })[0] || {};
        return post('/admin/mailing/campaigns', { name: 'Waitlist update ' + day(new Date().toISOString()), subject: tpl.subject || '', preheader: tpl.preheader || null, html: tpl.html || STARTER, audience: { waitlist: true } });
      }).then(function (j) { location.replace('#/mail-campaigns/' + j.campaign.id); }).catch(mailFail);
      return post('/admin/mailing/campaigns', { name: 'Untitled campaign ' + day(new Date().toISOString()), html: STARTER }).then(function (j) { location.replace('#/mail-campaigns/' + j.campaign.id); }).catch(mailFail);
    }
    if (r.path[1]) return campaignPage(r.path[1]);
    var tab = r.q.tab || 'all'; var page = Number(r.q.page || 1);
    shell('mail-campaigns', 'Campaigns', 'One-off emails: newsletters, offers, announcements.', '<a class="btn primary" href="#/mail-campaigns/new">New campaign</a>');
    api('/admin/mailing/campaigns' + qs({ status: tab === 'all' ? '' : tab, page: page, limit: PAGE })).then(function (j) {
      view(tabs([['all', 'All'], ['draft', 'Drafts'], ['scheduled', 'Scheduled'], ['sending', 'Sending'], ['sent', 'Sent'], ['paused', 'Paused'], ['cancelled', 'Cancelled']], tab, function (t) { return '/mail-campaigns' + qs({ tab: t }); }) +
        '<div class="card">' + table(['Campaign', 'Type', 'Status', 'Recipients', 'Opened', 'Clicked', 'When'], j.campaigns, function (x) {
          var s = x.stats;
          return '<tr class="click" data-go="#/mail-campaigns/' + esc(x.id) + '"><td><b>' + esc(x.name) + '</b><div class="faint">' + esc(x.subject || 'No subject yet') + '</div></td><td>' + label(x.kind) + '</td><td>' + statusBadge(x.status) + '</td>' +
            '<td class="num">' + (x.recipients ? num(x.recipients) : '—') + '</td><td class="num">' + (s ? pct(s.openRate) : '—') + '</td><td class="num">' + (s ? pct(s.clickRate) : '—') + '</td>' +
            '<td class="num">' + (x.status === 'scheduled' ? 'for ' + when(x.scheduled_at) : when(x.finished_at || x.started_at || x.updated_at)) + '</td></tr>';
        }, 'No campaigns here.') + '</div>' + pager(page, j.total, r.raw));
      bindGo();
    }).catch(mailFail);
  };

  function campaignPage(id) {
    shell('mail-campaigns', 'Campaign', '');
    Promise.all([api('/admin/mailing/campaigns/' + id), api('/admin/mailing/lists'), api('/admin/mailing/templates'), api('/admin/mailing/overview')]).then(function (res) {
      var c = res[0].campaign;
      if (c.status === 'draft' || c.status === 'scheduled') return campaignEditor(c, res[1].lists, res[2].templates, res[3].status);
      campaignReport(id, res[0]);
    }).catch(mailFail);
  }

  function campaignEditor(c, lists, templates, status) {
    shell('mail-campaigns', c.status === 'scheduled' ? 'Scheduled campaign' : 'Edit campaign', c.status === 'scheduled' ? 'Goes out ' + when(c.scheduled_at) + '. Unschedule it to make changes.' : 'Changes are saved when you press Save, test or send.');
    var locked = c.status === 'scheduled';
    view(mailNotReady(status) + '<div class="row" style="margin-bottom:12px"><a class="btn sm" href="#/mail-campaigns">← Campaigns</a>' +
      (templates.length ? '<select class="input sm" id="tpl-load"><option value="">Start from a template…</option>' + templates.map(function (t) { return '<option value="' + esc(t.id) + '">' + esc(t.name) + '</option>'; }).join('') + '</select>' : '') +
      '<button class="btn sm" id="tpl-save">Save as template</button><button class="btn sm" id="c-dup">Duplicate</button><button class="btn sm ghost-danger" id="c-del">Delete</button></div>' +
      '<fieldset class="stack plain"' + (locked ? ' disabled' : '') + '>' +
      '<div class="card stack"><div class="grid cols-2 tight"><label class="field"><span>Campaign name <span class="faint">(only you see this)</span></span><input class="input" id="c-name" maxlength="120" value="' + esc(c.name) + '"></label>' +
      '<label class="field"><span>Type</span><select class="input" id="c-kind"><option value="marketing"' + (c.kind === 'marketing' ? ' selected' : '') + '>Marketing: offers, newsletters (needs consent, has unsubscribe link)</option><option value="service"' + (c.kind === 'service' ? ' selected' : '') + '>Service: important account news (all app users)</option></select></label></div>' +
      '<label class="check"><input type="checkbox" id="c-track"' + (c.track !== false ? ' checked' : '') + '><span>Track opens and link clicks</span></label></div>' +
      section('Audience', audienceEditor(c.audience, lists)) + section('Content', contentEditor(c)) + '</fieldset>' +
      '<div class="card row between sticky-bar"><span class="faint" id="c-saved"></span><div class="row">' +
      (locked ? '<button class="btn" id="c-unsched">Unschedule</button><button class="btn danger" id="c-cancel">Cancel campaign</button>'
        : '<button class="btn" id="c-save">Save draft</button><button class="btn" id="c-test">Send test</button><button class="btn" id="c-sched">Schedule…</button><button class="btn primary" id="c-send">Send now…</button>') + '</div></div>');
    var kindOf = function () { return $('#c-kind').value; };
    var refresh = bindEditor(kindOf);
    $('#c-kind').onchange = refresh;
    var body = function () { return Object.assign({ name: $('#c-name').value.trim() || 'Untitled campaign', kind: kindOf(), track: $('#c-track').checked, audience: readAudience() }, readContent()); };
    var save = function (quiet) { return api('/admin/mailing/campaigns/' + c.id, { method: 'PATCH', body: body() }).then(function () { $('#c-saved').textContent = 'Saved ' + new Date().toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' }); if (!quiet) toast('Draft saved'); }).catch(function (e) { toast(e.message, true); throw e; }); };
    on('aud-est-btn', function () { estimate(kindOf()).catch(function () {}); });
    on('c-save', function () { save(); });
    on('c-test', function () {
      form({ title: 'Send a test', body: 'Personalisation uses the contact with that email if there is one, or a sample person. Test emails are not tracked.', fields: [{ name: 'to', label: 'Send to (up to 5, comma separated)', value: me.email || '', required: true }], confirm: 'Send test' }).then(function (v) {
        if (!v) return;
        save(true).then(function () { return post('/admin/mailing/test', Object.assign(readContent(), { kind: kindOf(), to: splitTags(v.to).slice(0, 5) })); }).then(function () { toast('Test sent'); }).catch(function (e) { toast(e.message, true); });
      });
    });
    on('c-send', function () {
      save(true).then(function () { return estimate(kindOf()); }).then(function (e) {
        if (!e.recipients) { toast('Nobody in this audience can receive it', true); return; }
        return form({ title: 'Send to ' + num(e.recipients) + ' people now?', body: 'Subject: “' + $('#ed-subject').value + '”. Emails go out at about ' + num(status && status.ratePerMinute) + ' per minute. You can pause or cancel while it sends.', confirm: 'Send now' }).then(function (v) {
          if (v) return post('/admin/mailing/campaigns/' + c.id + '/send').then(function (r) { toast('Sending to ' + num(r.recipients) + ' people'); route(); });
        });
      }).catch(function (e) { toast(e.message, true); });
    });
    on('c-sched', function () {
      var soon = new Date(Date.now() + 3600e3); soon.setMinutes(0, 0, 0);
      var local = new Date(soon.getTime() - soon.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      form({ title: 'Schedule campaign', body: 'Who receives it is worked out at send time, so new subscribers by then are included.', fields: [{ name: 'at', label: 'Send at (your local time)', type: 'datetime-local', value: local, required: true }], confirm: 'Schedule' }).then(function (v) {
        if (!v) return;
        save(true).then(function () { return post('/admin/mailing/campaigns/' + c.id + '/send', { scheduledAt: new Date(v.at).toISOString() }); }).then(function () { toast('Scheduled for ' + when(new Date(v.at).toISOString())); route(); }).catch(function (e) { toast(e.message, true); });
      });
    });
    on('c-unsched', function () { act(post('/admin/mailing/campaigns/' + c.id + '/unschedule'), 'Back to draft'); });
    on('c-cancel', function () { form({ title: 'Cancel this campaign?', body: 'It will not be sent. You can duplicate it later.', confirm: 'Cancel campaign', danger: true }).then(function (v) { if (v) act(post('/admin/mailing/campaigns/' + c.id + '/cancel'), 'Cancelled'); }); });
    on('c-dup', function () { post('/admin/mailing/campaigns/' + c.id + '/duplicate').then(function (j) { toast('Copy created'); location.hash = '#/mail-campaigns/' + j.campaign.id; }).catch(function (e) { toast(e.message, true); }); });
    on('c-del', function () { form({ title: 'Delete this draft?', confirm: 'Delete', danger: true }).then(function (v) { if (v) api('/admin/mailing/campaigns/' + c.id, { method: 'DELETE' }).then(function () { toast('Deleted'); location.hash = '#/mail-campaigns'; }).catch(function (e) { toast(e.message, true); }); }); });
    on('tpl-save', function () {
      form({ title: 'Save as template', fields: [{ name: 'name', label: 'Template name', value: $('#c-name').value, required: true }], confirm: 'Save template' }).then(function (v) {
        if (v) post('/admin/mailing/templates', Object.assign(readContent(), { name: v.name })).then(function () { toast('Template saved'); }).catch(function (e) { toast(e.message, true); });
      });
    });
    var tl = $('#tpl-load'); if (tl) tl.onchange = function () {
      var t = templates.filter(function (x) { return x.id === tl.value; })[0]; tl.value = ''; if (!t) return;
      form({ title: 'Replace the content with “' + t.name + '”?', body: 'The subject, preview text and body are replaced.', confirm: 'Use template' }).then(function (v) {
        if (!v) return; $('#ed-subject').value = t.subject || ''; $('#ed-preheader').value = t.preheader || ''; $('#ed-html').value = t.html || ''; refresh();
      });
    };
  }

  function campaignReport(id, j) {
    var c = j.campaign; var s = j.stats || {};
    shell('mail-campaigns', c.name, label(c.kind) + ' campaign · ' + (c.finished_at ? 'finished ' + when(c.finished_at) : 'started ' + when(c.started_at)));
    var stat = function (n, l, sub) { return '<div class="card stat"><span class="n">' + n + '</span><span class="l">' + esc(l) + (sub ? ' · ' + sub : '') + '</span></div>'; };
    var done = s.total ? Math.round(((s.total - s.queued) / s.total) * 100) : 100;
    var eng = '';
    var tab = 'all';
    var render = function () {
      view('<div class="row" style="margin-bottom:12px"><a class="btn sm" href="#/mail-campaigns">← Campaigns</a>' + statusBadge(c.status) +
        (c.status === 'sending' ? '<button class="btn sm" id="r-pause">Pause</button>' : '') + (c.status === 'paused' ? '<button class="btn sm primary" id="r-resume">Resume</button>' : '') +
        (c.status === 'sending' || c.status === 'paused' ? '<button class="btn sm ghost-danger" id="r-cancel">Cancel the rest</button>' : '') +
        '<button class="btn sm" id="r-dup">Duplicate</button><button class="btn sm" id="r-view">View email</button><button class="btn sm" id="r-csv">Export recipients</button></div>' +
        (c.status === 'sending' || c.status === 'paused' ? '<div class="card stack" style="margin-bottom:14px"><div class="row between"><b>' + (c.status === 'paused' ? 'Paused' : 'Sending…') + '</b><span class="faint">' + num(s.total - s.queued) + ' of ' + num(s.total) + '</span></div><div class="progress"><span style="width:' + done + '%"></span></div></div>' : '') +
        '<div class="grid cols-4">' + stat(num(s.sent), 'Sent', s.delivered ? num(s.delivered) + ' confirmed delivered' : '') + stat(pct(s.openRate), 'Opened', num(s.opened) + ' people') + stat(pct(s.clickRate), 'Clicked', num(s.clicked) + ' people') +
        stat(pct(s.unsubscribeRate), 'Unsubscribed', num(s.unsubscribed)) + stat(num(s.bounced), 'Bounced', pct(s.bounceRate)) + stat(num(s.complained), 'Spam complaints') + stat(num(s.failed), 'Failed') + stat(num(s.skipped), 'Skipped', 'unsubscribed before send') + '</div>' +
        '<div class="grid cols-2" style="margin-top:14px">' + section('Most clicked links', table(['Link', 'Clicks', 'People'], j.links, function (l) { return '<tr><td class="clamp"><a href="' + safeUrl(l.url) + '" target="_blank" rel="noopener">' + esc(l.url) + '</a></td><td class="num">' + num(l.clicks) + '</td><td class="num">' + num(l.people) + '</td></tr>'; }, 'No clicks yet.')) +
        section('Details', kv([['Subject', esc(c.subject)], ['Preview text', esc(c.preheader || '')], ['Sender', esc(c.from_name || 'RentCreeb')], ['Reply-to', esc(c.reply_to || '')], ['Created by', c.creator ? name(c.creator) : ''], ['Tracking', c.track !== false ? 'On' : 'Off']])) + '</div>' +
        '<h2 class="section-title">Recipients</h2>' + tabs([['all', 'All'], ['opened', 'Opened'], ['not_opened', 'Not opened'], ['clicked', 'Clicked'], ['unsubscribed', 'Unsubscribed'], ['bounced', 'Bounced'], ['failed', 'Failed']], tab, function (t) { return '/mail-campaigns/' + id + '?r=' + t; }) + '<div id="rcpts"><div class="spinner">Loading…</div></div>');
      $$('.tabs .tab').forEach(function (a) { a.onclick = function (e) { e.preventDefault(); tab = a.getAttribute('href').split('r=')[1]; render(); }; });
      var p = { page: 1, limit: 50 };
      if (['opened', 'not_opened', 'clicked', 'unsubscribed'].indexOf(tab) >= 0) p.engaged = tab; else if (tab !== 'all') p.status = tab;
      api('/admin/mailing/campaigns/' + id + '/recipients' + qs(p)).then(function (rj) {
        var el = $('#rcpts'); if (!el) return;
        el.innerHTML = '<div class="card">' + table(['Email', 'Status', 'Sent', 'Opened', 'Clicked'], rj.recipients, function (x) {
          return '<tr class="click" data-go="#/mail-contacts/' + esc(x.contact_id) + '"><td>' + esc(x.email) + (x.error ? '<div class="faint">' + esc(x.error) + '</div>' : '') + '</td><td>' + statusBadge(x.unsubscribed_at ? 'unsubscribed' : x.status) + '</td><td class="num">' + when(x.sent_at) + '</td>' +
            '<td class="num">' + (x.opened_at ? when(x.opened_at) + (x.open_count > 1 ? ' (' + x.open_count + '×)' : '') : '—') + '</td><td class="num">' + (x.clicked_at ? x.click_count + ' click' + (x.click_count > 1 ? 's' : '') : '—') + '</td></tr>';
        }, 'Nobody here.') + (rj.total > 50 ? '<div class="faint" style="padding-top:8px">Showing 50 of ' + num(rj.total) + '. Export for the full list.</div>' : '') + '</div>';
        bindGo();
      }).catch(function (e) { var el = $('#rcpts'); if (el) el.innerHTML = '<div class="err">' + esc(e.message) + '</div>'; });
      var step = function (a, msg) { return function () { act(post('/admin/mailing/campaigns/' + id + '/' + a), msg); }; };
      on('r-pause', step('pause', 'Paused')); on('r-resume', step('resume', 'Resumed'));
      on('r-cancel', function () { form({ title: 'Cancel the rest?', body: 'People who already got it keep it; nobody else will.', confirm: 'Cancel the rest', danger: true }).then(function (v) { if (v) step('cancel', 'Cancelled')(); }); });
      on('r-dup', function () { post('/admin/mailing/campaigns/' + id + '/duplicate').then(function (d) { toast('Copy created'); location.hash = '#/mail-campaigns/' + d.campaign.id; }).catch(function (e) { toast(e.message, true); }); });
      on('r-csv', function () { download('/admin/mailing/campaigns/' + id + '/recipients.csv', 'campaign-recipients.csv'); });
      on('r-view', function () {
        post('/admin/mailing/preview', { kind: c.kind, subject: c.subject, preheader: c.preheader, html: c.html, from_name: c.from_name }).then(function (p) {
          form({ title: p.subject, html: '<iframe class="preview tall" sandbox="" title="Email" id="v-frame"></iframe>', wide: true, confirm: false });
          $('#v-frame').srcdoc = p.html;
        }).catch(function (e) { toast(e.message, true); });
      });
    };
    render();
    if (c.status === 'sending') pageTimer = setInterval(function () {
      if (document.visibilityState !== 'visible' || $('#modal-root').innerHTML) return;
      api('/admin/mailing/campaigns/' + id).then(function (n) { j = n; c = n.campaign; s = n.stats || {}; done = s.total ? Math.round(((s.total - s.queued) / s.total) * 100) : 100; render(); if (c.status !== 'sending') stopPage(); }).catch(function () {});
    }, 8000);
  }

  // ── contacts ──
  PAGES['mail-contacts'] = function (r) {
    if (r.path[1]) return contactPage(r.path[1]);
    var page = Number(r.q.page || 1);
    shell('mail-contacts', 'Contacts', 'Everyone you can email. App users are added automatically.',
      '<button class="btn" id="mc-sync">Sync app users</button><button class="btn" id="mc-export">Export CSV</button><button class="btn" id="mc-import">Import CSV</button><button class="btn primary" id="mc-add">Add contact</button>');
    Promise.all([api('/admin/mailing/contacts' + qs({ q: r.q.q, status: r.q.status, source: r.q.source, listId: r.q.listId, tag: r.q.tag, page: page, limit: PAGE })), api('/admin/mailing/lists')]).then(function (res) {
      var j = res[0]; var lists = res[1].lists; var listName = {}; lists.forEach(function (l) { listName[l.id] = l.name; });
      var sel = function (nm, opts, cur) { return '<select class="input" name="' + nm + '">' + opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(cur || '') === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>'; };
      view('<form class="row" id="mcf" style="margin-bottom:12px"><input class="input" name="q" placeholder="Search email or name" value="' + esc(r.q.q || '') + '">' +
        sel('status', [['', 'Any status'], ['subscribed', 'Subscribed'], ['unsubscribed', 'Unsubscribed'], ['pending', 'Waiting to confirm'], ['bounced', 'Bounced'], ['complained', 'Spam complaint']], r.q.status) +
        sel('source', [['', 'Any source'], ['app_users', 'App users'], ['manual', 'Added by hand'], ['import', 'Imported'], ['signup_form', 'Sign-up form']], r.q.source) +
        sel('listId', [['', 'Any list']].concat(lists.map(function (l) { return [l.id, l.name]; })), r.q.listId) +
        '<input class="input" name="tag" placeholder="Tag" value="' + esc(r.q.tag || '') + '" style="max-width:130px"><button class="btn">Filter</button></form>' +
        '<div class="card"><div class="row bulk" id="bulk" hidden><b id="bulk-n"></b><select class="input sm" id="bulk-act"><option value="">Do with selected…</option><option value="add_to_list">Add to list</option><option value="remove_from_list">Remove from list</option><option value="add_tag">Add tag</option><option value="remove_tag">Remove tag</option><option value="unsubscribe">Unsubscribe</option><option value="resubscribe">Resubscribe</option><option value="delete">Delete permanently</option></select></div>' +
        table(['<input type="checkbox" id="ck-all" aria-label="Select all">', 'Contact', 'Status', 'Lists', 'Tags', 'Added'], j.contacts, function (x) {
          var mem = (x.members || []).filter(function (m) { return m.status === 'subscribed'; }).map(function (m) { return esc(listName[m.list_id] || ''); }).filter(Boolean).join(', ');
          return '<tr><td><input type="checkbox" class="ck" value="' + esc(x.id) + '" aria-label="Select"></td><td class="click" data-go="#/mail-contacts/' + esc(x.id) + '"><b>' + esc(x.email) + '</b><div class="faint">' + esc([x.first_name, x.last_name].filter(Boolean).join(' ')) + (x.user_id ? ' ' + badge('app user', 'grey') : '') + '</div></td>' +
            '<td>' + statusBadge(x.status) + '</td><td class="faint">' + (mem || '—') + '</td><td>' + (x.tags || []).map(function (t) { return badge(t, 'grey'); }).join(' ') + '</td><td class="num">' + day(x.created_at) + '</td></tr>';
        }, 'No contacts match. Use “Sync app users” to add everyone with an account.').replace('<th>&lt;input type=&quot;checkbox&quot; id=&quot;ck-all&quot; aria-label=&quot;Select all&quot;&gt;</th>', '<th><input type="checkbox" id="ck-all" aria-label="Select all"></th>') + '</div>' + pager(page, j.total, r.raw));
      bindGo();
      $('#mcf').onsubmit = function (e) { e.preventDefault(); var x = e.target; location.hash = '#/mail-contacts' + qs({ q: x.q.value.trim(), status: x.status.value, source: x.source.value, listId: x.listId.value, tag: x.tag.value.trim() }); };
      var picked = function () { return $$('.ck:checked').map(function (x) { return x.value; }); };
      var upd = function () { var n = picked().length; $('#bulk').hidden = !n; $('#bulk-n').textContent = n + ' selected'; };
      $$('.ck').forEach(function (x) { x.onchange = upd; });
      var all = $('#ck-all'); if (all) all.onchange = function () { $$('.ck').forEach(function (x) { x.checked = all.checked; }); upd(); };
      $('#bulk-act').onchange = function (e) {
        var a = e.target.value; e.target.value = ''; if (!a) return; var ids = picked();
        var fields = a === 'add_to_list' || a === 'remove_from_list' ? [{ name: 'listId', label: 'List', type: 'select', options: lists.map(function (l) { return [l.id, l.name]; }), required: true }] : a === 'add_tag' || a === 'remove_tag' ? [{ name: 'tag', label: 'Tag', required: true }] : [];
        if (fields.length && fields[0].options && !lists.length) { toast('Create a list first', true); return; }
        form({ title: label(a) + ' (' + ids.length + ')', body: a === 'delete' ? 'Contacts and their email history are erased. App users come back on the next sync.' : '', fields: fields, confirm: 'Apply', danger: a === 'delete' || a === 'unsubscribe' }).then(function (v) {
          if (v) act(post('/admin/mailing/contacts/bulk', Object.assign({ ids: ids, action: a }, v)), 'Done');
        });
      };
      on('mc-sync', function () { post('/admin/mailing/sync-users').then(function (o) { toast(num(o.added) + ' added, ' + num(o.linked) + ' linked (' + num(o.users) + ' app users)'); route(); }).catch(function (e) { toast(e.message, true); }); });
      on('mc-export', function () { download('/admin/mailing/contacts.csv' + qs({ status: r.q.status }), 'contacts.csv'); });
      on('mc-add', function () {
        form({ title: 'Add contact', body: 'Only add people who agreed to hear from RentCreeb.', fields: [{ name: 'email', label: 'Email', type: 'email', required: true }, { name: 'first_name', label: 'First name' }, { name: 'last_name', label: 'Last name' },
          { name: 'tags', label: 'Tags (comma separated)' }].concat(lists.length ? [{ name: 'listIds', label: 'Add to lists', type: 'checks', options: lists.map(function (l) { return [l.id, l.name]; }) }] : []), confirm: 'Add' })
          .then(function (v) { if (v) act(post('/admin/mailing/contacts', v), 'Contact added'); });
      });
      on('mc-import', function () { importDialog(lists); });
    }).catch(mailFail);
  };

  function importDialog(lists) {
    var text = null;
    form({ title: 'Import contacts from CSV', wide: true,
      html: '<p class="muted" style="margin:0">First row must be headers with an <b>email</b> column. Optional: <b>first_name</b>, <b>last_name</b>, <b>tags</b> (separate with ;). Any other column becomes a custom field you can use as <code>{{attributes.column_name}}</code>. Duplicates are merged; unsubscribed, bounced and spam-complaint contacts stay that way.</p>' +
        '<label class="field"><span>CSV file</span><input class="input" type="file" id="imp-file" accept=".csv,text/csv,.txt"></label><div class="faint" id="imp-info"></div>',
      fields: (lists.length ? [{ name: 'listId', label: 'Add everyone to list', type: 'select', options: [['', 'No list']].concat(lists.map(function (l) { return [l.id, l.name]; })) }] : []).concat([
        { name: 'tags', label: 'Tag everyone with (optional)', placeholder: 'e.g. expo-2026' },
        { name: 'status', label: 'Status', type: 'select', options: [['subscribed', 'Subscribed (they already opted in)'], ['pending', 'Needs to confirm (send nothing until they do)']] },
        { name: 'updateExisting', label: 'Update names, tags and fields of existing contacts', type: 'checkbox', value: true },
        { name: 'consent', label: 'I confirm these people agreed to receive emails from RentCreeb', type: 'checkbox' }]), confirm: 'Import' }).then(function (v) {
      if (!v) return;
      if (!text) { toast('Choose a CSV file', true); return; }
      if (!v.consent) { toast('Please confirm consent', true); return; }
      post('/admin/mailing/contacts/import', { csv: text, listId: v.listId || undefined, tags: v.tags, status: v.status, updateExisting: !!v.updateExisting, consent: true }).then(function (o) {
        form({ title: 'Import finished', html: kv([['Added', num(o.added)], ['Updated', num(o.updated)], ['Left as they were', num(o.skipped)], ['Invalid emails', num(o.invalid) + (o.invalidSample.length ? '<div class="faint">' + esc(o.invalidSample.join(', ')) + '</div>' : '')]]), confirm: false }).then(route);
      }).catch(function (e) { toast(e.message, true); });
    });
    setTimeout(function () {
      var f = $('#imp-file'); if (!f) return;
      f.onchange = function () {
        var file = f.files && f.files[0]; if (!file) return;
        if (file.size > 5e6) { toast('File is larger than 5 MB: split it into parts', true); f.value = ''; return; }
        var rd = new FileReader(); rd.onload = function () { text = String(rd.result || ''); var lines = text.split(/\r?\n/).filter(Boolean).length; $('#imp-info').textContent = file.name + ' · about ' + num(Math.max(0, lines - 1)) + ' rows'; }; rd.readAsText(file);
      };
    }, 30);
  }

  function contactPage(id) {
    shell('mail-contacts', 'Contact', '');
    Promise.all([api('/admin/mailing/contacts/' + id), api('/admin/mailing/lists')]).then(function (res) {
      var j = res[0]; var c = j.contact; var lists = res[1].lists;
      var on1 = (c.members || []).filter(function (m) { return m.status === 'subscribed'; });
      shell('mail-contacts', c.email, [c.first_name, c.last_name].filter(Boolean).join(' '));
      var consent = j.profile ? (j.profile.privacy_prefs && j.profile.privacy_prefs.marketing === true ? badge('allows marketing', 'ok') : badge('marketing off in app', 'grey')) : '';
      view('<div class="row" style="margin-bottom:12px"><a class="btn sm" href="#/mail-contacts">← Contacts</a><button class="btn sm" id="ct-edit">Edit</button>' +
        (c.status === 'subscribed' ? '<button class="btn sm ghost-danger" id="ct-unsub">Unsubscribe</button>' : c.status === 'unsubscribed' || c.status === 'pending' ? '<button class="btn sm" id="ct-resub">Resubscribe</button>' : '') +
        '<button class="btn sm ghost-danger" id="ct-del">Delete permanently</button></div><div class="grid cols-2">' +
        section('Details', kv([['Status', statusBadge(c.status) + ' ' + consent], ['App account', j.profile ? userLink(j.profile) + ' · ' + label(j.profile.role) : 'No'], ['Source', label(c.source)], ['Tags', (c.tags || []).map(function (t) { return badge(t, 'grey'); }).join(' ')],
          ['Lists', on1.map(function (m) { return esc(m.list && m.list.name); }).join(', ')], ['Custom fields', Object.keys(c.attributes || {}).map(function (k) { return esc(k) + ': ' + esc(c.attributes[k]); }).join('<br>')],
          ['Added', when(c.created_at)], ['Confirmed', c.confirmed_at ? when(c.confirmed_at) : ''], ['Unsubscribed', c.unsubscribed_at ? when(c.unsubscribed_at) + (c.unsubscribe_reason ? ' · ' + esc(c.unsubscribe_reason) : '') : ''],
          ['Last opened', c.last_opened_at ? when(c.last_opened_at) : ''], ['Last clicked', c.last_clicked_at ? when(c.last_clicked_at) : '']])) +
        section('Email history', table(['Email', 'Status', 'Sent', 'Opened', 'Clicked'], j.sends, function (s) {
          var src = s.campaign ? '<a href="#/mail-campaigns/' + esc(s.campaign.id) + '">' + esc(s.campaign.name) + '</a>' : s.automation ? '<a href="#/mail-automations/' + esc(s.automation.id) + '">' + esc(s.automation.name) + '</a> ' + badge('automation', 'grey') : '—';
          return '<tr><td>' + src + (s.error ? '<div class="faint">' + esc(s.error) + '</div>' : '') + '</td><td>' + statusBadge(s.status) + '</td><td class="num">' + when(s.sent_at) + '</td><td class="num">' + (s.opened_at ? ago(s.opened_at) : '—') + '</td><td class="num">' + (s.clicked_at ? ago(s.clicked_at) : '—') + '</td></tr>';
        }, 'Nothing sent yet.')) + '</div>');
      on('ct-edit', function () {
        form({ title: 'Edit contact', fields: [{ name: 'first_name', label: 'First name', value: c.first_name }, { name: 'last_name', label: 'Last name', value: c.last_name }, { name: 'tags', label: 'Tags (comma separated)', value: (c.tags || []).join(', ') },
          { name: 'attrs', label: 'Custom fields (one per line: name = value)', type: 'textarea', value: Object.keys(c.attributes || {}).map(function (k) { return k + ' = ' + c.attributes[k]; }).join('\n') }].concat(lists.length ? [{ name: 'lists', label: 'Lists', type: 'checks', options: lists.map(function (l) { return [l.id, l.name]; }), value: on1.map(function (m) { return m.list_id; }) }] : []), confirm: 'Save' })
          .then(function (v) {
            if (!v) return;
            var attributes = {}; String(v.attrs || '').split('\n').forEach(function (ln) { var i = ln.indexOf('='); if (i > 0) { var k = ln.slice(0, i).trim().toLowerCase().replace(/\s+/g, '_'); if (k) attributes[k] = ln.slice(i + 1).trim(); } });
            var was = on1.map(function (m) { return m.list_id; }); var now = v.lists || was;
            var jobs = [api('/admin/mailing/contacts/' + id, { method: 'PATCH', body: { first_name: v.first_name || null, last_name: v.last_name || null, tags: v.tags || '', attributes: attributes } })];
            now.filter(function (x) { return was.indexOf(x) < 0; }).forEach(function (l) { jobs.push(post('/admin/mailing/contacts/bulk', { ids: [id], action: 'add_to_list', listId: l })); });
            was.filter(function (x) { return now.indexOf(x) < 0; }).forEach(function (l) { jobs.push(post('/admin/mailing/contacts/bulk', { ids: [id], action: 'remove_from_list', listId: l })); });
            act(Promise.all(jobs), 'Saved');
          });
      });
      on('ct-unsub', function () { act(api('/admin/mailing/contacts/' + id, { method: 'PATCH', body: { status: 'unsubscribed' } }), 'Unsubscribed'); });
      on('ct-resub', function () { form({ title: 'Resubscribe?', body: 'Only do this if they asked to be subscribed again.', confirm: 'Resubscribe' }).then(function (v) { if (v) act(api('/admin/mailing/contacts/' + id, { method: 'PATCH', body: { status: 'subscribed' } }), 'Subscribed'); }); });
      on('ct-del', function () { form({ title: 'Delete ' + c.email + '?', body: 'Erases the contact and their email history (for data-deletion requests).', confirm: 'Delete', danger: true }).then(function (v) { if (v) api('/admin/mailing/contacts/' + id, { method: 'DELETE' }).then(function () { toast('Deleted'); location.hash = '#/mail-contacts'; }).catch(function (e) { toast(e.message, true); }); }); });
    }).catch(mailFail);
  }

  // ── lists & sign-up form ──
  PAGES['mail-lists'] = function () {
    shell('mail-lists', 'Lists & sign-up form', 'Group contacts, and let people join from your website.', '<button class="btn primary" id="ml-add">New list</button>');
    var listForm = function (l) {
      l = l || {};
      return form({ title: l.id ? 'Edit list' : 'New list', fields: [{ name: 'name', label: 'Name', value: l.name, required: true }, { name: 'description', label: 'Description (shown on the preferences page)', type: 'textarea', value: l.description },
        { name: 'is_public', label: 'Public: people can join it from the sign-up form and choose it on their preferences page', type: 'checkbox', value: !!l.is_public },
        { name: 'double_opt_in', label: 'Double opt-in: sign-ups must confirm by email first (recommended)', type: 'checkbox', value: l.double_opt_in !== false }], confirm: 'Save' });
    };
    api('/admin/mailing/lists').then(function (j) {
      view('<div class="card">' + table(['List', 'Subscribers', 'Visibility', ''], j.lists, function (l) {
        return '<tr><td><b>' + esc(l.name) + '</b><div class="faint">' + esc(l.description || '') + '</div></td><td class="num"><a href="#/mail-contacts?listId=' + esc(l.id) + '">' + num(l.members) + '</a></td>' +
          '<td>' + (l.is_public ? badge('public', 'ok') : badge('private', 'grey')) + (l.double_opt_in ? ' ' + badge('double opt-in', 'grey') : '') + '</td>' +
          '<td><div class="row" style="justify-content:flex-end">' + (l.is_public ? '<button class="btn sm" data-embed="' + esc(l.id) + '">Sign-up form code</button>' : '') + '<button class="btn sm" data-edit="' + esc(l.id) + '">Edit</button><button class="btn sm ghost-danger" data-del="' + esc(l.id) + '">Delete</button></div></td></tr>';
      }, 'No lists yet. Lists are optional: you can always email everyone or filter by role and tags.') + '</div>' +
        '<div class="card stack" style="margin-top:14px"><h3>Sign-up form for your website</h3><p class="muted" style="margin:0">Paste this anywhere on rentcreeb.com. New sign-ups confirm by email, then join as subscribed contacts (and the list, if you pick a public one).</p>' +
        '<textarea class="input code" readonly rows="9" id="embed-any">' + esc(embedCode(null)) + '</textarea></div>');
      on('ml-add', function () { listForm().then(function (v) { if (v) act(post('/admin/mailing/lists', Object.assign(v, { is_public: !!v.is_public, double_opt_in: !!v.double_opt_in })), 'List created'); }); });
      bind('[data-edit]', function (id) { var l = j.lists.filter(function (x) { return x.id === id; })[0]; listForm(l).then(function (v) { if (v) act(api('/admin/mailing/lists/' + id, { method: 'PATCH', body: Object.assign(v, { is_public: !!v.is_public, double_opt_in: !!v.double_opt_in }) }), 'Saved'); }); });
      bind('[data-del]', function (id) { form({ title: 'Delete this list?', body: 'Contacts stay; they are just no longer grouped in this list.', confirm: 'Delete', danger: true }).then(function (v) { if (v) act(api('/admin/mailing/lists/' + id, { method: 'DELETE' }), 'Deleted'); }); });
      bind('[data-embed]', function (id) { form({ title: 'Sign-up form code', html: '<textarea class="input code" readonly rows="10">' + esc(embedCode(id)) + '</textarea>', wide: true, confirm: false }); });
    }).catch(mailFail);
  };
  function embedCode(listId) {
    return '<form action="' + location.origin + '/mail/subscribe" method="post">\n' + (listId ? '  <input type="hidden" name="listId" value="' + listId + '">\n' : '') +
      '  <input type="text" name="firstName" placeholder="First name">\n  <input type="email" name="email" placeholder="Email address" required>\n' +
      '  <input type="text" name="company" style="display:none" tabindex="-1" autocomplete="off">\n  <button type="submit">Subscribe</button>\n</form>';
  }

  // ── templates ──
  PAGES['mail-templates'] = function () {
    shell('mail-templates', 'Templates', 'Reusable email designs. Load one into a campaign or automation.', '<button class="btn" id="mt-starters">Add starter templates</button><button class="btn primary" id="mt-add">New template</button>');
    var tplForm = function (t) {
      t = t || {};
      return form({ title: t.id ? 'Edit template' : 'New template', wide: true, fields: [{ name: 'name', label: 'Name', value: t.name, required: true }, { name: 'subject', label: 'Subject line', value: t.subject }, { name: 'preheader', label: 'Preview text', value: t.preheader },
        { name: 'html', label: 'Body (plain text or HTML; personalisation like {{first_name|there}} works)', type: 'textarea', value: t.html || STARTER }], confirm: 'Save' });
    };
    api('/admin/mailing/templates').then(function (j) {
      view('<div class="card">' + table(['Template', 'Subject', 'Updated', ''], j.templates, function (t) {
        return '<tr><td><b>' + esc(t.name) + '</b></td><td>' + esc(t.subject || '') + '</td><td class="num">' + ago(t.updated_at) + '</td><td><div class="row" style="justify-content:flex-end"><button class="btn sm" data-prev="' + esc(t.id) + '">Preview</button><button class="btn sm" data-use="' + esc(t.id) + '">New campaign from it</button><button class="btn sm" data-edit="' + esc(t.id) + '">Edit</button><button class="btn sm ghost-danger" data-del="' + esc(t.id) + '">Delete</button></div></td></tr>';
      }, 'No templates yet. Press “Add starter templates” for 7 ready-made emails, save one from the campaign editor, or create one here.') + '</div>');
      on('mt-starters', function () {
        post('/admin/mailing/templates/starters').then(function (o) { toast(o.added ? 'Added ' + o.added + ' starter template' + (o.added === 1 ? '' : 's') : 'All starter templates are already here'); route(); }).catch(function (e) { toast(e.message, true); });
      });
      var byId = function (id) { return j.templates.filter(function (x) { return x.id === id; })[0]; };
      on('mt-add', function () { tplForm().then(function (v) { if (v) act(post('/admin/mailing/templates', v), 'Template saved'); }); });
      bind('[data-edit]', function (id) { tplForm(byId(id)).then(function (v) { if (v) act(api('/admin/mailing/templates/' + id, { method: 'PATCH', body: v }), 'Saved'); }); });
      bind('[data-del]', function (id) { form({ title: 'Delete this template?', confirm: 'Delete', danger: true }).then(function (v) { if (v) act(api('/admin/mailing/templates/' + id, { method: 'DELETE' }), 'Deleted'); }); });
      bind('[data-prev]', function (id) { var t = byId(id); post('/admin/mailing/preview', { subject: t.subject, preheader: t.preheader, html: t.html }).then(function (p) { form({ title: p.subject, html: '<iframe class="preview tall" sandbox="" title="Preview" id="v-frame"></iframe>', wide: true, confirm: false }); $('#v-frame').srcdoc = p.html; }).catch(function (e) { toast(e.message, true); }); });
      bind('[data-use]', function (id) { var t = byId(id); post('/admin/mailing/campaigns', { name: t.name, subject: t.subject, preheader: t.preheader, html: t.html }).then(function (c) { location.hash = '#/mail-campaigns/' + c.campaign.id; }).catch(function (e) { toast(e.message, true); }); });
    }).catch(mailFail);
  };

  // ── automations ──
  var TRIGGERS = [['user_signup', 'Someone creates a RentCreeb account'], ['contact_added', 'A new outside contact is added (import, sign-up form, by hand)'], ['list_joined', 'Someone joins a list'], ['waitlist_joined', 'Someone joins the waitlist on the website (sent the moment they sign up)']];
  function delayText(h) { return !h ? 'straight away' : h % 24 ? h + ' hour' + (h > 1 ? 's' : '') + ' later' : h / 24 + ' day' + (h > 24 ? 's' : '') + ' later'; }
  PAGES['mail-automations'] = function (r) {
    if (r.path[1]) return automationPage(r.path[1]);
    shell('mail-automations', 'Automations', 'Emails that send themselves: welcome series, onboarding tips, follow-ups.', '<a class="btn primary" href="#/mail-automations/new">New automation</a>');
    api('/admin/mailing/automations').then(function (j) {
      var trig = {}; TRIGGERS.forEach(function (t) { trig[t[0]] = t[1]; });
      view('<div class="card">' + table(['Automation', 'When', 'Sent', 'Opened', 'Status', ''], j.automations, function (a) {
        return '<tr><td class="click" data-go="#/mail-automations/' + esc(a.id) + '"><b>' + esc(a.name) + '</b><div class="faint">' + esc(a.subject) + '</div></td>' +
          '<td>' + esc(trig[a.trigger] || a.trigger) + (a.list ? ' (' + esc(a.list.name) + ')' : '') + (a.roles && a.roles.length ? '<div class="faint">' + esc(a.roles.join(', ')) + '</div>' : '') + '<div class="faint">' + esc(delayText(a.delay_hours)) + '</div></td>' +
          '<td class="num">' + num(a.stats.sent) + (a.stats.queued ? '<div class="faint">' + num(a.stats.queued) + ' waiting</div>' : '') + '</td><td class="num">' + pct(a.stats.openRate) + '</td>' +
          '<td>' + (a.active ? badge('running', 'ok') : badge('off', 'grey')) + '</td><td><button class="btn sm' + (a.active ? '' : ' primary') + '" data-tog="' + esc(a.id) + '" data-on="' + (a.active ? '1' : '') + '">' + (a.active ? 'Switch off' : 'Switch on') + '</button></td></tr>';
      }, 'No automations yet. A welcome email for new accounts is a good first one.') + '</div><p class="faint">Automations only reach people who trigger them after they are switched on. Chain several (e.g. day 0, day 3, day 7) for a series.</p>');
      bindGo();
      bind('[data-tog]', function (id, el) { act(api('/admin/mailing/automations/' + id, { method: 'PATCH', body: { active: !el.dataset.on } }), el.dataset.on ? 'Switched off' : 'Running'); });
    }).catch(mailFail);
  };
  function automationPage(id) {
    shell('mail-automations', id === 'new' ? 'New automation' : 'Automation', '');
    Promise.all([id === 'new' ? Promise.resolve(null) : api('/admin/mailing/automations').then(function (j) { return j.automations.filter(function (a) { return a.id === id; })[0] || null; }), api('/admin/mailing/lists'), api('/admin/mailing/overview')]).then(function (res) {
      var a = res[0] || { name: 'Welcome email', trigger: 'user_signup', delay_hours: 0, kind: 'marketing', roles: [], subject: 'Welcome to RentCreeb, {{first_name|there}}', html: STARTER };
      if (id !== 'new' && !res[0]) return view('<div class="err">Automation not found.</div>');
      var lists = res[1].lists;
      shell('mail-automations', id === 'new' ? 'New automation' : a.name, a.active ? 'Running. Changes apply to emails not sent yet.' : 'Off');
      var unit = a.delay_hours && a.delay_hours % 24 === 0 ? 'days' : 'hours'; var amount = unit === 'days' ? a.delay_hours / 24 : a.delay_hours;
      view(mailNotReady(res[2].status) + '<div class="row" style="margin-bottom:12px"><a class="btn sm" href="#/mail-automations">← Automations</a>' + (id !== 'new' ? '<button class="btn sm ghost-danger" id="au-del">Delete</button>' : '') + '</div>' +
        '<div class="card stack"><div class="grid cols-2 tight"><label class="field"><span>Name</span><input class="input" id="au-name" value="' + esc(a.name) + '"></label>' +
        '<label class="field"><span>Type</span><select class="input" id="au-kind"><option value="marketing"' + (a.kind === 'marketing' ? ' selected' : '') + '>Marketing (needs consent)</option><option value="service"' + (a.kind === 'service' ? ' selected' : '') + '>Service (account onboarding)</option></select></label>' +
        '<label class="field"><span>Starts when</span><select class="input" id="au-trigger">' + TRIGGERS.map(function (t) { return '<option value="' + t[0] + '"' + (a.trigger === t[0] ? ' selected' : '') + '>' + esc(t[1]) + '</option>'; }).join('') + '</select></label>' +
        '<label class="field" id="au-list-wrap"><span>List</span><select class="input" id="au-list"><option value="">Pick a list</option>' + lists.map(function (l) { return '<option value="' + esc(l.id) + '"' + (a.list_id === l.id ? ' selected' : '') + '>' + esc(l.name) + '</option>'; }).join('') + '</select></label>' +
        '<div class="field"><span>Send it</span><div class="row"><input class="input" id="au-amount" type="number" min="0" max="365" value="' + esc(amount) + '" style="width:90px"><select class="input" id="au-unit"><option value="hours"' + (unit === 'hours' ? ' selected' : '') + '>hours</option><option value="days"' + (unit === 'days' ? ' selected' : '') + '>days</option></select><span class="faint">after it starts (0 = straight away)</span></div></div></div>' +
        '<div class="field" id="au-roles-wrap"><span>Only for these roles <span class="faint">(none = everyone)</span></span><div class="checks">' + ROLE_OPTS.map(function (o) { return '<label class="check"><input type="checkbox" name="au-role" value="' + o[0] + '"' + ((a.roles || []).indexOf(o[0]) >= 0 ? ' checked' : '') + '><span>' + o[1] + '</span></label>'; }).join('') + '</div></div></div>' +
        section('Content', contentEditor(a)) +
        '<div class="card row between sticky-bar"><span class="faint">' + (a.active ? badge('running', 'ok') : badge('off', 'grey')) + '</span><div class="row"><button class="btn" id="au-test">Send test</button><button class="btn" id="au-save">Save</button>' +
        (a.active ? '<button class="btn" id="au-off">Switch off</button>' : '<button class="btn primary" id="au-on">Save &amp; switch on</button>') + '</div></div>');
      var sync = function () { var t = $('#au-trigger').value; $('#au-list-wrap').hidden = t !== 'list_joined'; $('#au-roles-wrap').hidden = t !== 'user_signup'; };
      $('#au-trigger').onchange = sync; sync();
      var kindOf = function () { return $('#au-kind').value; };
      var refresh = bindEditor(kindOf); $('#au-kind').onchange = refresh;
      var body = function () {
        var n = Math.max(0, Number($('#au-amount').value) || 0);
        return Object.assign({ name: $('#au-name').value.trim() || 'Automation', kind: kindOf(), trigger: $('#au-trigger').value, list_id: $('#au-list').value || null,
          roles: $$('input[name="au-role"]:checked').map(function (x) { return x.value; }), delay_hours: Math.round($('#au-unit').value === 'days' ? n * 24 : n) }, readContent());
      };
      var save = function (extra) {
        var b = Object.assign(body(), extra || {});
        var p = id === 'new' ? post('/admin/mailing/automations', b).then(function (j) { return extra && extra.active ? api('/admin/mailing/automations/' + j.automation.id, { method: 'PATCH', body: { active: true } }).then(function () { return j; }) : j; })
          : api('/admin/mailing/automations/' + id, { method: 'PATCH', body: b });
        return p.then(function (j) { toast(extra && extra.active ? 'Saved and running' : 'Saved'); if (id === 'new') location.hash = '#/mail-automations/' + j.automation.id; else route(); }).catch(function (e) { toast(e.message, true); });
      };
      on('au-save', function () { save(); });
      on('au-on', function () { form({ title: 'Switch on?', body: 'People who trigger it from now on get this email ' + delayText(body().delay_hours) + '. Nobody from before is back-sent.', confirm: 'Switch on' }).then(function (v) { if (v) save({ active: true }); }); });
      on('au-off', function () { save({ active: false }); });
      on('au-test', function () {
        form({ title: 'Send a test', fields: [{ name: 'to', label: 'Send to', value: me.email || '', required: true }], confirm: 'Send test' }).then(function (v) {
          if (v) post('/admin/mailing/test', Object.assign(readContent(), { kind: kindOf(), to: splitTags(v.to).slice(0, 5) })).then(function () { toast('Test sent'); }).catch(function (e) { toast(e.message, true); });
        });
      });
      on('au-del', function () { form({ title: 'Delete this automation?', body: 'Its history is deleted too.', confirm: 'Delete', danger: true }).then(function (v) { if (v) api('/admin/mailing/automations/' + id, { method: 'DELETE' }).then(function () { toast('Deleted'); location.hash = '#/mail-automations'; }).catch(function (e) { toast(e.message, true); }); }); });
    }).catch(mailFail);
  }

  // ═════════ Live chat availability (sidebar switch + heartbeat) ═════════
  function paintAvail() {
    var b = $('#avail'); if (!b) return;
    b.className = 'avail' + (agent.available ? ' on' : '');
    b.querySelector('span:last-child').textContent = agent.available ? 'Available for live chats' : 'Away from live chats';
  }
  function setAvailable(on, quiet) {
    agent.available = on; paintAvail();
    return api('/admin/support/me', { method: 'PUT', body: { available: on } }).then(function () { if (!quiet) toast(on ? 'You can now receive chats from the AI Assistant' : 'You won’t get new chats until you switch this back on'); })
      .catch(function (e) { agent.available = !on; paintAvail(); if (!quiet) toast(e.message, true); });
  }
  /** Every minute while the dashboard is open: keeps you "online" and announces chats newly assigned to you. */
  function heartbeat() {
    if (!me) return;
    post('/admin/support/heartbeat').then(function (h) {
      agent.known = true; if (agent.available !== h.available) { agent.available = h.available; paintAvail(); }
      (h.waiting || []).forEach(function (t) {
        if (agent.seen[t.id]) return; agent.seen[t.id] = true;
        if (agent.primed) toast('New chat for you: ' + t.subject);
      });
      agent.primed = true;
      counts.myChats = (h.waiting || []).length;
      var nav = $('.nav[href="#/support"]');
      if (nav) { var b = nav.querySelector('.mine'); if (counts.myChats && !b) nav.insertAdjacentHTML('beforeend', '<span class="badge mine" title="Waiting for you">' + counts.myChats + '</span>'); else if (b) { if (counts.myChats) b.textContent = counts.myChats; else b.remove(); } }
    }).catch(function () {});
  }
  setInterval(function () { if (document.visibilityState === 'visible') heartbeat(); }, 60000);
  setTimeout(heartbeat, 1500);

  /** Transcript of a chat with the AI Assistant (read-only, audited). */
  function showAssistantChat(id) {
    api('/admin/assistant/conversations/' + id).then(function (j) {
      var c = j.conversation;
      var html = '<div class="faint">' + userLink(c.user) + ' · ' + label(c.status) + ' · started ' + when(c.created_at) + '</div><div class="msgs thread">' + j.messages.map(function (m) {
        if (m.role === 'system') return '';
        var meta = m.meta || {}; var bits = [];
        if (meta.tools && meta.tools.length) bits.push('looked up: ' + meta.tools.join(', '));
        if (meta.usage) bits.push((meta.usage.input + meta.usage.output) + ' tokens' + (meta.usage.cacheRead ? ' (' + meta.usage.cacheRead + ' cached)' : ''));
        if (meta.error) bits.push('error: ' + meta.error);
        if (meta.refusal !== undefined) bits.push('declined');
        var acts = (m.actions || []).map(function (a) { return badge('→ ' + a.label, 'grey'); }).join(' ');
        return '<div class="msg' + (m.role === 'user' ? '' : ' right') + '">' + esc(m.content) + (acts ? '<div style="margin-top:6px">' + acts + '</div>' : '') +
          '<div class="meta">' + (m.role === 'user' ? plainName(c.user) : 'Assistant') + ' · ' + when(m.created_at) + (m.feedback === 1 ? ' · 👍' : m.feedback === -1 ? ' · 👎' : '') + (bits.length ? ' · ' + esc(bits.join(' · ')) : '') + '</div></div>';
      }).join('') + '</div>' + (c.ticket_id ? '<p><a href="#/support/' + esc(c.ticket_id) + '">Open the support ticket →</a></p>' : '');
      form({ title: 'AI Assistant chat', html: html, wide: true, confirm: false });
    }).catch(function (e) { toast(e.message, true); });
  }

  // ═════════ AI Assistant ═════════
  PAGES.assistant = function (r) {
    var tab = r.q.tab || 'knowledge';
    shell('assistant', 'AI Assistant', 'The in-app helper: what it knows, how it’s doing, and who it hands chats to.');
    api('/admin/assistant/overview').then(function (o) {
      if (!o.available) return view('<div class="err">Run migration 020_assistant.sql in Supabase to turn on the AI Assistant.</div>');
      var w = o.week;
      var stat = function (n, l) { return '<div class="card stat"><span class="n">' + n + '</span><span class="l">' + esc(l) + '</span></div>'; };
      var rated = w.thumbsUp + w.thumbsDown;
      var head = (!o.configured ? '<div class="alert bad" style="margin-bottom:14px">Add <b>NVIDIA_API_KEY</b> (or <b>ANTHROPIC_API_KEY</b>) to the server environment to switch the assistant on. Until then the app shows “Contact Support” instead.</div>' : '') +
        '<div class="card row between" style="margin-bottom:14px"><div class="row">' + (o.enabled ? badge('Live', 'ok') : badge('Off', 'grey')) +
        '<span class="faint">' + esc(o.provider || '') + ' · ' + esc(o.model) + (o.effort ? ' · effort ' + esc(o.effort) : '') + ' · ' + o.agentsOnline + ' agent' + (o.agentsOnline === 1 ? '' : 's') + ' online for handovers</span></div>' +
        '<button class="btn ' + (o.enabled ? 'ghost-danger' : 'primary') + '" id="as-toggle"' + (o.configured ? '' : ' disabled') + '>' + (o.enabled ? 'Switch off' : 'Switch on') + '</button></div>' +
        '<div class="grid cols-4">' + stat(w.chats, 'Chats, last 7 days') + stat(w.messages, 'Questions asked') + stat(w.handoffs, 'Handed to a person') +
        stat(rated ? Math.round((w.thumbsUp / rated) * 100) + '%' : '—', 'Helpful (' + w.thumbsUp + ' 👍 / ' + w.thumbsDown + ' 👎)') + '</div>' +
        '<div style="margin-top:18px">' + tabs([['knowledge', 'Knowledge', o.articles], ['chats', 'Chats'], ['test', 'Try it'], ['agents', 'Live agents']], tab, function (t) { return '/assistant' + qs({ tab: t }); }) + '</div><div id="as-body"><div class="spinner">Loading…</div></div>';
      view(head);
      on('as-toggle', function () {
        var go = function () { act(api('/admin/assistant/settings', { method: 'PUT', body: { enabled: !o.enabled } }), o.enabled ? 'Assistant switched off' : 'Assistant is on'); };
        if (o.enabled) form({ title: 'Switch off the assistant?', body: 'People will see “Contact Support” instead until you switch it back on.', confirm: 'Switch off', danger: true }).then(function (v) { if (v) go(); }); else go();
      });
      var body = function (html) { var el = $('#as-body'); if (el) el.innerHTML = html; };
      ({ knowledge: knowledgeTab, chats: chatsTab, test: testTab, agents: agentsTab }[tab] || knowledgeTab)(r, body);
    }).catch(fail);
  };

  function knowledgeTab(_r, body) {
    api('/admin/assistant/knowledge').then(function (j) {
      var edit = function (a) {
        a = a || {};
        return form({ title: a.id ? 'Edit knowledge' : 'Add knowledge', wide: true, fields: [
          { name: 'title', label: 'Topic', value: a.title, required: true, placeholder: 'e.g. Christmas holiday support hours' },
          { name: 'body', label: 'What the assistant should know (plain sentences work best)', type: 'textarea', value: a.body, required: true, placeholder: 'e.g. From 24 Dec to 1 Jan support replies between 9am and 3pm. Payments and escrow keep working as normal.' },
          { name: 'tags', label: 'Tags (optional, comma separated)', value: (a.tags || []).join(', ') },
          { name: 'active', label: 'Active: the assistant uses this now', type: 'checkbox', value: a.active !== false }], confirm: 'Save' })
          .then(function (v) {
            if (!v) return;
            var b = { title: v.title, body: v.body, tags: String(v.tags || '').split(',').map(function (t) { return t.trim(); }).filter(Boolean), active: !!v.active };
            act(a.id ? api('/admin/assistant/knowledge/' + a.id, { method: 'PATCH', body: b }) : post('/admin/assistant/knowledge', b), 'Saved: the assistant uses it within a minute');
          });
      };
      body('<div class="card stack"><div class="row between"><div><h3>Team knowledge</h3><p class="faint" style="margin:4px 0 0">Announcements, policy changes, promos and fixes for wrong answers. The assistant reads these on every chat and they override its built-in guide. No app update needed.</p></div><button class="btn primary" id="kn-add">Add knowledge</button></div>' +
        table(['Topic', 'Status', 'Updated', ''], j.articles, function (a) {
          return '<tr><td><b>' + esc(a.title) + '</b><div class="faint clamp">' + esc(a.body) + '</div>' + (a.tags || []).map(function (t) { return badge(t, 'grey'); }).join(' ') + '</td><td>' + (a.active ? badge('active', 'ok') : badge('off', 'grey')) + '</td>' +
            '<td class="num">' + ago(a.updated_at) + (a.editor ? '<div class="faint">' + name(a.editor) + '</div>' : '') + '</td><td><div class="row" style="justify-content:flex-end"><button class="btn sm" data-ed="' + esc(a.id) + '">Edit</button><button class="btn sm ghost-danger" data-del="' + esc(a.id) + '">Delete</button></div></td></tr>';
        }, 'Nothing yet. The assistant already knows the app from its built-in guide, the FAQ and live settings; add notes here for anything new.') + '</div>' +
        '<div class="card stack" style="margin-top:14px"><h3>How the assistant stays up to date</h3><ul class="muted" style="margin:0;padding-left:18px;line-height:1.7">' +
        '<li><b>Live every chat:</b> fees, cancellation rules, plans and prices, the app banner and maintenance mode, and the person’s own bookings, rent, payments and listings.</li>' +
        '<li><b>From the app itself:</b> the FAQ, support hours, listing options and screens, refreshed by <code>npm run assistant:sync</code> (runs automatically before starting or publishing the app).</li>' +
        '<li><b>Product guide:</b> <code>backend/assistant/knowledge.md</code>, updated with the code when a feature changes.</li>' +
        '<li><b>Team knowledge (this page):</b> anything else, instantly.</li></ul></div>');
      on('kn-add', function () { edit(); });
      bind('[data-ed]', function (id) { edit(j.articles.filter(function (a) { return a.id === id; })[0]); });
      bind('[data-del]', function (id) { form({ title: 'Delete this knowledge?', confirm: 'Delete', danger: true }).then(function (v) { if (v) act(api('/admin/assistant/knowledge/' + id, { method: 'DELETE' }), 'Deleted'); }); });
    }).catch(function (e) { body('<div class="err">' + esc(e.message) + '</div>'); });
  }

  function chatsTab(r, body) {
    var filter = r.q.filter || 'all'; var page = Number(r.q.page || 1);
    api('/admin/assistant/conversations' + qs({ filter: filter, page: page, limit: PAGE })).then(function (j) {
      body('<div class="row" style="margin-bottom:10px">' + [['all', 'All chats'], ['handed_off', 'Handed to a person'], ['disliked', 'Marked not helpful']].map(function (f) {
        return '<a class="btn sm' + (filter === f[0] ? ' primary' : '') + '" href="#/assistant' + qs({ tab: 'chats', filter: f[0] }) + '">' + f[1] + '</a>'; }).join('') + '</div>' +
        '<div class="card">' + table(['Person', 'Started with', 'Status', 'Last activity'], j.conversations, function (c) {
          return '<tr class="click" data-chat="' + esc(c.id) + '"><td>' + name(c.user) + '<div class="faint">' + label(c.user && c.user.role) + '</div></td><td class="clamp">' + esc(c.title || '') + '</td><td>' + statusBadge(c.status === 'handed_off' ? 'assigned' : c.status) + '</td><td class="num">' + ago(c.updated_at) + '</td></tr>';
        }, 'No chats yet.') + '</div>' + pager(page, j.total, r.raw));
      bind('[data-chat]', function (id) { showAssistantChat(id); });
    }).catch(function (e) { body('<div class="err">' + esc(e.message) + '</div>'); });
  }

  function testTab(_r, body) {
    var history = [];
    body('<div class="card stack"><div class="row between"><h3>Try the assistant</h3><div class="row"><label class="faint">Answer as a</label><select class="input sm" id="tt-role">' +
      ROLE_OPTS.filter(function (o) { return o[0] !== 'admin'; }).map(function (o) { return '<option value="' + o[0] + '">' + o[1].replace(/s$/, '') + '</option>'; }).join('') + '</select><button class="btn sm" id="tt-clear">Clear</button></div></div>' +
      '<p class="faint" style="margin:0">Nothing is saved or sent to users. Questions about “my” bookings, rent etc. use your own admin account’s data. Use this to check a new knowledge note.</p>' +
      '<div class="msgs thread" id="tt-log"><div class="empty">Ask something a user might ask.</div></div>' +
      '<form class="row" id="tt-form"><input class="input" id="tt-q" style="flex:1" placeholder="e.g. How do refunds work if the agent doesn’t show up?"><button class="btn primary">Ask</button></form></div>');
    var log = $('#tt-log');
    var add = function (role, html) { if (!history.length && log.querySelector('.empty')) log.innerHTML = ''; log.insertAdjacentHTML('beforeend', '<div class="msg' + (role === 'user' ? '' : ' right') + '">' + html + '</div>'); log.scrollTop = log.scrollHeight; };
    on('tt-clear', function () { history = []; log.innerHTML = '<div class="empty">Ask something a user might ask.</div>'; });
    $('#tt-form').onsubmit = function (e) {
      e.preventDefault(); var q = $('#tt-q').value.trim(); if (!q) return;
      add('user', esc(q)); $('#tt-q').value = ''; var btn = $('#tt-form button'); btn.disabled = true; btn.textContent = 'Thinking…';
      post('/admin/assistant/test', { text: q, asRole: $('#tt-role').value, history: history }).then(function (res) {
        history.push({ role: 'user', content: q }, { role: 'assistant', content: res.reply }); history = history.slice(-20);
        var meta = res.meta || {};
        add('assistant', esc(res.reply) + ((res.actions || []).length ? '<div style="margin-top:6px">' + res.actions.map(function (a) { return badge('→ ' + a.label + ' (' + a.screen + ')', 'grey'); }).join(' ') + '</div>' : '') +
          (res.handoff ? '<div style="margin-top:6px">' + badge('would hand over: ' + res.handoff.reason, 'warn') + '</div>' : '') +
          '<div class="meta">' + esc([(meta.tools || []).length ? 'looked up ' + meta.tools.join(', ') : 'no lookups', meta.usage ? (meta.usage.input + meta.usage.output) + ' tokens, ' + (meta.usage.cacheRead || 0) + ' from cache' : '', meta.error ? 'error: ' + meta.error : ''].filter(Boolean).join(' · ')) + '</div>');
      }).catch(function (err) { add('assistant', '<span style="color:var(--danger)">' + esc(err.message) + '</span>'); })
        .then(function () { btn.disabled = false; btn.textContent = 'Ask'; });
    };
  }

  function agentsTab(_r, body) {
    api('/admin/support/agents').then(function (j) {
      body('<div class="card stack"><div><h3>Who takes chats from the assistant</h3><p class="faint" style="margin:4px 0 0">When someone asks for a person, the chat goes to the available admin with the fewest open chats (and under their limit). Available = the sidebar switch is on and their dashboard is open. If nobody is available, it waits in Support → Unassigned and the support email is alerted.</p></div>' +
        table(['Admin', 'Status', 'Open chats', 'Limit', ''], j.agents, function (a) {
          var st = a.available && a.online ? badge('available', 'ok') : a.available ? badge('available, dashboard closed', 'warn') : badge('away', 'grey');
          return '<tr><td><div class="row">' + avatar(a) + '<div>' + name(a) + (a.id === me.id ? ' ' + badge('you', 'grey') : '') + '<div class="faint">' + esc(a.email || '') + '</div></div></div></td><td>' + st + (a.lastSeenAt ? '<div class="faint">seen ' + ago(a.lastSeenAt) + '</div>' : '') + '</td>' +
            '<td class="num">' + a.openChats + '</td><td class="num">' + a.maxOpen + '</td><td>' + (a.id === me.id ? '<button class="btn sm" id="ag-limit">Change my limit</button>' : '') + '</td></tr>';
        }) + '</div>');
      on('ag-limit', function () {
        var mine = j.agents.filter(function (a) { return a.id === me.id; })[0] || {};
        form({ title: 'Your chat limit', body: 'The most open chats you want assigned to you at once.', fields: [{ name: 'maxOpen', label: 'Limit', type: 'number', value: mine.maxOpen || 15, required: true }], confirm: 'Save' })
          .then(function (v) { if (v) act(api('/admin/support/me', { method: 'PUT', body: { maxOpen: Math.max(1, Math.min(500, Math.round(v.maxOpen))) } }), 'Limit saved'); });
      });
    }).catch(function (e) { body('<div class="err">' + esc(e.message) + '</div>'); });
  }

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
