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
  function when(iso) { if (!iso) return '—'; var d = new Date(iso); return d.toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }) + ' ' + d.toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' }); }
  function ago(iso) { if (!iso) return ''; var m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + 'h ago' : Math.round(m / 1440) + 'd ago'; }
  function name(p) { return p ? esc([p.first_name, p.last_name].filter(Boolean).join(' ') || p.email || 'Unnamed') : '—'; }
  function initials(p) { var f = (p && p.first_name) || ''; var l = (p && p.last_name) || ''; return esc(((f.charAt(0) + l.charAt(0)) || '?').toUpperCase()); }
  function avatar(p) { return '<div class="avatar">' + (p && safeUrl(p.avatar_url) ? '<img alt="" src="' + safeUrl(p.avatar_url) + '">' : initials(p)) + '</div>'; }
  function badge(text, tone) { return '<span class="badge ' + (tone || '') + '">' + esc(text) + '</span>'; }
  function statusBadge(s) {
    var tone = { approved: 'ok', success: 'ok', resolved: 'ok', active: 'ok', closed: 'grey', pending: 'warn', open: 'warn', investigating: 'warn', in_progress: 'warn', manual_review: 'warn',
      rejected: 'bad', failed: 'bad', dismissed: 'grey', refunded: 'grey', unlisted: 'grey', paused: 'grey', archived: 'grey', rented: 'ok' }[s];
    return badge(String(s || '—').replace(/_/g, ' '), tone);
  }
  function qs(o) { var p = []; Object.keys(o).forEach(function (k) { if (o[k] !== undefined && o[k] !== null && o[k] !== '') p.push(encodeURIComponent(k) + '=' + encodeURIComponent(o[k])); }); return p.length ? '?' + p.join('&') : ''; }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function toast(msg, bad) {
    var el = document.createElement('div'); el.className = 't' + (bad ? ' bad' : ''); el.textContent = msg;
    $('#toast').appendChild(el); setTimeout(function () { el.remove(); }, 3500);
  }

  // ───────── API ─────────
  function api(path, opts, retried) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    if (session && session.access_token) headers.Authorization = 'Bearer ' + session.access_token;
    return fetch(API + path, { method: opts.method || 'GET', headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined })
      .then(function (res) {
        if (res.status === 401 && !retried && session && session.refresh_token && path.indexOf('/auth/') !== 0) {
          return fetch(API + '/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: session.refresh_token }) })
            .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('expired')); })
            .then(function (j) { save(j.session); return api(path, opts, true); })
            .catch(function () { logout('Your session expired. Please sign in again.'); throw new Error('Session expired'); });
        }
        if (res.status === 204) return null;
        return res.json().catch(function () { return {}; }).then(function (j) {
          if (!res.ok) { var e = new Error((j.error && j.error.message) || ('Request failed (' + res.status + ')')); e.status = res.status; e.code = j.error && j.error.code; throw e; }
          return j;
        });
      });
  }
  function act(promise, okMsg) {
    return promise.then(function (r) { if (okMsg) toast(okMsg); route(); return r; }).catch(function (e) { toast(e.message, true); throw e; });
  }

  // ───────── modal ─────────
  function ask(opts) {
    // opts: { title, body, label, placeholder, required, confirm, danger, select: [[value,label]], value }
    return new Promise(function (resolve) {
      var root = $('#modal-root');
      var field = opts.select
        ? '<select class="input" id="m-sel">' + opts.select.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (o[0] === opts.value ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>'
        : '';
      var text = opts.label ? '<label class="stack"><span>' + esc(opts.label) + '</span><textarea class="input" id="m-text" placeholder="' + esc(opts.placeholder || '') + '">' + esc(opts.text || '') + '</textarea></label>' : '';
      root.innerHTML = '<div class="backdrop"><div class="card modal" role="dialog" aria-modal="true" aria-labelledby="m-title"><h2 id="m-title">' + esc(opts.title) + '</h2>' +
        (opts.body ? '<p class="muted" style="margin:0">' + esc(opts.body) + '</p>' : '') + field + text +
        '<div class="row" style="justify-content:flex-end"><button class="btn" id="m-cancel">Cancel</button><button class="btn ' + (opts.danger ? 'danger' : 'primary') + '" id="m-ok">' + esc(opts.confirm || 'Confirm') + '</button></div></div></div>';
      var close = function (v) { root.innerHTML = ''; document.removeEventListener('keydown', onKey); resolve(v); };
      var onKey = function (e) { if (e.key === 'Escape') close(null); };
      document.addEventListener('keydown', onKey);
      $('#m-cancel').onclick = function () { close(null); };
      $('.backdrop').onclick = function (e) { if (e.target.classList.contains('backdrop')) close(null); };
      $('#m-ok').onclick = function () {
        var t = $('#m-text') ? $('#m-text').value.trim() : '';
        if (opts.required && t.length < 3) { $('#m-text').focus(); toast('Please add a short reason', true); return; }
        close({ text: t, value: $('#m-sel') ? $('#m-sel').value : null });
      };
      setTimeout(function () { var f = $('#m-text') || $('#m-sel') || $('#m-ok'); f && f.focus(); }, 30);
    });
  }

  // ───────── shell ─────────
  var NAV = [
    ['overview', 'Overview'], ['listings', 'Listings', 'pendingProperties'], ['artisans', 'Artisan applications', 'pendingArtisans'],
    ['verifications', 'ID verifications', 'manualVerifications'], ['reports', 'Reports', 'openReports'], ['reviews', 'Flagged reviews', 'flaggedReviews'],
    ['support', 'Support tickets', 'openTickets'], ['users', 'Users'], ['payments', 'Payments'], ['audit', 'Audit log'],
  ];
  function shell(section, title, sub, actions) {
    var nav = NAV.map(function (n) {
      var c = n[2] && counts[n[2]] ? '<span class="badge">' + counts[n[2]] + '</span>' : '';
      return '<a class="nav' + (section === n[0] ? ' on' : '') + '" href="#/' + n[0] + '">' + esc(n[1]) + c + '</a>';
    }).join('');
    $('#app').innerHTML = '<div class="shell"><aside class="side" id="side"><div class="brand">RentCreeb <span>Admin</span></div>' + nav +
      '<div class="side-foot"><div>Signed in as<br><b style="color:#fff">' + name(me) + '</b></div><button id="logout">Sign out</button></div></aside>' +
      '<main class="main"><div class="head"><div><div class="row"><button class="btn sm menu-btn" id="menu">☰ Menu</button><h1>' + esc(title) + '</h1></div>' +
      (sub ? '<p>' + esc(sub) + '</p>' : '') + '</div><div class="row">' + (actions || '') + '</div></div><div id="view"><div class="spinner">Loading…</div></div></main></div>';
    $('#logout').onclick = function () { api('/auth/logout', { method: 'POST' }).catch(function () {}); logout(); };
    $('#menu').onclick = function () { $('#side').classList.toggle('open'); };
    return $('#view');
  }
  function view(html) { var v = $('#view'); if (v) v.innerHTML = html; return v; }
  function fail(e) { view('<div class="err">' + esc(e.message || 'Something went wrong') + '</div>'); }
  function pager(page, total, hash) {
    var pages = Math.max(1, Math.ceil((total || 0) / PAGE));
    if (pages <= 1) return '';
    var base = hash.replace(/([?&])page=\d+/, '$1').replace(/[?&]$/, '');
    var link = function (p) { return '#' + base + (base.indexOf('?') >= 0 ? '&' : '?') + 'page=' + p; };
    return '<div class="pager"><span class="faint">Page ' + page + ' of ' + pages + ' · ' + total + ' total</span>' +
      (page > 1 ? '<a class="btn sm" href="' + link(page - 1) + '">← Prev</a>' : '') + (page < pages ? '<a class="btn sm" href="' + link(page + 1) + '">Next →</a>' : '') + '</div>';
  }
  /** Prev/next only, for lists where the API doesn't return a total. */
  function pagerMore(page, hasMore, hash) {
    if (page <= 1 && !hasMore) return '';
    var base = hash.replace(/([?&])page=\d+/, '$1').replace(/[?&]$/, '');
    var link = function (p) { return '#' + base + (base.indexOf('?') >= 0 ? '&' : '?') + 'page=' + p; };
    return '<div class="pager"><span class="faint">Page ' + page + '</span>' + (page > 1 ? '<a class="btn sm" href="' + link(page - 1) + '">← Prev</a>' : '') + (hasMore ? '<a class="btn sm" href="' + link(page + 1) + '">Next →</a>' : '') + '</div>';
  }
  function tabs(items, current, hashFor) {
    return '<div class="tabs">' + items.map(function (t) { return '<a class="tab' + (t[0] === current ? ' on' : '') + '" href="#' + hashFor(t[0]) + '">' + esc(t[1]) + '</a>'; }).join('') + '</div>';
  }
  function refreshCounts() { return api('/admin/overview').then(function (o) { counts = o.queues; return o; }); }

  // ───────── router ─────────
  function parse() {
    var h = (location.hash || '#/overview').slice(1);
    var parts = h.split('?'); var path = parts[0].split('/').filter(Boolean); var q = {};
    (parts[1] || '').split('&').forEach(function (kv) { if (!kv) return; var x = kv.split('='); q[decodeURIComponent(x[0])] = decodeURIComponent(x[1] || ''); });
    return { path: path, q: q, raw: h };
  }
  function route() {
    $('#modal-root').innerHTML = ''; // never carry a dialog over to another page
    if (!session) return renderLogin();
    if (!me) return api('/users/me').then(function (r) {
      var p = r.profile || r.user || r;
      if (!p || p.role !== 'admin') { logout('This account is not an admin.'); return; }
      me = p; route();
    }).catch(function () { logout(); });
    var r = parse(); var s = r.path[0] || 'overview';
    var fn = { overview: pOverview, listings: pListings, artisans: pArtisans, verifications: pVerifications, reports: pReports, reviews: pReviews, support: pSupport, users: pUsers, payments: pPayments, audit: pAudit }[s] || pOverview;
    fn(r);
  }
  window.addEventListener('hashchange', route);
  function logout(msg) { save(null); me = null; renderLogin(msg); }

  // ───────── login ─────────
  function renderLogin(msg) {
    $('#app').innerHTML = '<div class="login"><form class="card" id="login"><div><h1>RentCreeb Admin</h1><p class="muted" style="margin:6px 0 0">Sign in with your admin account.</p></div>' +
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
        if (!location.hash || location.hash === '#/') location.hash = '#/overview'; else route();
      }).catch(function (err) { renderLogin(err.status === 401 ? 'Wrong email or password.' : err.message); });
    };
  }

  // ───────── pages ─────────
  function pOverview() {
    shell('overview', 'Overview', 'What needs attention right now.');
    refreshCounts().then(function (o) {
      shell('overview', 'Overview', 'What needs attention right now.');
      var q = o.queues, u = o.users, a = o.activity;
      var card = function (n, l, href, hot) { return '<a class="card stat' + (hot && n ? ' hot' : '') + '" href="' + href + '"><span class="n">' + n + '</span><span class="l">' + esc(l) + '</span></a>'; };
      var plain = function (n, l) { return '<div class="card stat"><span class="n">' + n + '</span><span class="l">' + esc(l) + '</span></div>'; };
      view('<h2 style="margin-bottom:10px">Queues</h2><div class="grid cols-4">' +
        card(q.pendingProperties, 'Listings awaiting approval', '#/listings', 1) + card(q.pendingArtisans, 'Artisan applications', '#/artisans', 1) +
        card(q.manualVerifications, 'ID checks needing review', '#/verifications', 1) + card(q.openReports, 'Open reports', '#/reports', 1) +
        card(q.flaggedReviews, 'Flagged reviews', '#/reviews', 1) + card(q.openTickets, 'Open support tickets', '#/support', 1) + '</div>' +
        '<h2 style="margin:24px 0 10px">Platform</h2><div class="grid cols-4">' +
        card(u.total, 'Users (' + u.new7d + ' new this week)', '#/users') + plain(u.tenants, 'Tenants') + plain(u.landlords, 'Landlords & estate managers') +
        plain(u.agents, 'Agents') + plain(u.artisans, 'Artisans') + card(u.suspended, 'Suspended accounts', '#/users?status=suspended') +
        plain(a.liveProperties, 'Live listings') + plain(a.bookings7d, 'Bookings this week') + plain(a.activeSubscriptions, 'Active subscriptions') +
        card(naira(a.paymentsKobo30d), 'Payments, last 30 days', '#/payments?status=success') + plain(naira(a.escrowHeldKobo), 'Held in escrow') + '</div>' +
        '<h2 style="margin:24px 0 10px">Recent admin activity</h2><div class="card">' + actionsTable(o.recentActions) + '<div class="pager"><a class="btn sm" href="#/audit">Full audit log →</a></div></div>');
    }).catch(fail);
  }

  function actionsTable(rows) {
    if (!rows || !rows.length) return '<div class="empty">No admin actions recorded yet.</div>';
    return '<div class="table-wrap"><table><thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Target</th><th>Details</th></tr></thead><tbody>' + rows.map(function (x) {
      var d = x.details || {}; var det = Object.keys(d).map(function (k) { return esc(k) + ': ' + esc(typeof d[k] === 'object' ? JSON.stringify(d[k]) : d[k]); }).join('<br>');
      var link = x.target_type === 'user' && x.target_id ? '<a href="#/users/' + esc(x.target_id) + '">user</a>' : esc(x.target_type);
      return '<tr><td class="num">' + when(x.created_at) + '</td><td>' + name(x.admin) + '</td><td>' + badge(x.action.replace(/\./g, ' · ')) + '</td><td>' + link + '</td><td class="faint">' + (det || '—') + '</td></tr>';
    }).join('') + '</tbody></table></div>';
  }

  // Listings
  function pListings(r) {
    var tab = r.q.tab || 'pending'; var page = Number(r.q.page || 1);
    shell('listings', 'Listings', 'Approve new listings and take down problem ones.');
    var search = '<form class="row" id="lsearch"><input class="input" name="q" placeholder="Search title, address or area" value="' + esc(r.q.q || '') + '"><button class="btn">Search</button></form>';
    var head = tabs([['pending', 'Awaiting approval'], ['approved', 'Live'], ['rejected', 'Rejected / removed'], ['all', 'All']], tab, function (t) { return '/listings?tab=' + t; });
    var req = tab === 'pending' ? api('/admin/properties/pending').then(function (j) { return { properties: j.properties || [], total: (j.properties || []).length }; })
      : api('/admin/properties' + qs({ status: tab === 'all' ? '' : tab, q: r.q.q, page: page, limit: PAGE }));
    req.then(function (j) {
      var list = j.properties || [];
      view(head + (tab === 'pending' ? '' : search + '<div style="height:12px"></div>') + (list.length ? '<div class="stack">' + list.map(function (p) {
        var img = (p.property_media || []).slice().sort(function (a, b) { return (a.position || 0) - (b.position || 0); })[0];
        var acts = p.status === 'pending' ? '<button class="btn ok sm" data-approve="' + esc(p.id) + '">Approve</button><button class="btn ghost-danger sm" data-reject="' + esc(p.id) + '">Reject</button>'
          : ['approved', 'paused', 'unlisted'].indexOf(p.status) >= 0 ? '<button class="btn ghost-danger sm" data-down="' + esc(p.id) + '">Take down</button>'
          : p.status === 'rejected' ? '<button class="btn sm" data-restore="' + esc(p.id) + '">Restore</button>' : '';
        return '<div class="card list-item">' + (img && safeUrl(img.url) ? '<img class="thumb" alt="" src="' + safeUrl(img.url) + '">' : '<div class="thumb"></div>') +
          '<div class="grow stack" style="gap:4px"><div class="row between"><h3>' + esc(p.title) + '</h3>' + statusBadge(p.status) + '</div>' +
          '<div class="muted">' + esc([p.address, p.area, p.city].filter(Boolean).join(', ')) + '</div>' +
          '<div class="row"><b class="num">' + naira(p.price_kobo) + '/' + esc(p.price_period || 'year') + '</b><span class="faint">' + esc(p.property_type || '') + (p.bedrooms ? ' · ' + p.bedrooms + ' bed' : '') + '</span>' +
          (p.owner ? '<span class="faint">· by <a href="#/users/' + esc(p.owner.id || p.owner_id) + '">' + name(p.owner) + '</a> (' + esc(p.owner.role) + ')</span>' : '') + '<span class="faint">· ' + ago(p.created_at) + '</span></div>' +
          (p.rejection_reason ? '<div class="faint">Reason: ' + esc(p.rejection_reason) + '</div>' : '') + (p.description ? '<div class="quote">' + esc(p.description).slice(0, 600) + '</div>' : '') +
          '</div><div class="stack">' + acts + '</div></div>';
      }).join('') + '</div>' : '<div class="card empty">Nothing here.</div>') + (tab === 'pending' ? '' : pager(page, j.total, r.raw)));
      var sf = $('#lsearch'); if (sf) sf.onsubmit = function (e) { e.preventDefault(); location.hash = '#/listings' + qs({ tab: tab, q: e.target.q.value.trim() }); };
      bind('[data-approve]', function (id) { act(api('/admin/properties/' + id + '/decision', { method: 'POST', body: { approve: true } }), 'Listing approved'); });
      bind('[data-reject]', function (id) { ask({ title: 'Reject listing', label: 'Reason (sent to the owner)', placeholder: 'e.g. Photos are unclear — please upload clear photos of each room', required: true, confirm: 'Reject', danger: true })
        .then(function (m) { if (m) act(api('/admin/properties/' + id + '/decision', { method: 'POST', body: { approve: false, reason: m.text } }), 'Listing rejected'); }); });
      bind('[data-down]', function (id) { ask({ title: 'Take listing down', body: 'It disappears from search immediately. The owner is notified.', label: 'Reason (sent to the owner)', required: true, confirm: 'Take down', danger: true })
        .then(function (m) { if (m) act(api('/admin/properties/' + id + '/takedown', { method: 'POST', body: { down: true, reason: m.text } }), 'Listing taken down'); }); });
      bind('[data-restore]', function (id) { act(api('/admin/properties/' + id + '/takedown', { method: 'POST', body: { down: false } }), 'Listing restored'); });
    }).catch(fail);
  }

  function bind(sel, fn) { document.querySelectorAll(sel).forEach(function (el) { var attr = sel.replace(/[\[\]]/g, '').replace('data-', ''); el.onclick = function (e) { e.stopPropagation(); fn(el.dataset[camel(attr)], el); }; }); }
  function camel(s) { return s.replace(/-([a-z])/g, function (_m, c) { return c.toUpperCase(); }); }

  // Artisan applications
  var REL = { client: 'Past client', employer: 'Employer', colleague: 'Colleague', supplier: 'Supplier', landlord: 'Landlord / Estate', other: 'Other' };
  function pArtisans() {
    shell('artisans', 'Artisan applications', 'Check documents and references, then approve or send back.');
    api('/admin/artisans/pending').then(function (j) {
      var list = j.artisans || [];
      view(list.length ? '<div class="stack">' + list.map(function (a) {
        var p = a.profiles || {};
        var docs = (a.artisan_documents || []).map(function (d) { return '<button class="btn sm" data-doc="' + esc(d.id) + '">View ' + esc(String(d.doc_type).replace(/_/g, ' ')) + '</button>'; }).join('') || '<span class="faint">No documents</span>';
        var refs = (a.artisan_references || []).map(function (x) {
          var socials = (x.socials || []).map(function (s) { var h = String(s.handle || ''); var href = /^https?:\/\//i.test(h) ? h : ''; return badge(s.platform + ': ' + h, 'grey') + (href ? ' <a target="_blank" rel="noopener" href="' + safeUrl(href) + '">open</a>' : ''); }).join(' ');
          return '<div class="ref"><div class="row between"><b>' + esc(x.name) + '</b>' + (x.consent ? badge('Agreed to be contacted', 'ok') : badge('No consent recorded', 'warn')) + '</div>' +
            '<div class="muted">' + esc([REL[x.relationship] || x.relationship, [x.job_title, x.company].filter(Boolean).join(' at '), x.years_known != null ? 'known ' + x.years_known + ' yr' : ''].filter(Boolean).join(' · ')) + '</div>' +
            '<div><a href="tel:' + esc(x.phone) + '">' + esc(x.phone) + '</a>' + (x.email ? ' · <a href="mailto:' + esc(x.email) + '">' + esc(x.email) + '</a>' : '') + '</div>' +
            (socials ? '<div class="chips">' + socials + '</div>' : '') + (x.note ? '<div class="faint">“' + esc(x.note) + '”</div>' : '') + '</div>';
        }).join('') || '<span class="faint">No references given</span>';
        return '<div class="card stack"><div class="row between"><div class="row">' + avatar(p) + '<div><h3><a href="#/users/' + esc(a.user_id) + '">' + name(p) + '</a></h3><div class="faint">' + esc(p.phone || '') + ' · ' + esc(p.email || '') + '</div></div></div>' +
          '<div class="row">' + (p.nin_verified ? badge('NIN verified', 'ok') : badge('NIN not verified', 'bad')) + '<span class="faint">submitted ' + ago(a.submitted_at) + '</span></div></div>' +
          '<dl class="kv"><dt>Primary skill</dt><dd><b>' + esc(a.skill_category || '—') + '</b></dd><dt>Other skills</dt><dd><div class="chips">' + ((a.additional_skills || []).map(function (s) { return badge(s, 'grey'); }).join('') || '—') + '</div></dd>' +
          '<dt>Service areas</dt><dd><div class="chips">' + ((a.service_areas || []).map(function (s) { return badge(s, 'grey'); }).join('') || '—') + '</div></dd>' +
          '<dt>Experience</dt><dd>' + esc(a.years_experience || 0) + ' years</dd><dt>Home</dt><dd>' + esc([a.home_address, a.lga, a.state].filter(Boolean).join(', ') || '—') + '</dd>' +
          (a.bio ? '<dt>Bio</dt><dd>' + esc(a.bio) + '</dd>' : '') + '<dt>Documents</dt><dd class="row">' + docs + '</dd></dl>' +
          '<div><h3 style="margin-bottom:8px">References</h3><div class="grid cols-2">' + refs + '</div></div>' +
          '<div class="row" style="justify-content:flex-end"><button class="btn ghost-danger" data-areject="' + esc(a.user_id) + '">Send back</button><button class="btn ok" data-aapprove="' + esc(a.user_id) + '">Approve artisan</button></div></div>';
      }).join('') + '</div>' : '<div class="card empty">No applications waiting. 🎉</div>');
      bind('[data-doc]', function (id) { api('/admin/artisan-documents/' + id + '/url').then(function (x) { window.open(x.url, '_blank', 'noopener'); }).catch(function (e) { toast(e.message, true); }); });
      bind('[data-aapprove]', function (id) { act(api('/admin/artisans/' + id + '/decision', { method: 'POST', body: { approve: true } }), 'Artisan approved'); });
      bind('[data-areject]', function (id) { ask({ title: 'Send application back', label: 'What needs fixing? (sent to the artisan)', placeholder: 'e.g. Your ID photo is blurry — please upload a clearer one', required: true, confirm: 'Send back', danger: true })
        .then(function (m) { if (m) act(api('/admin/artisans/' + id + '/decision', { method: 'POST', body: { approve: false, reason: m.text } }), 'Application sent back'); }); });
    }).catch(fail);
  }

  // ID verifications
  function pVerifications(r) {
    var tab = r.q.tab || 'manual_review';
    shell('verifications', 'ID verifications', 'NIN checks the automatic matcher could not decide.');
    api('/admin/verifications' + qs({ status: tab })).then(function (j) {
      var list = j.verifications || [];
      view(tabs([['manual_review', 'Needs review'], ['failed', 'Failed'], ['success', 'Passed']], tab, function (t) { return '/verifications?tab=' + t; }) +
        (list.length ? '<div class="card table-wrap"><table><thead><tr><th>User</th><th>NIN</th><th>Match</th><th>Note</th><th>When</th><th></th></tr></thead><tbody>' + list.map(function (v) {
          var u = v.user || {};
          return '<tr><td><a href="#/users/' + esc(u.id) + '">' + name(u) + '</a><div class="faint">' + esc(u.role || '') + ' · ' + esc(u.phone || '') + '</div></td><td class="num">••••••••' + esc(v.nin_last3) + '</td>' +
            '<td>' + (v.confidence != null ? esc(Math.round(Number(v.confidence))) + '%' : '—') + '</td><td class="faint">' + esc(v.failure_reason || '') + '</td><td class="num">' + when(v.created_at) + '</td>' +
            '<td>' + (v.status === 'manual_review' ? '<div class="row"><button class="btn ok sm" data-vok="' + esc(u.id) + '">Verify</button><button class="btn ghost-danger sm" data-vno="' + esc(v.id) + '">Reject</button></div>' : statusBadge(v.status)) + '</td></tr>';
        }).join('') + '</tbody></table></div>' : '<div class="card empty">Nothing here.</div>'));
      bind('[data-vok]', function (id) { ask({ title: 'Mark this person as verified?', body: 'Only do this after checking their ID against the name on the account.', confirm: 'Verify' }).then(function (m) { if (m) act(api('/admin/users/' + id + '/verify', { method: 'POST' }), 'User verified'); }); });
      bind('[data-vno]', function (id) { ask({ title: 'Reject ID check', label: 'Reason (sent to the user)', placeholder: 'e.g. The NIN does not match the name on your account', required: true, confirm: 'Reject', danger: true })
        .then(function (m) { if (m) act(api('/admin/verifications/' + id + '/reject', { method: 'POST', body: { reason: m.text } }), 'ID check rejected'); }); });
    }).catch(fail);
  }

  // Reports
  function pReports(r) {
    var tab = r.q.tab || 'open'; var page = Number(r.q.page || 1);
    shell('reports', 'Reports', 'Scam and misconduct reports filed by users.');
    api('/admin/reports' + qs({ status: tab === 'all' ? '' : tab, page: page, limit: PAGE })).then(function (j) {
      var list = j.reports || [];
      view(tabs([['open', 'Open'], ['investigating', 'Investigating'], ['resolved', 'Resolved'], ['dismissed', 'Dismissed'], ['all', 'All']], tab, function (t) { return '/reports?tab=' + t; }) +
        (list.length ? '<div class="stack">' + list.map(function (x) {
          var ev = (x.evidence_urls || []).filter(function (u) { return safeUrl(u); }).map(function (u) { return '<a target="_blank" rel="noopener" href="' + safeUrl(u) + '"><img class="thumb" alt="Evidence" src="' + safeUrl(u) + '"></a>'; }).join('');
          var agent = x.agent || {};
          return '<div class="card stack"><div class="row between"><div><h3>' + esc(x.reason) + '</h3><div class="faint">Reported ' + ago(x.created_at) + ' by <a href="#/users/' + esc(x.reporter && x.reporter.id) + '">' + name(x.reporter) + '</a></div></div>' + statusBadge(x.status) + '</div>' +
            '<div>Against: <a href="#/users/' + esc(agent.id) + '"><b>' + name(agent) + '</b></a> ' + (agent.is_suspended ? badge('Suspended', 'bad') : '') + '</div>' +
            (x.details ? '<div class="quote">' + esc(x.details) + '</div>' : '') + (ev ? '<div class="row">' + ev + '</div>' : '') + (x.admin_note ? '<div class="faint">Admin note: ' + esc(x.admin_note) + '</div>' : '') +
            '<div class="row" style="justify-content:flex-end">' + (agent.id && !agent.is_suspended ? '<button class="btn ghost-danger" data-rsusp="' + esc(agent.id) + '">Suspend reported user</button>' : '') +
            '<button class="btn primary" data-rstat="' + esc(x.id) + '" data-cur="' + esc(x.status) + '">Update status</button></div></div>';
        }).join('') + '</div>' : '<div class="card empty">No reports here.</div>') + pagerMore(page, list.length === PAGE, r.raw));
      bind('[data-rstat]', function (id, el) {
        ask({ title: 'Update report', select: [['open', 'Open'], ['investigating', 'Investigating'], ['resolved', 'Resolved'], ['dismissed', 'Dismissed']], value: el.dataset.cur, label: 'Internal note (optional)', confirm: 'Save' })
          .then(function (m) { if (m) act(api('/admin/reports/' + id, { method: 'PATCH', body: { status: m.value, adminNote: m.text || undefined } }), 'Report updated'); });
      });
      bind('[data-rsusp]', suspendFlow);
    }).catch(fail);
  }
  function suspendFlow(id) {
    ask({ title: 'Suspend this account?', body: 'They are signed out of the app and cannot use RentCreeb until you lift it.', label: 'Reason (kept in the audit log)', required: true, confirm: 'Suspend', danger: true })
      .then(function (m) { if (m) act(api('/admin/users/' + id + '/suspend', { method: 'POST', body: { suspended: true, reason: m.text } }), 'Account suspended'); });
  }

  // Reviews
  function pReviews(r) {
    var tab = r.q.tab || 'true';
    shell('reviews', 'Reviews', 'Reviews flagged by agents or users.');
    api('/admin/reviews' + qs({ flagged: tab })).then(function (j) {
      var list = j.reviews || [];
      view(tabs([['true', 'Flagged'], ['false', 'All recent']], tab, function (t) { return '/reviews?tab=' + t; }) + (list.length ? '<div class="stack">' + list.map(function (x) {
        var reasons = (x.review_flags || []).map(function (f) { return f.reason; }).filter(Boolean);
        return '<div class="card stack"><div class="row between"><div><b>' + '★'.repeat(x.rating) + '<span class="faint">' + '★'.repeat(5 - x.rating) + '</span></b> <span class="muted">by ' + name(x.reviewer) + ' for ' + name(x.agent) + (x.properties ? ' · ' + esc(x.properties.title) : '') + '</span></div>' +
          '<div class="row">' + (x.flag_count ? badge(x.flag_count + ' flag' + (x.flag_count === 1 ? '' : 's'), 'warn') : '') + (x.hidden ? badge('Hidden', 'grey') : '') + '</div></div>' +
          (x.comment ? '<div class="quote">' + esc(x.comment) + '</div>' : '<div class="faint">No comment</div>') + (reasons.length ? '<div class="faint">Flag reasons: ' + reasons.map(esc).join(' · ') + '</div>' : '') +
          '<div class="row" style="justify-content:flex-end"><button class="btn ' + (x.hidden ? '' : 'ghost-danger') + '" data-hide="' + esc(x.id) + '" data-h="' + (x.hidden ? '0' : '1') + '">' + (x.hidden ? 'Show again' : 'Hide review') + '</button></div></div>';
      }).join('') + '</div>' : '<div class="card empty">No flagged reviews.</div>'));
      bind('[data-hide]', function (id, el) { act(api('/admin/reviews/' + id + '/hide', { method: 'POST', body: { hidden: el.dataset.h === '1' } }), el.dataset.h === '1' ? 'Review hidden' : 'Review visible again'); });
    }).catch(fail);
  }

  // Support
  function pSupport(r) {
    var tab = r.q.tab || 'open';
    shell('support', 'Support tickets', 'Contact Support, bug reports and data requests from the app.');
    api('/admin/tickets' + qs({ status: tab === 'all' ? '' : tab })).then(function (j) {
      var list = j.tickets || [];
      var kind = { support: ['Support', ''], bug: ['Bug', 'warn'], data_request: ['Data request', 'bad'] };
      view(tabs([['open', 'Open'], ['in_progress', 'In progress'], ['resolved', 'Resolved'], ['closed', 'Closed'], ['all', 'All']], tab, function (t) { return '/support?tab=' + t; }) + (list.length ? '<div class="stack">' + list.map(function (t) {
        var k = kind[t.kind] || [t.kind, ''];
        var meta = t.meta && Object.keys(t.meta).length ? '<div class="faint">' + Object.keys(t.meta).map(function (m) { return esc(m) + ': ' + esc(typeof t.meta[m] === 'object' ? JSON.stringify(t.meta[m]) : t.meta[m]); }).join(' · ') + '</div>' : '';
        return '<div class="card stack"><div class="row between"><div class="row">' + badge(k[0], k[1]) + (t.severity ? badge(t.severity + ' severity', t.severity === 'high' ? 'bad' : 'grey') : '') + '<h3>' + esc(t.subject) + '</h3></div>' + statusBadge(t.status) + '</div>' +
          '<div class="faint">' + esc(t.category) + ' · from <a href="#/users/' + esc(t.user && t.user.id) + '">' + name(t.user) + '</a> (' + esc(t.user && (t.user.email || t.user.phone) || '') + ') · ' + ago(t.created_at) + '</div>' +
          '<div class="quote">' + esc(t.message) + '</div>' + meta + (t.admin_note ? '<div class="faint">Last reply / note: ' + esc(t.admin_note) + '</div>' : '') +
          '<div class="row" style="justify-content:flex-end"><button class="btn primary" data-tick="' + esc(t.id) + '" data-cur="' + esc(t.status) + '">Reply / update</button></div></div>';
      }).join('') + '</div>' : '<div class="card empty">No tickets here.</div>'));
      bind('[data-tick]', function (id, el) {
        ask({ title: 'Update ticket', select: [['open', 'Open'], ['in_progress', 'In progress'], ['resolved', 'Resolved'], ['closed', 'Closed']], value: el.dataset.cur === 'open' ? 'in_progress' : el.dataset.cur,
          label: 'Message to the user (sent as a notification; optional)', confirm: 'Save' })
          .then(function (m) { if (m) act(api('/admin/tickets/' + id, { method: 'PATCH', body: { status: m.value, adminNote: m.text || undefined } }), 'Ticket updated'); });
      });
    }).catch(fail);
  }

  // Users
  function pUsers(r) {
    if (r.path[1]) return pUser(r.path[1]);
    var page = Number(r.q.page || 1);
    shell('users', 'Users', 'Search accounts, check activity, verify or suspend.');
    var filters = '<form class="row" id="ufilter" style="margin-bottom:14px"><input class="input" name="q" placeholder="Name, email or phone" value="' + esc(r.q.q || '') + '">' +
      '<select class="input" name="role"><option value="">All roles</option>' + ['tenant', 'landlord', 'estate_manager', 'agent', 'artisan', 'admin'].map(function (x) { return '<option' + (r.q.role === x ? ' selected' : '') + ' value="' + x + '">' + x.replace('_', ' ') + '</option>'; }).join('') + '</select>' +
      '<select class="input" name="status"><option value="">Any status</option>' + [['verified', 'NIN verified'], ['unverified', 'Not verified'], ['suspended', 'Suspended']].map(function (x) { return '<option' + (r.q.status === x[0] ? ' selected' : '') + ' value="' + x[0] + '">' + x[1] + '</option>'; }).join('') + '</select>' +
      '<button class="btn primary">Filter</button></form>';
    api('/admin/users' + qs({ q: r.q.q, role: r.q.role, status: r.q.status, page: page, limit: PAGE })).then(function (j) {
      var list = j.users || [];
      view(filters + '<div class="card table-wrap">' + (list.length ? '<table><thead><tr><th>Name</th><th>Role</th><th>Contact</th><th>Status</th><th>Joined</th></tr></thead><tbody>' + list.map(function (u) {
        return '<tr class="click" data-go="' + esc(u.id) + '"><td><div class="row">' + avatar(u) + '<b>' + name(u) + '</b></div></td><td>' + esc(String(u.role).replace('_', ' ')) + '</td><td>' + esc(u.email || '') + '<div class="faint">' + esc(u.phone || '') + '</div></td>' +
          '<td><div class="chips">' + (u.is_suspended ? badge('Suspended', 'bad') : '') + (u.nin_verified ? badge('NIN verified', 'ok') : u.phone_verified ? badge('Phone only', 'warn') : badge('Unverified', 'grey')) + '</div></td><td class="num">' + when(u.created_at) + '</td></tr>';
      }).join('') + '</tbody></table>' : '<div class="empty">No users match.</div>') + '</div>' + pager(page, j.total, r.raw));
      $('#ufilter').onsubmit = function (e) { e.preventDefault(); var f = e.target; location.hash = '#/users' + qs({ q: f.q.value.trim(), role: f.role.value, status: f.status.value }); };
      bind('[data-go]', function (id) { location.hash = '#/users/' + id; });
    }).catch(fail);
  }
  function pUser(id) {
    shell('users', 'User', '', '<a class="btn sm" href="#/users">← All users</a>');
    api('/admin/users/' + encodeURIComponent(id)).then(function (j) {
      var u = j.user; var a = j.artisan;
      shell('users', [u.first_name, u.last_name].filter(Boolean).join(' ') || 'User', String(u.role).replace('_', ' ') + ' · joined ' + when(u.created_at), '<a class="btn sm" href="#/users">← All users</a>');
      var table = function (title, rows, cols, render) {
        return '<div class="card"><h3 style="margin-bottom:8px">' + esc(title) + ' <span class="faint">(' + rows.length + ')</span></h3>' + (rows.length ? '<div class="table-wrap"><table><thead><tr>' + cols.map(function (c) { return '<th>' + c + '</th>'; }).join('') + '</tr></thead><tbody>' + rows.map(render).join('') + '</tbody></table></div>' : '<div class="faint">None</div>') + '</div>';
      };
      view('<div class="grid cols-2"><div class="card stack"><div class="row">' + avatar(u) + '<div><h2>' + name(u) + '</h2><div class="chips">' + (u.is_suspended ? badge('Suspended', 'bad') : badge('Active', 'ok')) +
        (u.nin_verified ? badge('NIN verified', 'ok') : badge('NIN not verified', 'warn')) + (u.phone_verified ? badge('Phone verified', 'ok') : '') + '</div></div></div>' +
        '<dl class="kv"><dt>Email</dt><dd>' + esc(u.email || '—') + '</dd><dt>Phone</dt><dd>' + esc(u.phone || '—') + '</dd><dt>Role</dt><dd>' + esc(u.role) + '</dd>' +
        '<dt>Rating</dt><dd>' + (u.rating_count ? Number(u.rating_avg).toFixed(1) + ' ★ from ' + u.rating_count : '—') + '</dd><dt>Reports filed</dt><dd>' + esc(j.reportsFiled) + '</dd><dt>User ID</dt><dd class="faint">' + esc(u.id) + '</dd></dl>' +
        '<div class="row">' + (u.nin_verified ? '' : '<button class="btn" id="u-verify">Mark NIN verified</button>') + (u.id === me.id ? '' : u.is_suspended ? '<button class="btn primary" id="u-unsusp">Lift suspension</button>' : '<button class="btn danger" id="u-susp">Suspend account</button>') + '</div></div>' +
        (a ? '<div class="card stack"><h3>Artisan profile</h3><dl class="kv"><dt>Status</dt><dd>' + statusBadge(a.review_status) + '</dd><dt>Skill</dt><dd>' + esc(a.skill_category || '—') + '</dd><dt>Other skills</dt><dd>' + esc((a.additional_skills || []).join(', ') || '—') + '</dd><dt>Areas</dt><dd>' + esc((a.service_areas || []).join(', ') || '—') + '</dd>' + (a.review_note ? '<dt>Last note</dt><dd>' + esc(a.review_note) + '</dd>' : '') + '</dl></div>' : '') +
        table('ID checks', j.verifications, ['Status', 'NIN', 'Match', 'When'], function (v) { return '<tr><td>' + statusBadge(v.status) + '</td><td class="num">••••' + esc(v.nin_last3) + '</td><td>' + (v.confidence != null ? Math.round(v.confidence) + '%' : '—') + '</td><td class="num">' + when(v.created_at) + '</td></tr>'; }) +
        table('Reports against them', j.reportsAgainst, ['Reason', 'Status', 'When'], function (x) { return '<tr><td>' + esc(x.reason) + '</td><td>' + statusBadge(x.status) + '</td><td class="num">' + when(x.created_at) + '</td></tr>'; }) +
        table('Listings', j.properties, ['Title', 'Status', 'Price'], function (p) { return '<tr><td>' + esc(p.title) + '<div class="faint">' + esc(p.area || '') + '</div></td><td>' + statusBadge(p.status) + '</td><td class="num">' + naira(p.price_kobo) + '</td></tr>'; }) +
        table('Bookings', j.bookings, ['Property', 'Status', 'Date', 'Amount'], function (b) { return '<tr><td>' + esc(b.properties && b.properties.title || '—') + '</td><td>' + statusBadge(b.status) + '</td><td class="num">' + when(b.scheduled_at) + '</td><td class="num">' + naira(b.amount_kobo) + '</td></tr>'; }) +
        table('Payments', j.payments, ['Purpose', 'Amount', 'Status', 'Reference', 'When'], function (p) { return '<tr><td>' + esc(p.purpose) + '</td><td class="num">' + naira(p.amount_kobo) + '</td><td>' + statusBadge(p.status) + '</td><td class="faint">' + esc(p.reference) + '</td><td class="num">' + when(p.paid_at || p.created_at) + '</td></tr>'; }) +
        '</div>');
      var v = $('#u-verify'); if (v) v.onclick = function () { ask({ title: 'Mark NIN verified?', body: 'Only after checking their ID document against this account.', confirm: 'Verify' }).then(function (m) { if (m) act(api('/admin/users/' + u.id + '/verify', { method: 'POST' }), 'User verified'); }); };
      var s = $('#u-susp'); if (s) s.onclick = function () { suspendFlow(u.id); };
      var us = $('#u-unsusp'); if (us) us.onclick = function () { act(api('/admin/users/' + u.id + '/suspend', { method: 'POST', body: { suspended: false } }), 'Suspension lifted'); };
    }).catch(fail);
  }

  // Payments
  function pPayments(r) {
    var page = Number(r.q.page || 1);
    shell('payments', 'Payments', 'Every Paystack payment (read-only).');
    var filters = '<form class="row" id="pfilter" style="margin-bottom:14px"><input class="input" name="q" placeholder="Reference" value="' + esc(r.q.q || '') + '">' +
      '<select class="input" name="status"><option value="">Any status</option>' + ['success', 'pending', 'failed', 'refunded'].map(function (x) { return '<option' + (r.q.status === x ? ' selected' : '') + '>' + x + '</option>'; }).join('') + '</select>' +
      '<select class="input" name="purpose"><option value="">Any purpose</option>' + ['inspection', 'subscription', 'rent', 'rentsave', 'job_escrow'].map(function (x) { return '<option' + (r.q.purpose === x ? ' selected' : '') + '>' + x + '</option>'; }).join('') + '</select>' +
      '<button class="btn primary">Filter</button></form>';
    api('/admin/payments' + qs({ q: r.q.q, status: r.q.status, purpose: r.q.purpose, page: page, limit: PAGE })).then(function (j) {
      var list = j.payments || [];
      view(filters + '<div class="card table-wrap">' + (list.length ? '<table><thead><tr><th>When</th><th>Payer</th><th>Purpose</th><th>Amount</th><th>Status</th><th>Channel</th><th>Reference</th></tr></thead><tbody>' + list.map(function (p) {
        return '<tr><td class="num">' + when(p.paid_at || p.created_at) + '</td><td><a href="#/users/' + esc(p.user && p.user.id) + '">' + name(p.user) + '</a></td><td>' + esc(String(p.purpose).replace('_', ' ')) + '</td><td class="num"><b>' + naira(p.amount_kobo) + '</b></td><td>' + statusBadge(p.status) + '</td><td>' + esc(p.channel || '—') + '</td><td class="faint">' + esc(p.reference) + '</td></tr>';
      }).join('') + '</tbody></table>' : '<div class="empty">No payments match.</div>') + '</div>' + pager(page, j.total, r.raw));
      $('#pfilter').onsubmit = function (e) { e.preventDefault(); var f = e.target; location.hash = '#/payments' + qs({ q: f.q.value.trim(), status: f.status.value, purpose: f.purpose.value }); };
    }).catch(fail);
  }

  // Audit log
  function pAudit(r) {
    var page = Number(r.q.page || 1);
    shell('audit', 'Audit log', 'Every admin action, newest first.');
    api('/admin/actions' + qs({ page: page, limit: PAGE })).then(function (j) {
      var list = j.actions || [];
      view('<div class="card">' + actionsTable(list) + '</div>' + pagerMore(page, list.length === PAGE, r.raw));
    }).catch(function (e) { view('<div class="err">' + esc(e.code === 'FEATURE_UNAVAILABLE' ? 'Run migration 011_admin_audit.sql in Supabase to turn on the audit log.' : e.message) + '</div>'); });
  }

  // Keep nav badges fresh without reloading everything.
  setInterval(function () { if (me && document.visibilityState === 'visible') refreshCounts().then(function () {
    document.querySelectorAll('.nav').forEach(function (a) {
      var n = NAV.find(function (x) { return a.getAttribute('href') === '#/' + x[0]; }); if (!n || !n[2]) return;
      var b = a.querySelector('.badge'); var c = counts[n[2]];
      if (c && !b) { a.insertAdjacentHTML('beforeend', '<span class="badge">' + c + '</span>'); } else if (b) { c ? (b.textContent = c) : b.remove(); }
    });
  }).catch(function () {}); }, 60000);

  route();
})();
