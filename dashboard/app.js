// Horizon's dashboard. It reads window.RADAR (written beside dashboard/ by main.ts) and renders a
// sortable, filterable board, a per-protocol detail sheet with the model's own arithmetic and farm
// plan, and a separate live-token view. Query-string deep links (?view=board, ?view=detail&slug=...,
// ?view=filtered&category=...) open each view directly. No framework, no fetch, no network.
(function () {
  'use strict';

  var D = window.RADAR;
  if (!D) return;
  var app = document.getElementById('app');
  var qs = new URLSearchParams(window.location.search);

  var state = {
    view: qs.get('view') || 'board',
    slug: qs.get('slug') || '',
    category: qs.get('category') || 'all',
    q: qs.get('q') || '',
    tab: qs.get('tab') === 'live' ? 'live' : 'pre-token',
    sort: qs.get('sort') || 'rank',
    dir: qs.get('dir') === 'asc' ? 1 : -1
  };
  if (state.sort === 'rank' && qs.get('dir') !== 'asc') state.dir = 1;

  var usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function money(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var a = Math.abs(n);
    if (a >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd0.format(n);
  }
  function pct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function age(d) {
    if (d === null || d === undefined) return 'unknown';
    if (d >= 365) return (d / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(d)) + 'd';
  }
  var clamp = function (v, lo, hi) { return Math.min(hi, Math.max(lo, v)); };

  // The same horizon-1 arithmetic main.ts uses. The page recomputes each row from snapshot figures
  // and shows the result beside board.json's number, so code, data and screenshots visibly agree.
  function impliedOf(r, m) {
    var ch = (r.change_7d === null || r.change_7d === undefined) ? 0 : r.change_7d;
    var growth = 1 + (clamp(ch, m.growth_floor, m.growth_cap) / 100) * m.growth_weight;
    var days = (r.age_days === null || r.age_days === undefined) ? m.unknown_age_days : r.age_days;
    var tenure = m.tenure_floor + m.tenure_gain * (1 - Math.exp(-clamp(days, 0, 36500) / m.tenure_halflife));
    var breadth = 1 + m.breadth_weight * Math.log2(1 + Math.min(r.chains.length, m.chain_cap));
    return Math.max(1, Math.round(r.tvl_usd * m.base_rate * growth * tenure * breadth));
  }

  function node(tag, attrs) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
      else if (k === 'selected' || k === 'open' || k === 'aria-selected') n.setAttribute(k, v === true ? 'true' : v);
      else n.setAttribute(k, v);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      if (Array.isArray(c)) c.forEach(function (x) { if (x) n.appendChild(x); });
      else if (typeof c === 'string' || typeof c === 'number') n.appendChild(document.createTextNode(String(c)));
      else n.appendChild(c);
    }
    return n;
  }

  function syncUrl() {
    var p = new URLSearchParams();
    if (state.view !== 'board') p.set('view', state.view);
    if (state.view === 'detail' && state.slug) p.set('slug', state.slug);
    if (state.category !== 'all') p.set('category', state.category);
    if (state.q) p.set('q', state.q);
    if (state.tab !== 'pre-token') p.set('tab', state.tab);
    if (state.sort !== 'rank') p.set('sort', state.sort);
    if (state.sort !== 'rank' && state.dir === 1) p.set('dir', 'asc');
    var t = p.toString();
    var url = window.location.pathname + (t ? '?' + t : '');
    try { window.history.replaceState(null, '', url); } catch (e) { /* file URLs may refuse; rendering still works */ }
  }

  function visible() {
    var q = state.q.trim().toLowerCase();
    return D.rows.filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category || '', (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  var SORT_VALUE = {
    rank: function (r) { return r.rank; },
    name: function (r) { return r.name.toLowerCase(); },
    tvl: function (r) { return r.tvl_usd; },
    growth: function (r) { return r.change_7d === null ? -Infinity : r.change_7d; },
    value: function (r) { return r.implied_value_usd; }
  };
  function ordered(list) {
    var get = SORT_VALUE[state.sort] || SORT_VALUE.rank;
    return list.slice().sort(function (a, b) {
      var av = get(a), bv = get(b);
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.rank - b.rank;
    });
  }
  function sortHeader(key, label) {
    return node('th', { scope: 'col' },
      node('button', { type: 'button', onclick: function () {
        if (state.sort === key) state.dir = -state.dir;
        else { state.sort = key; state.dir = (key === 'rank' || key === 'name') ? 1 : -1; }
        syncUrl(); render();
      } }, label, state.sort === key ? node('span', { class: 'arrow', text: state.dir === 1 ? ' ↑' : ' ↓' }) : null)
    );
  }

  function masthead() {
    return node('header', { class: 'mast' },
      node('div', { class: 'brand' }, node('span', { class: 'glyph' }), node('b', { text: 'Horizon' }), node('span', { text: '/ token radar' })),
      node('div', { class: 'mast-meta' },
        node('span', {}, 'Snapshot ', node('b', { text: D.as_of })),
        node('span', {}, 'Model ', node('b', { text: D.model_version })),
        node('span', {}, 'Universe ', node('b', { text: '758 protocols' }))
      )
    );
  }

  function hero() {
    return node('section', { class: 'hero' },
      node('div', null,
        node('h1', {}, 'Find the protocols ', node('em', { text: 'before the token' }), '.'),
        node('p', { text: 'The watchlist is a floor, not a ceiling. Every row below is a protocol whose DefiLlama record has no token: ranked by what a claim on it would be worth if its record stood still, with a costed plan to farm it. This is an estimate, not a prediction of a launch.' }),
        node('div', { class: 'tagrow' },
          node('span', { class: 'tag' }, 'Watchlist floor ', node('i', { text: money(D.floor_usd) })),
          node('span', { class: 'tag' }, 'Pre-token only'),
          node('span', { class: 'tag' }, 'No network, sealed snapshot')
        )
      ),
      node('div', { class: 'stats' },
        node('div', { class: 'stat' }, node('div', { class: 'k', text: 'Board rows' }), node('div', { class: 'v a', text: String(D.board_size) })),
        node('div', { class: 'stat' }, node('div', { class: 'k', text: 'Watchlist covered' }), node('div', { class: 'v', text: D.watchlist_size + ' / ' + D.watchlist_size })),
        node('div', { class: 'stat' }, node('div', { class: 'k', text: 'Early finds below floor' }), node('div', { class: 'v c', text: '+' + D.early_size })),
        node('div', { class: 'stat' }, node('div', { class: 'k', text: 'Live tokens set aside' }), node('div', { class: 'v', text: String(D.live_size) }))
      )
    );
  }

  function controls() {
    var cats = Array.from(new Set(D.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var search = node('input', { type: 'search', id: 'q', placeholder: 'Search name, chain or category', value: state.q, 'aria-label': 'Search protocols' });
    search.addEventListener('input', function () {
      state.q = search.value;
      state.view = state.category !== 'all' ? 'filtered' : 'board';
      syncUrl(); render();
      var again = document.getElementById('q');
      if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
    });
    var select = node('select', { id: 'cat', 'aria-label': 'Filter by category' },
      node('option', { value: 'all', text: 'All categories', selected: state.category === 'all' }),
      cats.map(function (c) { return node('option', { value: c, text: c, selected: c === state.category }); })
    );
    select.addEventListener('change', function () {
      state.category = select.value;
      state.view = state.category === 'all' ? 'board' : 'filtered';
      syncUrl(); render();
    });
    var pre = node('button', { type: 'button', 'aria-pressed': state.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token radar', onclick: function () { state.tab = 'pre-token'; state.view = state.category === 'all' ? 'board' : 'filtered'; syncUrl(); render(); } });
    var live = node('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Live tokens', onclick: function () { state.tab = 'live'; state.view = 'board'; syncUrl(); render(); } });
    var chip = state.category === 'all' ? null : node('span', { class: 'chip' }, 'Category: ' + state.category,
      node('button', { type: 'button', 'aria-label': 'Clear category', text: '×', onclick: function () { state.category = 'all'; state.view = 'board'; syncUrl(); render(); } }));
    return node('div', { class: 'bar' },
      node('div', { class: 'field' }, node('label', { for: 'q', text: 'Search' }), search),
      node('div', { class: 'field' }, node('label', { for: 'cat', text: 'Category' }), select),
      node('div', { class: 'field' }, node('label', { text: 'Token status' }), node('div', { class: 'seg' }, pre, live)),
      chip,
      node('span', { class: 'count' }, node('b', { text: String(visible().length) }), ' rows shown')
    );
  }

  function boardTable() {
    var list = ordered(visible());
    if (list.length === 0) return node('div', { class: 'panel' }, node('div', { class: 'empty' },
      node('h2', { text: 'No protocol matches that filter' }),
      node('p', { text: 'Clear the search or choose another category to bring the board back.' }),
      node('button', { class: 'x', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.view = 'board'; syncUrl(); render(); } })
    ));
    var max = list[0].implied_value_usd || 1;
    var body = node('tbody');
    list.forEach(function (r) {
      var gcls = r.change_7d === null ? '' : (r.change_7d >= 0 ? 'pos' : 'neg');
      body.appendChild(node('tr', {
        'aria-selected': state.slug === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        node('td', { class: 'rk' + (r.rank <= 10 ? ' top' : ''), text: String(r.rank).padStart(2, '0') }),
        node('td', null, node('div', { class: 'nm' },
          node('b', { text: r.name }),
          node('small', { text: (r.category || 'Other') + ' · ' + (r.chains.length ? r.chains.slice(0, 3).join(', ') : 'chain unlisted') })
        )),
        node('td', { class: 'mono', text: money(r.tvl_usd) }),
        node('td', { class: 'mono ' + gcls, text: pct(r.change_7d) }),
        node('td', { class: 'mono muted', text: age(r.age_days) }),
        node('td', null, node('div', { class: 'val' },
          node('div', { class: 'meter' }, node('i', { style: 'width:' + Math.max(3, Math.round(r.implied_value_usd / max * 100)) + '%' })),
          node('span', { class: 'amt', text: money(r.implied_value_usd) })
        )),
        node('td', null, node('span', { class: 'badge', text: 'no token' }))
      ));
    });
    return node('div', { class: 'panel' }, node('div', { class: 'scroll' }, node('table', null,
      node('caption', { text: 'Pre-token protocols, strongest implied value first. Sort any column; select a row for its valuation and farm plan.' }),
      node('thead', null, node('tr', null,
        sortHeader('rank', '#'), sortHeader('name', 'Protocol'), sortHeader('tvl', 'TVL'),
        sortHeader('growth', '7d'), node('th', { scope: 'col', text: 'Age' }),
        sortHeader('value', 'Implied value'), node('th', { scope: 'col', text: 'Token' })
      )),
      body
    )));
  }

  function liveTable() {
    var body = node('tbody');
    D.live.forEach(function (r) {
      body.appendChild(node('tr', null,
        node('td', { class: 'rk', text: '—' }),
        node('td', null, node('div', { class: 'nm' }, node('b', { text: r.name }),
          node('small', { text: (r.category || 'Other') + ' · ' + (r.chains.length ? r.chains.slice(0, 3).join(', ') : 'chain unlisted') }))),
        node('td', { class: 'mono', text: money(r.tvl_usd) }),
        node('td', { class: 'mono ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: pct(r.change_7d) }),
        node('td', { class: 'mono', text: money(r.mcap_usd) }),
        node('td', null, node('span', { class: 'badge', text: 'already trades' }))
      ));
    });
    return node('div', { class: 'panel' }, node('div', { class: 'scroll' }, node('table', null,
      node('caption', { text: 'These protocols already have a token on record. The market cap is a fact, not a model, so they are set aside from the launch ranking.' }),
      node('thead', null, node('tr', null, node('th', { text: '#' }), node('th', { text: 'Protocol' }),
        node('th', { text: 'TVL' }), node('th', { text: '7d' }), node('th', { text: 'Market cap' }), node('th', { text: 'Token' }))),
      body
    )));
  }

  function modelStrip() {
    var m = D.model;
    return node('section', { class: 'panel model' },
      node('div', null,
        node('h2', { text: 'How implied value is derived' }),
        node('p', { class: 'sub', text: 'One function scores every row from the snapshot figures. TVL anchors the estimate, seven-day change tilts it, time with no token matures it, and chain breadth widens it. No name is special-cased.' }),
        node('div', { class: 'formula', text: D.formula })
      ),
      node('div', { class: 'legend' },
        node('div', {}, node('span', { text: 'TVL → base rate' }), node('b', { text: m.base_rate })),
        node('div', {}, node('span', { text: '7d change weight' }), node('b', { text: m.growth_weight })),
        node('div', {}, node('span', { text: 'Tenure floor / gain' }), node('b', { text: m.tenure_floor + ' / ' + m.tenure_gain })),
        node('div', {}, node('span', { text: 'Tenure half-life (days)' }), node('b', { text: m.tenure_halflife })),
        node('div', {}, node('span', { text: 'Chain breadth weight' }), node('b', { text: m.breadth_weight })),
        node('div', {}, node('span', { text: 'Unknown age (days)' }), node('b', { text: m.unknown_age_days }))
      )
    );
  }

  function closeDetail() {
    state.view = state.category === 'all' ? 'board' : 'filtered';
    state.slug = '';
    syncUrl(); render();
  }
  function openDetail(slug) {
    var r = D.rows.filter(function (x) { return x.slug === slug; })[0];
    if (!r) return;
    state.slug = slug; state.view = 'detail';
    syncUrl(); render();
  }

  function detailSheet() {
    var r = D.rows.filter(function (x) { return x.slug === state.slug; })[0];
    if (!r) return null;
    var recomputed = impliedOf(r, D.model);
    var steps = r.farm_steps.map(function (s) {
      var at = s.indexOf(' Cost: ');
      var action = at >= 0 ? s.slice(0, at) : s;
      var tail = at >= 0 ? s.slice(at + 1) : '';
      var cAt = tail.indexOf(' Time: ');
      return node('li', null, action, node('div', { class: 'meta' },
        node('span', { text: cAt >= 0 ? tail.slice(0, cAt) : tail }),
        cAt >= 0 ? tail.slice(cAt + 1) : ''
      ));
    });
    var sheet = node('aside', { class: 'sheet', 'aria-label': 'Protocol detail' },
      node('div', { class: 'sheet-head' },
        node('div', null,
          node('div', { class: 'eyebrow', text: 'RANK ' + String(r.rank).padStart(2, '0') + ' / ' + D.board_size + ' · ' + D.model_version }),
          node('h2', { text: r.name }),
          node('p', { class: 'sub', text: (r.category || 'Other') + ' · ' + (r.chains.length ? r.chains.join(', ') : 'chain unlisted') })
        ),
        node('button', { class: 'x', type: 'button', text: 'Close ×', onclick: closeDetail })
      ),
      node('section', { class: 'sect' },
        node('h3', { text: 'Implied value' }),
        node('div', { class: 'hero-val' }, node('b', { text: money(r.implied_value_usd) }), node('span', { class: 'sub', text: 'if the record stood still' })),
        node('div', { class: 'eq' },
          node('div', {}, node('span', { text: 'TVL' }), node('b', { text: money(r.tvl_usd) })),
          node('div', {}, node('span', { text: '7-day TVL change' }), node('b', { class: r.change_7d >= 0 ? 'pos' : 'neg', text: pct(r.change_7d) })),
          node('div', {}, node('span', { text: 'Growth multiplier' }), node('b', { text: r.growth.toFixed(4) })),
          node('div', {}, node('span', { text: 'Time with no token' }), node('b', { text: age(r.age_days) })),
          node('div', {}, node('span', { text: 'Tenure multiplier' }), node('b', { text: r.tenure.toFixed(4) })),
          node('div', {}, node('span', { text: 'Chain breadth multiplier' }), node('b', { text: r.breadth.toFixed(4) })),
          node('div', {}, node('span', { text: 'Page recomputes' }), node('b', { class: recomputed === r.implied_value_usd ? 'pos' : 'neg', text: money(recomputed) }))
        ),
        node('p', { class: 'note', text: recomputed === r.implied_value_usd ? 'The page and board.json compute the same number from the same snapshot figures. A value is a claim, not a price.' : 'The page and board.json disagree: the data would be stale.' })
      ),
      node('section', { class: 'sect' },
        node('h3', { text: 'Farm plan' }),
        node('ol', { class: 'steps' }, steps),
        node('p', { class: 'note', text: 'Steps are generated from this protocol\'s category, chains, TVL and tracked age. Figures are planning estimates: check the protocol\'s own pages before committing funds.' })
      )
    );
    return node('div', null,
      node('div', { class: 'scrim', onclick: closeDetail }),
      sheet
    );
  }

  function render() {
    app.textContent = '';
    var wrap = node('div', { class: 'wrap' }, masthead(), hero(), controls());
    wrap.appendChild(state.tab === 'live' ? liveTable() : boardTable());
    if (state.tab === 'pre-token') wrap.appendChild(modelStrip());
    app.appendChild(wrap);
    var detail = detailSheet();
    if (detail) app.appendChild(detail);
    app.setAttribute('aria-busy', 'false');
  }

  render();
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && state.slug) closeDetail(); });
})();
