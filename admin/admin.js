// Field Data Admin — the organisation's view of every collector's saved tests.
//
// Security model: this page holds no secrets. The anon key is public; what an admin can see and
// do is decided by row-level security and SECURITY DEFINER functions in the database, keyed on
// the signed-in account's profiles row. The session is kept in sessionStorage (this tab only), not
// in the localStorage shared by every page on minervapanda.github.io. Every string that came from
// a phone is written with textContent, never innerHTML.
(function () {
  'use strict';
  var URL_ = 'https://frxlazufoztmabdkmdcl.supabase.co';
  var KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZyeGxhenVmb3p0bWFiZGttZGNsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg0NTc0MDUsImV4cCI6MjEwNDAzMzQwNX0.fiYdgoc7HXcHhkrrFUoEoajf9vyonR0G4BdlcWRuVdw';   // public by design; RLS guards the data
  var PAGE = 500;

  var sb = window.supabase.createClient(URL_, KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false,
      storage: window.sessionStorage, storageKey: 'wqt-admin-auth' }
  });

  var me = null, people = {}, rows = [], exhausted = false;

  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k === 'cls') e.className = attrs[k];
      else if (k === 'on') Object.keys(attrs.on).forEach(function (ev) { e.addEventListener(ev, attrs.on[ev]); });
      else e.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c != null) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function show(id, on) { $(id).classList.toggle('hidden', !on); if (on) $('loading').classList.add('hidden'); }
  function fmtTime(t) {
    if (!t) return '—';
    var d = new Date(t);
    return isFinite(d) ? d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
  }
  function num(v, dp) { return (typeof v === 'number' && isFinite(v)) ? v.toFixed(dp) : (v != null && isFinite(+v) ? (+v).toFixed(dp) : '—'); }
  function fail(e) { alert(String((e && e.message) || e)); }

  // ── sign-in ───────────────────────────────────────────────────────────────
  function signedOut(msg) {
    me = null; show('app', false); show('signin', true); $('who').textContent = '';
    $('signinErr').textContent = msg || '';
  }
  // Admin powers in the database require a two-factor session (aal2): app.is_admin() checks the
  // JWT's `aal` claim. So after the password, the page asks for the authenticator code — or, the
  // first time, enrols the authenticator app.
  var mfaFactor = null;
  function needMfa() {
    show('signin', false); show('app', false); show('mfa', true);
    $('mfaErr').textContent = ''; $('mfaCode').value = '';
    return sb.auth.mfa.listFactors().then(function (r) {
      if (r.error) throw r.error;
      var all = (r.data && r.data.all) || [];
      var verified = all.filter(function (f) { return f.factor_type === 'totp' && f.status === 'verified'; })[0];
      if (verified) { mfaFactor = verified.id; show('mfaEnroll', false); show('mfaAsk', true); return; }
      // An enrolment abandoned half-way leaves an unverified factor; clear it and start again.
      return Promise.all(all.filter(function (f) { return f.status !== 'verified'; })
        .map(function (f) { return sb.auth.mfa.unenroll({ factorId: f.id }); }))
        .then(function () { return sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Admin ' + Date.now() }); })
        .then(function (e) {
          if (e.error) throw e.error;
          mfaFactor = e.data.id;
          $('mfaQr').src = e.data.totp.qr_code;
          $('mfaSecret').textContent = e.data.totp.secret;
          show('mfaEnroll', true); show('mfaAsk', false);
        });
    }).then(function () { setTimeout(function () { $('mfaCode').focus(); }, 30); })
      .catch(function (e) { $('mfaErr').textContent = 'Could not start two-step sign-in: ' + e.message; });
  }
  $('mfaBtn').addEventListener('click', function () {
    var code = $('mfaCode').value.replace(/\s/g, '');
    if (!/^\d{6}$/.test(code)) { $('mfaErr').textContent = 'Enter the 6 digits.'; return; }
    $('mfaBtn').disabled = true;
    sb.auth.mfa.challengeAndVerify({ factorId: mfaFactor, code: code }).then(function (r) {
      $('mfaBtn').disabled = false;
      if (r.error) { $('mfaErr').textContent = /invalid|expired/i.test(r.error.message) ? 'That code is wrong or expired. Try the current one.' : r.error.message; return; }
      show('mfa', false);
      return sb.auth.getSession().then(function (s) { return start(s.data.session); });
    });
  });
  $('mfaCode').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('mfaBtn').click(); });
  $('mfaCancel').addEventListener('click', function () {
    sb.auth.signOut().then(function () { show('mfa', false); signedOut(); });
  });

  function start(session) {
    if (!session) return signedOut();
    return sb.from('profiles').select('user_id, role, display_name, username, active').eq('user_id', session.user.id).maybeSingle()
      .then(function (r) {
        if (r.error) throw r.error;
        if (!r.data || r.data.role !== 'admin' || !r.data.active) {
          return sb.auth.signOut().then(function () { signedOut('This account is not an admin. Collectors use Aquasafe or PoolCheck.'); });
        }
        return sb.auth.mfa.getAuthenticatorAssuranceLevel().then(function (a) {
          if (!a.data || a.data.currentLevel !== 'aal2') return needMfa();
          me = r.data;
          var who = $('who'); who.textContent = 'Signed in as ' + me.display_name + ' ';
          who.appendChild(el('button', { type: 'button', cls: 'sec small', text: 'Sign out', on: { click: function () {
            // Global sign-out: also ends the session on the server, not just in this tab.
            sb.auth.signOut().then(function () { signedOut(); });
          } } }));
          show('signin', false); show('mfa', false); show('app', true);
          return loadPeople().then(function () { return loadResults(true); });
        });
      }).catch(function (e) { signedOut('Could not load your profile: ' + e.message); });
  }
  $('signinBtn').addEventListener('click', function () {
    var b = $('signinBtn'); $('signinErr').textContent = '';
    b.disabled = true;
    sb.auth.signInWithPassword({ email: $('email').value.trim().toLowerCase(), password: $('pw').value }).then(function (r) {
      b.disabled = false;
      if (r.error) { $('signinErr').textContent = /Invalid login/i.test(r.error.message) ? 'Email or password is wrong.' : r.error.message; return; }
      $('pw').value = '';
      return start(r.data.session);
    });
  });
  $('pw').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('signinBtn').click(); });

  // ── collectors ────────────────────────────────────────────────────────────
  function loadPeople() {
    return sb.from('collector_summary').select('*').order('display_name').then(function (r) {
      if (r.error) throw r.error;
      people = {};
      var sel = $('fUser'), keep = sel.value;
      while (sel.options.length > 1) sel.remove(1);
      r.data.forEach(function (p) {
        people[p.user_id] = p;
        if (p.role === 'field') sel.appendChild(el('option', { value: p.user_id, text: p.display_name + ' (' + p.username + ')' }));
      });
      sel.value = keep;
      renderPeople(r.data);
    });
  }
  function renderPeople(list) {
    var tb = $('collectors').tBodies[0]; tb.textContent = '';
    var now = Date.now();
    list.forEach(function (p) {
      var silentDays = p.last_test_at ? Math.floor((now - new Date(p.last_test_at)) / 864e5) : null;
      var lastTest = el('td', {}, [fmtTime(p.last_test_at)]);
      if (p.role === 'field' && p.active && (silentDays === null || silentDays >= 3))
        lastTest.appendChild(el('span', { cls: 'flag', text: silentDays === null ? 'no tests yet' : silentDays + ' days quiet' }));
      var actions = el('td');
      if (p.role === 'field') {
        actions.appendChild(el('button', { type: 'button', cls: p.active ? 'danger small' : 'sec small', text: p.active ? 'Switch off' : 'Switch on',
          on: { click: function () { setActive(p, !p.active); } } }));
        actions.appendChild(document.createTextNode(' '));
        actions.appendChild(el('button', { type: 'button', cls: 'sec small', text: 'Reset password', on: { click: function () { resetPw(p); } } }));
        actions.appendChild(document.createTextNode(' '));
        actions.appendChild(el('button', { type: 'button', cls: 'sec small', text: 'Their tests', on: { click: function () {
          $('fUser').value = p.user_id; tab('results'); loadResults(true);
        } } }));
      }
      tb.appendChild(el('tr', {}, [
        el('td', { cls: 'wrap', text: p.display_name }), el('td', { text: p.username }), el('td', { text: p.role }),
        el('td', { text: String(p.tests) }), el('td', { cls: p.problem_tests ? 'v-bad' : '', text: String(p.problem_tests) }),
        lastTest, el('td', { text: fmtTime(p.last_upload_at) }), el('td', { text: fmtTime(p.created_at) }),
        el('td', { cls: p.active ? 'v-ok' : 'v-bad', text: p.active ? 'Active' : 'Switched off' }), actions]));
    });
  }
  function setActive(p, on) {
    if (!confirm((on ? 'Switch ' : 'Switch off ') + p.display_name + ' (' + p.username + ')' + (on ? ' back on?' : '? They are signed out on every phone and cannot upload until switched back on. Their tests stay.'))) return;
    sb.rpc('admin_set_active', { p_user: p.user_id, p_active: on }).then(function (r) {
      if (r.error) return fail(r.error);
      loadPeople();
    });
  }
  function resetPw(p) {
    var body = $('mBody'); body.textContent = '';
    var inp = el('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', maxlength: '72' });
    var gen = Array.prototype.map.call(crypto.getRandomValues(new Uint8Array(6)), function (x) { return 'abcdefghjkmnpqrstuvwxyz23456789'[x % 31]; }).join('');
    inp.value = gen.slice(0, 3) + '-' + gen.slice(3) + '-' + (1000 + (crypto.getRandomValues(new Uint16Array(1))[0] % 9000));
    var msg = el('div', { cls: 'err' });
    body.appendChild(el('h3', { text: 'New password for ' + p.display_name + ' (' + p.username + ')' }));
    body.appendChild(el('p', { cls: 'note', text: 'Give this to the collector in person or by phone. It replaces their old password and signs them out everywhere. At least 8 characters.' }));
    body.appendChild(inp); body.appendChild(msg);
    body.appendChild(el('div', { cls: 'row' }, [el('button', { type: 'button', text: 'Set this password', on: { click: function (e) {
      e.target.disabled = true;
      sb.rpc('admin_reset_password', { p_user: p.user_id, p_password: inp.value }).then(function (r) {
        e.target.disabled = false;
        if (r.error) { msg.textContent = r.error.message; return; }
        msg.className = 'ok-txt'; msg.textContent = 'Done. ' + p.username + ' can now sign in with the new password.';
      });
    } } })]));
    show('modal', true);
  }

  // ── results ───────────────────────────────────────────────────────────────
  var COLS = 'id, user_id, app, kind, captured_at, received_at, clock_suspect, lat, lon, photo_path, body, free_cl, total_cl, voided_at, void_reason, app_version';
  function query(fromRow) {
    var q = sb.from('readings').select(COLS).order('captured_at', { ascending: false }).order('id').range(fromRow, fromRow + PAGE - 1);
    if ($('fUser').value) q = q.eq('user_id', $('fUser').value);
    if ($('fApp').value) q = q.eq('app', $('fApp').value);
    if ($('fFrom').value) q = q.gte('captured_at', new Date($('fFrom').value + 'T00:00:00').toISOString());
    if ($('fTo').value) q = q.lt('captured_at', new Date(new Date($('fTo').value + 'T00:00:00').getTime() + 864e5).toISOString());
    if ($('fProblems').checked) q = q.in('body->>band', ['zero', 'low']);
    if (!$('fVoided').checked) q = q.is('voided_at', null);
    return q;
  }
  function loadResults(reset) {
    if (reset) { rows = []; exhausted = false; }
    return query(rows.length).then(function (r) {
      if (r.error) throw r.error;
      rows = rows.concat(r.data); exhausted = r.data.length < PAGE;
      markRepeats(); renderResults();
      if (reset) renderAlerts();
    }).catch(fail);
  }
  // Same collector, same sample point, within 5 minutes: likely a re-take of the same vial.
  function markRepeats() {
    var by = {};
    rows.forEach(function (x) { x._repeat = false; var k = x.user_id + '|' + site(x).toLowerCase(); (by[k] = by[k] || []).push(x); });
    Object.keys(by).forEach(function (k) {
      var a = by[k].sort(function (p, q) { return new Date(p.captured_at) - new Date(q.captured_at); });
      for (var i = 1; i < a.length; i++) if (new Date(a[i].captured_at) - new Date(a[i - 1].captured_at) < 5 * 60e3) { a[i]._repeat = true; a[i - 1]._repeat = true; }
    });
  }
  // A wrong phone clock, not a late upload: compare the phone's clock at the moment of sending
  // (body.clientSentAt) with the server's receive time. Older uploads without that field fall back
  // to the database's coarse flag, which cannot tell an offline wait from a wrong clock.
  function clockSuspect(x) {
    var sent = x.body && x.body.clientSentAt ? new Date(x.body.clientSentAt) : null;
    if (sent && isFinite(sent)) return Math.abs(new Date(x.received_at) - sent) > 10 * 60e3;
    return !!x.clock_suspect;
  }
  function site(x) { return String((x.body && (x.body.site || x.body.pool)) || '').trim(); }
  function isTotal(x) { return x.total_cl != null || (x.body && (x.body.species === 'total' || String(x.body.reagent).toLowerCase() === 'oto')); }
  function conc(x) { return x.body ? x.body.conc : null; }
  function verdictClass(x) {
    var b = x.body && x.body.band;
    if (b === 'zero' || b === 'low') return 'v-bad';
    if (b === 'vhigh' || b === 'high') return 'v-warn';
    // OTO measures TOTAL chlorine: never rendered as a pass, whatever its band says.
    if (b === 'ok' && !isTotal(x)) return 'v-ok';
    return 'v-grey';
  }
  function testChip(x) {
    var reagent = String((x.body && x.body.reagent) || 'DPD').toUpperCase();
    return isTotal(x) ? el('span', { cls: 'chip total', text: reagent + ' · total' }) : el('span', { cls: 'chip free', text: reagent + ' · free' });
  }
  function renderResults() {
    var tb = $('results').tBodies[0]; tb.textContent = '';
    rows.forEach(function (x) {
      var b = x.body || {};
      var t = el('td', { cls: 'keep' }, [fmtTime(x.captured_at)]);
      if (clockSuspect(x)) t.appendChild(el('span', { cls: 'flag', title: 'The phone\'s clock was more than 10 minutes off when it uploaded this test. Uploaded ' + fmtTime(x.received_at), text: 'clock?' }));
      var who = people[x.user_id];
      var mg = el('td', {}, [el('b', { text: (b.overRange || b.beyond ? '>' : '') + num(conc(x), 2) })]);
      if (b.manual) mg.appendChild(el('span', { cls: 'flag', title: 'Typed from the colour card, not read from a photo', text: 'typed' }));
      if (x._repeat) mg.appendChild(el('span', { cls: 'flag', title: 'Another test by the same collector at the same point within 5 minutes', text: 'repeat?' }));
      var place = el('td');
      if (x.lat != null && x.lon != null) place.appendChild(el('a', { href: 'https://www.google.com/maps?q=' + (+x.lat) + ',' + (+x.lon), target: '_blank', rel: 'noopener noreferrer', text: num(x.lat, 4) + ', ' + num(x.lon, 4) }));
      else place.textContent = '—';
      var ph = el('td');
      ph.appendChild(el('button', { type: 'button', cls: 'sec small', text: x.photo_path ? 'Photo' : 'Details', on: { click: function () { details(x); } } }));
      var act = el('td', { cls: 'keep' });
      if (x.voided_at) act.appendChild(el('span', { cls: 'sub', text: 'Voided: ' + (x.void_reason || '') }));
      else act.appendChild(el('button', { type: 'button', cls: 'danger small', text: 'Void', on: { click: function () { voidRow(x); } } }));
      tb.appendChild(el('tr', { cls: x.voided_at ? 'voided' : '' }, [
        t, el('td', { cls: 'wrap', text: who ? who.display_name : '(unknown)' }), el('td', { text: x.app === 'poolcheck' ? 'PoolCheck' : 'Aquasafe' }),
        el('td', { cls: 'wrap', text: site(x) || '—' }), el('td', {}, [testChip(x)]), mg,
        el('td', { cls: 'wrap ' + verdictClass(x), text: b.bandLabel || b.band || '—' }), place, ph, act]));
    });
    $('summary').textContent = rows.length + ' test(s) shown' + (exhausted ? '' : ' — older ones not loaded yet (the CSV includes them all)') + '. Newest first, by the phone\'s own clock.';
    show('more', !exhausted);
  }
  // Asked of the database directly, not of the rows on screen, so the count is the whole
  // organisation's. "Last 7 days" accepts either clock: a phone with a wrong clock must not hide
  // a zero reading by stamping it in the past.
  function renderAlerts() {
    var box = $('alerts');
    var since = new Date(Date.now() - 7 * 864e5).toISOString();
    return sb.from('readings').select(COLS, { count: 'exact' })
      .is('voided_at', null).in('body->>band', ['zero', 'low'])
      .or('captured_at.gte.' + since + ',received_at.gte.' + since)
      .order('captured_at', { ascending: false }).limit(12)
      .then(function (r) {
        box.textContent = '';
        if (r.error) { box.className = 'card alerts'; box.appendChild(el('div', { cls: 'err', text: 'Could not load alerts: ' + r.error.message })); return; }
        var n = r.count || 0;
        box.className = 'card alerts ' + (n ? 'hot' : 'calm');
        box.appendChild(el('h3', { text: n ? n + ' test(s) in the last 7 days read zero or low chlorine (all collectors)' : 'No zero or low chlorine readings in the last 7 days (all collectors)' }));
        if (!n) return;
        var ul = el('ul');
        r.data.forEach(function (x) {
          var who = people[x.user_id];
          ul.appendChild(el('li', { text: fmtTime(x.captured_at) + ' · ' + (who ? who.display_name : '?') + ' · ' + (site(x) || 'no sample point') + ' · ' +
            num(conc(x), 2) + ' mg/L ' + (isTotal(x) ? '(total, OTO)' : '(free)') + ' · ' + (x.body.bandLabel || x.body.band) }));
        });
        box.appendChild(ul);
        if (n > r.data.length) box.appendChild(el('div', { cls: 'note', text: '…and ' + (n - r.data.length) + ' more. Tick "Only zero / low" to list them all.' }));
      });
  }
  function voidRow(x) {
    var reason = prompt('Why is this test being voided? (e.g. wrong sample point, wrong reagent tab, practice photo). The test is kept and marked void; nothing is deleted.');
    if (reason === null) return;
    if (!reason.trim()) return alert('A reason is required.');
    sb.rpc('void_reading', { p_id: x.id, p_reason: reason }).then(function (r) {
      if (r.error) return fail(r.error);
      loadResults(true); loadPeople();
    });
  }

  // ── details + photo (the GPT review store's check: the stored bytes must hash to the
  //    fingerprint the phone recorded when it saved the test) ─────────────────────────────
  function sha256(buf) {
    return crypto.subtle.digest('SHA-256', buf).then(function (h) {
      return Array.prototype.map.call(new Uint8Array(h), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    });
  }
  var lastObjUrl = null;
  function details(x) {
    var b = x.body || {}, who = people[x.user_id];
    var body = $('mBody'); body.textContent = '';
    body.appendChild(el('h3', { text: (isTotal(x) ? 'Total chlorine (OTO)' : 'Free chlorine') + ' — ' + num(conc(x), 2) + ' mg/L' }));
    if (isTotal(x)) body.appendChild(el('p', { cls: 'note', text: 'OTO measures TOTAL chlorine. It cannot show that free chlorine is adequate, so it is never a pass. Zero total does mean zero free.' }));
    var dl = el('dl');
    function item(k, v) { dl.appendChild(el('dt', { text: k })); dl.appendChild(el('dd', { text: v == null || v === '' ? '—' : String(v) })); }
    item('Collector', who ? who.display_name + ' (' + who.username + ')' : x.user_id);
    item('Tested (phone clock)', fmtTime(x.captured_at)); item('Uploaded', fmtTime(x.received_at));
    item('App', (x.app || '') + ' ' + (x.app_version || '')); item('Sample point', site(x));
    item('Tested by (typed on the phone)', b.operator); item('Use', b.use);
    item('Verdict in the app', b.bandLabel || b.band); item('Read from', b.manual ? 'typed from the colour card' : 'photo');
    item('Cross-check', b.crossCheck); item('Interval', b.concLo != null ? num(b.concLo, 2) + '–' + num(b.concHi, 2) + ' mg/L' : null);
    item('pH / temperature', (b.ph != null ? b.ph : '—') + ' / ' + (b.temp != null ? b.temp + ' °C' : '—'));
    item('GPS', x.lat != null ? num(x.lat, 5) + ', ' + num(x.lon, 5) + (b.acc != null ? ' ±' + Math.round(b.acc) + ' m' : '') : null);
    item('Address (phone lookup)', b.address);
    if (b.backfilled) item('Note', 'Saved on the phone before the collector signed in, uploaded later (no photo).');
    if (b.photo_lost) item('Note', 'The phone lost the photo before it could upload (browser storage cleared).');
    if (x.voided_at) item('Voided', fmtTime(x.voided_at) + ' — ' + (x.void_reason || ''));
    item('Record id', x.id);
    body.appendChild(dl);
    if (x.photo_path) {
      var st = el('div', { cls: 'note', text: 'Loading photo…' });
      body.appendChild(st);
      sb.storage.from('photos').download(x.photo_path).then(function (r) {
        if (r.error) { st.textContent = 'Could not load the photo: ' + r.error.message; return; }
        var blob = r.data;
        if (lastObjUrl) URL.revokeObjectURL(lastObjUrl);
        lastObjUrl = URL.createObjectURL(blob.slice(0, blob.size, 'image/jpeg'));
        body.insertBefore(el('img', { src: lastObjUrl, alt: 'Stamped test photo' }), st);
        return blob.arrayBuffer().then(sha256).then(function (h) {
          if (!b.photo_sha256) { st.textContent = 'No fingerprint was recorded for this photo.'; return; }
          var same = h === b.photo_sha256;
          st.className = same ? 'ok-txt' : 'bad-txt';
          st.textContent = same ? '✓ Fingerprint matches: this is byte-for-byte the photo the phone saved with this test.'
            : '✗ Fingerprint does NOT match what the phone recorded. Treat this photo as unverified.';
        });
      });
    }
    show('modal', true);
  }
  $('mClose').addEventListener('click', function () { show('modal', false); });
  $('modal').addEventListener('click', function (e) { if (e.target === $('modal')) show('modal', false); });

  // ── CSV ───────────────────────────────────────────────────────────────────
  function csvCell(v) {
    var s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s) && !isFinite(+s)) s = "'" + s;   // formula injection; numbers stay numbers
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  $('csv').addEventListener('click', function () {
    // Export every test that matches the filters, not just the page on screen.
    var btn = $('csv'); btn.disabled = true; btn.textContent = 'Preparing…';
    (function more() {
      if (exhausted) return Promise.resolve();
      return query(rows.length).then(function (r) {
        if (r.error) throw r.error;
        rows = rows.concat(r.data); exhausted = r.data.length < PAGE;
        return more();
      });
    })().then(function () { markRepeats(); renderResults(); writeCsv(); }, fail)
      .then(function () { btn.disabled = false; btn.textContent = 'Download CSV'; });
  });
  function writeCsv() {
    var head = ['record_id', 'tested_at_phone_clock', 'uploaded_at', 'clock_suspect', 'collector', 'username', 'app', 'sample_point',
      'operator_typed', 'reagent', 'species', 'chlorine_mg_L', 'free_cl', 'total_cl', 'over_range', 'typed_not_photo', 'verdict_band',
      'verdict_label', 'interval_lo', 'interval_hi', 'ph', 'temp_c', 'lat', 'lon', 'gps_accuracy_m', 'photo_path', 'photo_sha256',
      'possible_repeat', 'voided_at', 'void_reason', 'app_version'];
    var lines = [head.join(',')];
    rows.forEach(function (x) {
      var b = x.body || {}, p = people[x.user_id] || {};
      lines.push([x.id, x.captured_at, x.received_at, clockSuspect(x), p.display_name, p.username, x.app, site(x), b.operator,
        b.reagent, isTotal(x) ? 'total' : 'free', conc(x), x.free_cl, x.total_cl, !!(b.overRange || b.beyond), !!b.manual, b.band,
        b.bandLabel, b.concLo, b.concHi, b.ph, b.temp, x.lat, x.lon, b.acc, x.photo_path, b.photo_sha256, !!x._repeat,
        x.voided_at, x.void_reason, x.app_version].map(csvCell).join(','));
    });
    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = el('a', { href: URL.createObjectURL(blob), download: 'field-tests-' + new Date().toISOString().slice(0, 10) + '.csv' });
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ── tabs + wiring ─────────────────────────────────────────────────────────
  function tab(name) {
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === name); });
    show('tab-results', name === 'results'); show('tab-collectors', name === 'collectors');
    if (name === 'collectors') loadPeople().catch(fail);
  }
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
    b.addEventListener('click', function () { tab(b.getAttribute('data-tab')); });
  });
  $('reload').addEventListener('click', function () { loadResults(true); });
  $('more').addEventListener('click', function () { loadResults(false); });

  sb.auth.getSession().then(function (r) { start(r.data.session); });
})();
