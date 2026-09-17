'use strict';

// ---------------------------------------------------------------------------
// State + API helper
// ---------------------------------------------------------------------------

const state = {
  user: null,
  csrfToken: null,
  needsSetup: false
};

async function api(path, options = {}) {
  const opts = {
    method: options.method || 'GET',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }
  };
  if (options.body !== undefined) opts.body = JSON.stringify(options.body);
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(opts.method) && state.csrfToken) {
    opts.headers['X-CSRF-Token'] = state.csrfToken;
  }
  const res = await fetch(path, opts);
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await res.json().catch(() => ({})) : null;
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function apiBlob(path) {
  const res = await fetch(path, { credentials: 'same-origin' });
  if (!res.ok) throw new Error('Request failed');
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') || '';
  const match = cd.match(/filename="([^"]+)"/);
  return { blob, filename: match ? match[1] : 'download' };
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== false && v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function fmtMoney(amount, currency) {
  const n = Number(amount) || 0;
  const symbols = { USD: '$', IRR: 'ریال ', IRT: 'تومان ' };
  const prefix = symbols[currency] ?? '';
  const formatted = n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === 'IRR' || currency === 'IRT' ? `${formatted} ${prefix.trim()}` : `${prefix}${formatted}`;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// App shell + router
// ---------------------------------------------------------------------------

const app = document.getElementById('app');

const ROUTES = [
  { path: '#/dashboard', label: 'Dashboard' },
  { path: '#/transactions', label: 'Transactions' },
  { path: '#/import', label: 'Import CSV' },
  { path: '#/settings', label: 'Settings' }
];

function renderShell(activePath, contentNode) {
  const nav = ROUTES.filter((r) => r.path !== '#/settings' || true).map((r) =>
    el('a', { class: 'nav-item' + (r.path === activePath ? ' active' : ''), href: r.path }, r.label)
  );

  const sidebar = el('div', { class: 'sidebar' }, [
    el('div', { class: 'brand' }, ['Ledger', el('span', { class: 'sub' }, 'Accounting workspace')]),
    ...nav,
    el('div', { class: 'sidebar-foot' }, [
      el('div', { class: 'who' }, state.user ? state.user.name : ''),
      el('div', {}, state.user ? state.user.email : ''),
      el('button', { onclick: doLogout }, 'Sign out')
    ])
  ]);

  const main = el('div', { class: 'main' }, contentNode);
  app.innerHTML = '';
  app.appendChild(el('div', { class: 'shell' }, [sidebar, main]));
}

function renderCentered(node) {
  app.innerHTML = '';
  app.appendChild(el('div', { class: 'auth-wrap' }, node));
}

async function doLogout() {
  try { await api('/api/logout', { method: 'POST' }); } catch {}
  state.user = null;
  state.csrfToken = null;
  location.hash = '#/login';
  await route();
}

// ---------------------------------------------------------------------------
// Setup + Login
// ---------------------------------------------------------------------------

function renderSetup() {
  let error = null;

  function form() {
    const nameInput = el('input', { type: 'text', id: 'su-name', required: 'true' });
    const emailInput = el('input', { type: 'email', id: 'su-email', required: 'true' });
    const passInput = el('input', { type: 'password', id: 'su-pass', required: 'true', minlength: '12' });
    const codeInput = el('input', { type: 'text', id: 'su-code', required: 'true', autocomplete: 'off' });

    const card = el('div', { class: 'auth-card' }, [
      el('h1', {}, 'Create your administrator'),
      el('p', { class: 'lede' }, 'Find the one-time setup code in .data/setup-code.txt on the server, then set up the first account.'),
      error ? el('div', { class: 'error-banner' }, error) : null,
      el('label', {}, 'Setup code'),
      codeInput,
      el('label', {}, 'Your name'),
      nameInput,
      el('label', {}, 'Email'),
      emailInput,
      el('label', {}, 'Password'),
      passInput,
      el('div', { class: 'hint' }, 'At least 12 characters.'),
      el('div', { style: 'margin-top:18px' }, [
        el('button', {
          class: 'btn primary',
          onclick: async () => {
            error = null;
            try {
              const data = await api('/api/setup', {
                method: 'POST',
                body: {
                  code: codeInput.value.trim(),
                  name: nameInput.value.trim(),
                  email: emailInput.value.trim(),
                  password: passInput.value
                }
              });
              state.user = data.user;
              await refreshMe();
              location.hash = '#/dashboard';
              await route();
            } catch (err) {
              error = err.message;
              renderCentered(form());
            }
          }
        }, 'Create administrator')
      ])
    ]);
    return card;
  }

  renderCentered(form());
}

function renderLogin() {
  let error = null;

  function form() {
    const emailInput = el('input', { type: 'email', id: 'li-email', required: 'true' });
    const passInput = el('input', { type: 'password', id: 'li-pass', required: 'true' });

    const submit = async () => {
      error = null;
      try {
        const data = await api('/api/login', {
          method: 'POST',
          body: { email: emailInput.value.trim(), password: passInput.value }
        });
        state.user = data.user;
        await refreshMe();
        location.hash = '#/dashboard';
        await route();
      } catch (err) {
        error = err.message;
        renderCentered(form());
      }
    };

    passInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

    return el('div', { class: 'auth-card' }, [
      el('h1', {}, 'Sign in'),
      el('p', { class: 'lede' }, 'Sign in to your accounting workspace.'),
      error ? el('div', { class: 'error-banner' }, error) : null,
      el('label', {}, 'Email'),
      emailInput,
      el('label', {}, 'Password'),
      passInput,
      el('div', { style: 'margin-top:18px' }, [
        el('button', { class: 'btn primary', onclick: submit }, 'Sign in')
      ])
    ]);
  }

  renderCentered(form());
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function svgLineChart(points, width = 640, height = 200) {
  if (points.length === 0) {
    return el('div', { class: 'empty-state' }, 'No transactions yet this month.');
  }
  const pad = { l: 50, r: 16, t: 16, b: 28 };
  const values = points.map((p) => p.net);
  let running = 0;
  const cumulative = values.map((v) => (running += v));
  const min = Math.min(0, ...cumulative);
  const max = Math.max(0, ...cumulative);
  const range = max - min || 1;

  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;
  const stepX = points.length > 1 ? innerW / (points.length - 1) : 0;

  const coords = cumulative.map((v, i) => {
    const x = pad.l + i * stepX;
    const y = pad.t + innerH - ((v - min) / range) * innerH;
    return [x, y];
  });

  const pathD = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const zeroY = pad.t + innerH - ((0 - min) / range) * innerH;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', '100%');
  svg.style.maxWidth = width + 'px';

  const zeroLine = document.createElementNS(svg.namespaceURI, 'line');
  zeroLine.setAttribute('x1', pad.l); zeroLine.setAttribute('x2', width - pad.r);
  zeroLine.setAttribute('y1', zeroY); zeroLine.setAttribute('y2', zeroY);
  zeroLine.setAttribute('stroke', 'var(--line-strong)');
  zeroLine.setAttribute('stroke-dasharray', '3,3');
  svg.appendChild(zeroLine);

  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', pathD);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'var(--accent)');
  path.setAttribute('stroke-width', '2');
  svg.appendChild(path);

  coords.forEach(([x, y]) => {
    const c = document.createElementNS(svg.namespaceURI, 'circle');
    c.setAttribute('cx', x); c.setAttribute('cy', y); c.setAttribute('r', '2.5');
    c.setAttribute('fill', 'var(--accent)');
    svg.appendChild(c);
  });

  [min, max].forEach((v) => {
    const y = pad.t + innerH - ((v - min) / range) * innerH;
    const t = document.createElementNS(svg.namespaceURI, 'text');
    t.setAttribute('x', 4); t.setAttribute('y', y + 4);
    t.setAttribute('font-size', '10'); t.setAttribute('fill', 'var(--ink-soft)');
    t.textContent = Math.round(v).toLocaleString();
    svg.appendChild(t);
  });

  return el('div', { class: 'chart-wrap' }, svg);
}

function svgBarBreakdown(items, width = 640) {
  if (items.length === 0) return el('div', { class: 'empty-state' }, 'No expenses recorded this month.');
  const barH = 22, gap = 10, pad = { l: 130, r: 60, t: 6 };
  const height = pad.t + items.length * (barH + gap);
  const max = Math.max(...items.map((i) => i.amount), 1);
  const innerW = width - pad.l - pad.r;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', '100%');
  svg.style.maxWidth = width + 'px';

  items.forEach((item, i) => {
    const y = pad.t + i * (barH + gap);
    const w = (item.amount / max) * innerW;

    const label = document.createElementNS(svg.namespaceURI, 'text');
    label.setAttribute('x', pad.l - 10); label.setAttribute('y', y + barH / 2 + 4);
    label.setAttribute('text-anchor', 'end'); label.setAttribute('font-size', '12');
    label.setAttribute('fill', 'var(--ink)');
    label.textContent = item.category;
    svg.appendChild(label);

    const rect = document.createElementNS(svg.namespaceURI, 'rect');
    rect.setAttribute('x', pad.l); rect.setAttribute('y', y);
    rect.setAttribute('width', Math.max(w, 2)); rect.setAttribute('height', barH);
    rect.setAttribute('fill', 'var(--negative)'); rect.setAttribute('opacity', '0.78');
    svg.appendChild(rect);

    const value = document.createElementNS(svg.namespaceURI, 'text');
    value.setAttribute('x', pad.l + w + 8); value.setAttribute('y', y + barH / 2 + 4);
    value.setAttribute('font-size', '12'); value.setAttribute('fill', 'var(--ink-soft)');
    value.textContent = item.amount.toLocaleString();
    svg.appendChild(value);
  });

  return el('div', { class: 'chart-wrap' }, svg);
}

async function renderDashboard() {
  renderShell('#/dashboard', el('div', {}, 'Loading…'));
  let dash;
  try {
    dash = await api('/api/dashboard');
  } catch (err) {
    return renderShell('#/dashboard', el('div', { class: 'error-banner' }, err.message));
  }

  const content = el('div', {}, [
    el('div', { class: 'page-head' }, [el('h1', {}, 'Dashboard')]),
    el('div', { class: 'stat-row' }, [
      el('div', { class: 'stat' }, [
        el('div', { class: 'label' }, 'Cash balance'),
        el('div', { class: 'value num' }, fmtMoney(dash.cashBalance, dash.currency))
      ]),
      el('div', { class: 'stat' }, [
        el('div', { class: 'label' }, 'Income this month'),
        el('div', { class: 'value num pos' }, fmtMoney(dash.monthIncome, dash.currency))
      ]),
      el('div', { class: 'stat' }, [
        el('div', { class: 'label' }, 'Expenses this month'),
        el('div', { class: 'value num neg' }, fmtMoney(dash.monthExpense, dash.currency))
      ]),
      el('div', { class: 'stat' }, [
        el('div', { class: 'label' }, 'Net this month'),
        el('div', { class: 'value num' + (dash.monthNet >= 0 ? ' pos' : ' neg') }, fmtMoney(dash.monthNet, dash.currency))
      ])
    ]),
    el('div', { class: 'panel' }, [
      el('h2', {}, 'Cash flow this month'),
      svgLineChart(dash.cashFlow)
    ]),
    el('div', { class: 'panel' }, [
      el('h2', {}, 'Spending by category'),
      svgBarBreakdown(dash.spendingBreakdown)
    ])
  ]);

  renderShell('#/dashboard', content);
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

let txnState = { version: null, currency: 'USD', filters: { q: '', from: '', to: '', category: '' } };

async function renderTransactions() {
  renderShell('#/transactions', el('div', {}, 'Loading…'));
  await loadAndRenderTransactions();
}

async function loadAndRenderTransactions() {
  const params = new URLSearchParams();
  if (txnState.filters.q) params.set('q', txnState.filters.q);
  if (txnState.filters.from) params.set('from', txnState.filters.from);
  if (txnState.filters.to) params.set('to', txnState.filters.to);
  if (txnState.filters.category) params.set('category', txnState.filters.category);

  let data;
  try {
    data = await api('/api/transactions?' + params.toString());
  } catch (err) {
    renderShell('#/transactions', el('div', { class: 'error-banner' }, err.message));
    return;
  }
  txnState.version = data.version;
  txnState.currency = data.currency;

  const qInput = el('input', { type: 'text', placeholder: 'Search recipient, description, bank…', value: txnState.filters.q, class: 'grow' });
  qInput.addEventListener('input', debounce(() => { txnState.filters.q = qInput.value; loadAndRenderTransactions(); }, 300));

  const fromInput = el('input', { type: 'date', value: txnState.filters.from });
  fromInput.addEventListener('change', () => { txnState.filters.from = fromInput.value; loadAndRenderTransactions(); });
  const toInput = el('input', { type: 'date', value: txnState.filters.to });
  toInput.addEventListener('change', () => { txnState.filters.to = toInput.value; loadAndRenderTransactions(); });

  const rows = data.transactions.map((t) => el('tr', {}, [
    el('td', {}, t.date),
    el('td', {}, t.recipient),
    el('td', {}, t.description),
    el('td', {}, t.category || '—'),
    el('td', {}, t.bank),
    el('td', { class: 'num amount ' + t.type }, (t.type === 'expense' ? '-' : '+') + fmtMoney(t.price, t.currency)),
    el('td', { class: 'row-actions' }, [
      el('button', { onclick: () => openTransactionModal(t) }, 'Edit'),
      el('button', { onclick: () => deleteTransaction(t) }, 'Delete')
    ])
  ]));

  const table = data.transactions.length === 0
    ? el('div', { class: 'empty-state' }, 'No transactions match. Add one, or import a CSV.')
    : el('div', { class: 'table-scroll' }, el('table', {}, [
        el('thead', {}, el('tr', {}, ['Date', 'Recipient', 'Description', 'Category', 'Bank', 'Amount', ''].map((h, i) =>
          el('th', { class: i === 5 ? 'num' : '' }, h)))),
        el('tbody', {}, rows)
      ]));

  const content = el('div', {}, [
    el('div', { class: 'page-head' }, [
      el('h1', {}, 'Transactions'),
      el('button', { class: 'btn primary', onclick: () => openTransactionModal(null) }, 'Add transaction')
    ]),
    el('div', { class: 'toolbar' }, [qInput, fromInput, toInput]),
    table
  ]);

  renderShell('#/transactions', content);
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function openTransactionModal(existing) {
  const isEdit = !!existing;
  let error = null;

  const priceInput = el('input', { type: 'text', value: existing ? String(existing.price) : '' });
  const typeSelect = el('select', {}, [
    el('option', { value: 'expense', selected: !existing || existing.type === 'expense' }, 'Expense'),
    el('option', { value: 'income', selected: existing && existing.type === 'income' }, 'Income')
  ]);
  const dateInput = el('input', { type: 'date', value: existing ? existing.date : todayIso() });
  const recipientInput = el('input', { type: 'text', value: existing ? existing.recipient : '' });
  const descInput = el('input', { type: 'text', value: existing ? existing.description : '' });
  const categoryInput = el('input', { type: 'text', value: existing ? existing.category : '' });
  const bankInput = el('input', { type: 'text', value: existing ? existing.bank : '' });
  const codeInput = el('input', { type: 'text', value: existing ? existing.code || '' : '' });

  const close = () => document.querySelector('.modal-backdrop')?.remove();

  const save = async () => {
    error = null;
    const transaction = {
      price: priceInput.value,
      type: typeSelect.value,
      date: dateInput.value,
      recipient: recipientInput.value,
      description: descInput.value,
      category: categoryInput.value,
      bank: bankInput.value,
      code: codeInput.value,
      currency: txnState.currency
    };
    try {
      if (isEdit) {
        await api(`/api/transactions/${existing.id}`, { method: 'PUT', body: { transaction, version: txnState.version } });
      } else {
        await api('/api/transactions', { method: 'POST', body: { transaction, version: txnState.version } });
      }
      close();
      await loadAndRenderTransactions();
    } catch (err) {
      error = err.message;
      renderModalBody();
    }
  };

  let modalNode;
  function renderModalBody() {
    const body = el('div', { class: 'modal' }, [
      el('h2', {}, isEdit ? 'Edit transaction' : 'Add transaction'),
      error ? el('div', { class: 'error-banner' }, error) : null,
      el('div', { class: 'field-row' }, [
        el('div', {}, [el('label', {}, 'Type'), typeSelect]),
        el('div', {}, [el('label', {}, 'Amount'), priceInput])
      ]),
      el('div', { class: 'field-row' }, [
        el('div', {}, [el('label', {}, 'Date'), dateInput]),
        el('div', {}, [el('label', {}, 'Bank'), bankInput])
      ]),
      el('label', {}, 'Recipient'),
      recipientInput,
      el('label', {}, 'Description'),
      descInput,
      el('div', { class: 'field-row' }, [
        el('div', {}, [el('label', {}, 'Category'), categoryInput]),
        el('div', {}, [el('label', {}, 'Tracking / reference code'), codeInput])
      ]),
      el('div', { class: 'modal-close-row' }, [
        el('button', { class: 'btn ghost', onclick: close }, 'Cancel'),
        el('button', { class: 'btn primary', onclick: save }, isEdit ? 'Save changes' : 'Add transaction')
      ])
    ]);
    if (modalNode) modalNode.replaceWith(body);
    modalNode = body;
    return body;
  }

  const backdrop = el('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(); } }, renderModalBody());
  document.body.appendChild(backdrop);
}

async function deleteTransaction(t) {
  if (!confirm(`Delete the transaction with ${t.recipient} on ${t.date}?`)) return;
  try {
    await api(`/api/transactions/${t.id}`, { method: 'DELETE', body: { version: txnState.version } });
    await loadAndRenderTransactions();
  } catch (err) {
    alert(err.message);
  }
}

// ---------------------------------------------------------------------------
// CSV Import wizard
// ---------------------------------------------------------------------------

const importState = {
  step: 1,
  file: null,
  fileBase64: null,
  encoding: 'utf-8',
  separator: null,
  headers: [],
  mapping: { price: '', recipient: '', date: '', description: '', time: '', code: '', bank: '', type: '', category: '' },
  options: { numberFormat: 'period', dateOrder: 'YMD', typeMode: 'column', bank: '', currency: 'USD' },
  previewResult: null
};

function resetImportState() {
  importState.step = 1;
  importState.file = null;
  importState.fileBase64 = null;
  importState.headers = [];
  importState.previewResult = null;
}

async function renderImport() {
  renderShell('#/import', buildImportWizard());
}

function stepIndicator() {
  const labels = ['Upload', 'Map columns', 'Review', 'Done'];
  return el('div', { class: 'steps' }, labels.map((l, i) =>
    el('span', { class: i + 1 === importState.step ? 'current' : '' }, `${i + 1}. ${l}`)
  ));
}

function buildImportWizard() {
  const wrap = el('div', {}, [
    el('div', { class: 'page-head' }, el('h1', {}, 'Import CSV')),
    stepIndicator()
  ]);

  if (importState.step === 1) wrap.appendChild(importStepUpload());
  else if (importState.step === 2) wrap.appendChild(importStepMapping());
  else if (importState.step === 3) wrap.appendChild(importStepReview());
  else wrap.appendChild(importStepDone());

  return wrap;
}

function importStepUpload() {
  let error = null;
  const fileInput = el('input', { type: 'file', accept: '.csv,.tsv,text/csv,text/tab-separated-values' });
  const encodingSelect = el('select', {}, [
    el('option', { value: 'utf-8' }, 'UTF-8 (default)'),
    el('option', { value: 'windows-1256' }, 'Windows-1256 (Arabic/Persian)'),
    el('option', { value: 'utf-16le' }, 'UTF-16 LE'),
    el('option', { value: 'utf-16be' }, 'UTF-16 BE')
  ]);

  const next = async () => {
    error = null;
    const file = fileInput.files[0];
    if (!file) { error = 'Choose a CSV or TSV file.'; return renderShell('#/import', buildImportWizard()); }
    if (file.size > 5 * 1024 * 1024) { error = 'File exceeds the 5 MB limit.'; return renderShell('#/import', buildImportWizard()); }

    const buffer = await file.arrayBuffer();
    const base64 = arrayBufferToBase64(buffer);
    importState.file = file;
    importState.fileBase64 = base64;
    importState.encoding = encodingSelect.value;

    try {
      const data = await api('/api/import/csv/preview', { method: 'POST', body: { fileBase64: base64, encoding: importState.encoding } });
      importState.headers = data.headers;
      importState.separator = data.separator;
      importState.rowCount = data.rowCount;
      importState.step = 2;
      renderShell('#/import', buildImportWizard());
    } catch (err) {
      error = err.message;
      renderShell('#/import', buildImportWizard());
    }
  };

  return el('div', { class: 'panel' }, [
    error ? el('div', { class: 'error-banner' }, error) : null,
    el('label', {}, 'CSV or TSV file (max 5 MB, 10,000 rows)'),
    fileInput,
    el('label', {}, 'Encoding'),
    encodingSelect,
    el('div', { style: 'margin-top:18px' }, el('button', { class: 'btn primary', onclick: next }, 'Continue'))
  ]);
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function importStepMapping() {
  let error = null;
  const fields = [
    ['price', 'Amount', true], ['recipient', 'Recipient', true], ['date', 'Date', true],
    ['description', 'Description / reason', true], ['time', 'Time', false],
    ['code', 'Tracking / reference code', false], ['bank', 'Bank', false], ['category', 'Category', false]
  ];

  const headerOptions = (current) => [
    el('option', { value: '' }, '— not in file —'),
    ...importState.headers.map((h) => el('option', { value: h, selected: h === current }, h))
  ];

  const mappingSelects = {};
  const mappingGrid = el('div', { class: 'mapping-grid' }, fields.map(([key, label, required]) => {
    const sel = el('select', {}, headerOptions(importState.mapping[key]));
    sel.addEventListener('change', () => { importState.mapping[key] = sel.value; });
    mappingSelects[key] = sel;
    return el('div', {}, [el('label', {}, label + (required ? ' (required)' : '')), sel]);
  }));

  const typeModeSelect = el('select', {}, [
    el('option', { value: 'column', selected: importState.options.typeMode === 'column' }, 'A column marks income vs expense'),
    el('option', { value: 'expense', selected: importState.options.typeMode === 'expense' }, 'Every row is an expense'),
    el('option', { value: 'income', selected: importState.options.typeMode === 'income' }, 'Every row is income'),
    el('option', { value: 'signed', selected: importState.options.typeMode === 'signed' }, 'Positive = income, negative = expense')
  ]);
  typeModeSelect.addEventListener('change', () => { importState.options.typeMode = typeModeSelect.value; renderShell('#/import', buildImportWizard()); });

  const typeColumnSelect = el('select', {}, headerOptions(importState.mapping.type));
  typeColumnSelect.addEventListener('change', () => { importState.mapping.type = typeColumnSelect.value; });

  const numberFormatSelect = el('select', {}, [
    el('option', { value: 'period', selected: importState.options.numberFormat === 'period' }, '1,234.56 (period decimal)'),
    el('option', { value: 'comma', selected: importState.options.numberFormat === 'comma' }, '1.234,56 (comma decimal)')
  ]);
  numberFormatSelect.addEventListener('change', () => { importState.options.numberFormat = numberFormatSelect.value; });

  const dateOrderSelect = el('select', {}, [
    el('option', { value: 'YMD', selected: importState.options.dateOrder === 'YMD' }, 'Year-Month-Day'),
    el('option', { value: 'DMY', selected: importState.options.dateOrder === 'DMY' }, 'Day-Month-Year'),
    el('option', { value: 'MDY', selected: importState.options.dateOrder === 'MDY' }, 'Month-Day-Year')
  ]);
  dateOrderSelect.addEventListener('change', () => { importState.options.dateOrder = dateOrderSelect.value; });

  const defaultBankInput = el('input', { type: 'text', value: importState.options.bank, placeholder: 'e.g. Bank Melli — used if no bank column is mapped' });
  defaultBankInput.addEventListener('input', () => { importState.options.bank = defaultBankInput.value; });

  const currencySelect = el('select', {}, [
    el('option', { value: 'USD', selected: importState.options.currency === 'USD' }, 'USD'),
    el('option', { value: 'IRR', selected: importState.options.currency === 'IRR' }, 'IRR (rials)'),
    el('option', { value: 'IRT', selected: importState.options.currency === 'IRT' }, 'IRT (tomans)')
  ]);
  currencySelect.addEventListener('change', () => { importState.options.currency = currencySelect.value; });

  const back = () => { importState.step = 1; renderShell('#/import', buildImportWizard()); };
  const next = async () => {
    error = null;
    for (const [key, , required] of fields) {
      if (required && !importState.mapping[key]) {
        error = `Map a column for "${key}".`;
        return renderShell('#/import', buildImportWizard());
      }
    }
    if (importState.options.typeMode === 'column' && !importState.mapping.type) {
      error = 'Map the transaction-type column, or choose a different type option.';
      return renderShell('#/import', buildImportWizard());
    }
    if (!importState.mapping.bank && !importState.options.bank.trim()) {
      error = 'Map a bank column or enter a default bank.';
      return renderShell('#/import', buildImportWizard());
    }
    try {
      const data = await api('/api/import/csv/preview', {
        method: 'POST',
        body: {
          fileBase64: importState.fileBase64,
          encoding: importState.encoding,
          separator: importState.separator,
          mapping: importState.mapping,
          options: importState.options
        }
      });
      importState.previewResult = data;
      importState.step = 3;
      renderShell('#/import', buildImportWizard());
    } catch (err) {
      error = err.message;
      renderShell('#/import', buildImportWizard());
    }
  };

  return el('div', { class: 'panel' }, [
    error ? el('div', { class: 'error-banner' }, error) : null,
    el('p', { class: 'hint' }, `${importState.rowCount} rows detected. English and Persian headers are both supported — map whichever columns your file has.`),
    mappingGrid,
    el('label', {}, 'Transaction type'),
    typeModeSelect,
    importState.options.typeMode === 'column' ? el('div', {}, [el('label', {}, 'Type column'), typeColumnSelect]) : null,
    el('div', { class: 'field-row' }, [
      el('div', {}, [el('label', {}, 'Number format'), numberFormatSelect]),
      el('div', {}, [el('label', {}, 'Date order (Gregorian)'), dateOrderSelect])
    ]),
    el('div', { class: 'field-row' }, [
      el('div', {}, [el('label', {}, 'Default bank (if no bank column)'), defaultBankInput]),
      el('div', {}, [el('label', {}, 'Currency for this import'), currencySelect])
    ]),
    el('div', { style: 'margin-top:18px; display:flex; gap:10px' }, [
      el('button', { class: 'btn ghost', onclick: back }, 'Back'),
      el('button', { class: 'btn primary', onclick: next }, 'Review import')
    ])
  ]);
}

function importStepReview() {
  const r = importState.previewResult;
  const blocked = r.stage === 'blocked';

  const previewRows = r.preview.map((row) => el('tr', {}, [
    el('td', {}, String(row.rowNumber + 1)),
    el('td', {}, row.valid ? 'OK' : 'Error'),
    el('td', {}, (row.errors || []).join('; ')),
    el('td', {}, row.date || ''),
    el('td', {}, row.recipient || ''),
    el('td', { class: 'num' }, row.price != null ? row.price.toFixed(2) : ''),
    el('td', {}, row.type || '')
  ]));

  const downloadReport = async () => {
    const { blob, filename } = await apiBlob(`/api/import/csv/report/${r.token}`);
    downloadBlob(blob, filename);
  };

  const back = () => { importState.step = 2; renderShell('#/import', buildImportWizard()); };
  const commit = async () => {
    try {
      const workspace = await api('/api/workspace');
      const data = await api('/api/import/csv/commit', { method: 'POST', body: { token: r.token, version: workspace.version } });
      importState.doneMessage = `Imported ${data.imported} transactions.`;
      importState.step = 4;
      renderShell('#/import', buildImportWizard());
    } catch (err) {
      alert(err.message);
    }
  };

  return el('div', { class: 'panel' }, [
    blocked
      ? el('div', { class: 'error-banner' }, `${r.invalidCount} of ${r.totalRows} rows have errors. Fix your file or the mapping, then re-upload. Nothing has been imported.`)
      : el('div', { class: 'notice' }, `${r.totalRows} rows validated. ${r.willImport} will be imported (${r.duplicateExact} exact duplicate${r.duplicateExact === 1 ? '' : 's'} skipped). Nothing is added until you click Import.`),
    el('div', { style: 'margin:10px 0' }, el('button', { class: 'btn ghost small', onclick: downloadReport }, 'Download full validation report')),
    el('div', { class: 'table-scroll' }, el('table', {}, [
      el('thead', {}, el('tr', {}, ['Row', 'Status', 'Errors', 'Date', 'Recipient', 'Amount', 'Type'].map((h) => el('th', {}, h)))),
      el('tbody', {}, previewRows)
    ])),
    el('p', { class: 'hint' }, `Showing first ${r.preview.length} of ${r.totalRows} rows. The full validation report covers every row.`),
    el('div', { style: 'margin-top:18px; display:flex; gap:10px' }, [
      el('button', { class: 'btn ghost', onclick: back }, 'Back'),
      blocked ? null : el('button', { class: 'btn primary', onclick: commit }, 'Import transactions')
    ])
  ]);
}

function importStepDone() {
  return el('div', { class: 'panel' }, [
    el('div', { class: 'notice' }, importState.doneMessage || 'Import complete.'),
    el('div', { style: 'margin-top:14px; display:flex; gap:10px' }, [
      el('a', { class: 'btn primary', href: '#/transactions' }, 'View transactions'),
      el('button', { class: 'btn ghost', onclick: () => { resetImportState(); renderShell('#/import', buildImportWizard()); } }, 'Import another file')
    ])
  ]);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function renderSettings() {
  renderShell('#/settings', el('div', {}, 'Loading…'));
  const content = el('div', {});
  content.appendChild(el('div', { class: 'page-head' }, el('h1', {}, 'Settings')));
  content.appendChild(await accountPanel());
  if (state.user.role === 'admin') {
    content.appendChild(await usersPanel());
  }
  content.appendChild(await workspacePanel());
  content.appendChild(backupPanel());
  renderShell('#/settings', content);
}

async function accountPanel() {
  let error = null, success = null;
  const currentInput = el('input', { type: 'password', autocomplete: 'current-password' });
  const newInput = el('input', { type: 'password', autocomplete: 'new-password', minlength: '12' });

  const panel = el('div', { class: 'panel' }, [
    el('h2', {}, 'Your account'),
    el('p', {}, `Signed in as ${state.user.name} (${state.user.email}), role: ${state.user.role}.`),
    el('label', {}, 'Current password'),
    currentInput,
    el('label', {}, 'New password (at least 12 characters)'),
    newInput,
    el('div', { style: 'margin-top:14px' }, el('button', {
      class: 'btn',
      onclick: async () => {
        try {
          await api('/api/account/change-password', { method: 'POST', body: { currentPassword: currentInput.value, newPassword: newInput.value } });
          await renderSettings();
        } catch (err) {
          alert(err.message);
        }
      }
    }, 'Change password'))
  ]);
  return panel;
}

async function usersPanel() {
  const data = await api('/api/users');
  const rows = data.users.map((u) => el('tr', {}, [
    el('td', {}, u.name),
    el('td', {}, u.email),
    el('td', {}, el('span', { class: 'badge' + (u.role === 'admin' ? ' role-admin' : '') }, u.role)),
    el('td', {}, u.disabled ? el('span', { class: 'badge disabled' }, 'disabled') : 'active'),
    el('td', { class: 'row-actions' }, [
      u.id !== state.user.id ? el('button', {
        onclick: async () => {
          await api(`/api/users/${u.id}/${u.disabled ? 'enable' : 'disable'}`, { method: 'POST' });
          await renderSettings();
        }
      }, u.disabled ? 'Enable' : 'Disable') : null,
      el('button', { onclick: () => promptResetPassword(u) }, 'Reset password')
    ])
  ]));

  const nameInput = el('input', { type: 'text' });
  const emailInput = el('input', { type: 'email' });
  const roleSelect = el('select', {}, [el('option', { value: 'member' }, 'Member'), el('option', { value: 'admin' }, 'Admin')]);
  const tempPassInput = el('input', { type: 'text', placeholder: 'Temporary password (12+ chars)' });

  const createUser = async () => {
    try {
      await api('/api/users', {
        method: 'POST',
        body: { name: nameInput.value.trim(), email: emailInput.value.trim(), role: roleSelect.value, tempPassword: tempPassInput.value }
      });
      await renderSettings();
    } catch (err) {
      alert(err.message);
    }
  };

  return el('div', { class: 'panel' }, [
    el('h2', {}, 'Users and access'),
    el('div', { class: 'table-scroll' }, el('table', {}, [
      el('thead', {}, el('tr', {}, ['Name', 'Email', 'Role', 'Status', ''].map((h) => el('th', {}, h)))),
      el('tbody', {}, rows)
    ])),
    el('h2', { style: 'margin-top:22px' }, 'Create user'),
    el('div', { class: 'field-row' }, [
      el('div', {}, [el('label', {}, 'Name'), nameInput]),
      el('div', {}, [el('label', {}, 'Email'), emailInput])
    ]),
    el('div', { class: 'field-row' }, [
      el('div', {}, [el('label', {}, 'Role'), roleSelect]),
      el('div', {}, [el('label', {}, 'Temporary password'), tempPassInput])
    ]),
    el('div', { style: 'margin-top:14px' }, el('button', { class: 'btn', onclick: createUser }, 'Create user'))
  ]);
}

async function promptResetPassword(user) {
  const pass = prompt(`New temporary password for ${user.name} (at least 12 characters):`);
  if (!pass) return;
  try {
    await api(`/api/users/${user.id}/reset-password`, { method: 'POST', body: { tempPassword: pass } });
    alert('Password reset. Share it with the user privately — they must replace it before opening their books.');
  } catch (err) {
    alert(err.message);
  }
}

async function workspacePanel() {
  const ws = await api('/api/workspace');
  const currencySelect = el('select', {}, ['USD', 'IRR', 'IRT'].map((c) => el('option', { value: c, selected: c === ws.currency }, c)));
  const openingInput = el('input', { type: 'text', value: String(ws.openingBalance) });

  const save = async () => {
    try {
      await api('/api/workspace', { method: 'PUT', body: { currency: currencySelect.value, openingBalance: openingInput.value, version: ws.version } });
      await renderSettings();
    } catch (err) {
      alert(err.message);
    }
  };

  const clearBooks = async () => {
    if (!confirm('This clears all your transactions and budgets. Export a backup first. Continue?')) return;
    try {
      await api('/api/workspace/clear', { method: 'POST', body: { version: ws.version } });
      await renderSettings();
    } catch (err) {
      alert(err.message);
    }
  };

  return el('div', { class: 'panel' }, [
    el('h2', {}, 'Workspace'),
    ws.transactionCount > 0 ? el('p', { class: 'hint' }, 'Currency can only be changed on empty books. Export a backup and clear books first.') : null,
    el('div', { class: 'field-row' }, [
      el('div', {}, [el('label', {}, 'Currency'), currencySelect]),
      el('div', {}, [el('label', {}, 'Opening balance'), openingInput])
    ]),
    el('div', { style: 'margin-top:14px; display:flex; gap:10px' }, [
      el('button', { class: 'btn', onclick: save }, 'Save'),
      el('button', { class: 'btn danger', onclick: clearBooks }, 'Clear books')
    ])
  ]);
}

function backupPanel() {
  const exportCsv = async () => { const { blob, filename } = await apiBlob('/api/export/csv'); downloadBlob(blob, filename); };
  const exportJson = async () => { const { blob, filename } = await apiBlob('/api/export/json'); downloadBlob(blob, filename); };

  const fileInput = el('input', { type: 'file', accept: '.json,application/json' });
  const restore = async () => {
    const file = fileInput.files[0];
    if (!file) return alert('Choose a JSON backup file first.');
    try {
      const text = await file.text();
      const backup = JSON.parse(text);
      const data = await api('/api/import/json', { method: 'POST', body: { backup } });
      alert(`Restored ${data.imported} transactions.`);
      await renderSettings();
    } catch (err) {
      alert(err.message);
    }
  };

  return el('div', { class: 'panel' }, [
    el('h2', {}, 'Backups'),
    el('div', { style: 'display:flex; gap:10px; margin-bottom:18px' }, [
      el('button', { class: 'btn ghost', onclick: exportCsv }, 'Export CSV'),
      el('button', { class: 'btn ghost', onclick: exportJson }, 'Export JSON backup')
    ]),
    el('label', {}, 'Restore JSON backup (requires empty books)'),
    fileInput,
    el('div', { style: 'margin-top:10px' }, el('button', { class: 'btn', onclick: restore }, 'Restore backup'))
  ]);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function refreshMe() {
  const data = await api('/api/me');
  state.user = data.user;
  state.csrfToken = data.csrfToken;
}

async function route() {
  let status;
  try {
    status = await api('/api/status');
  } catch {
    app.innerHTML = '<div class="auth-wrap"><div class="auth-card"><h1>Connection error</h1><p class="lede">Could not reach the server.</p></div></div>';
    return;
  }

  if (status.needsSetup) {
    renderSetup();
    return;
  }

  if (!state.user) {
    try {
      await refreshMe();
    } catch {
      renderLogin();
      return;
    }
  }

  const hash = location.hash || '#/dashboard';
  if (hash === '#/login') { location.hash = '#/dashboard'; return; }

  if (hash.startsWith('#/transactions')) await renderTransactions();
  else if (hash.startsWith('#/import')) await renderImport();
  else if (hash.startsWith('#/settings')) await renderSettings();
  else await renderDashboard();
}

window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', route);
