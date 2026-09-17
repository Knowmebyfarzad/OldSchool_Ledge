'use strict';

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 10000;

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

function normalizeDigits(str) {
  return String(str).replace(/[۰-۹٠-٩]/g, (ch) => {
    let idx = PERSIAN_DIGITS.indexOf(ch);
    if (idx === -1) idx = ARABIC_DIGITS.indexOf(ch);
    return idx === -1 ? ch : String(idx);
  });
}

// --- Decoding ---------------------------------------------------------------

const SUPPORTED_ENCODINGS = ['utf-8', 'windows-1256', 'utf-16le', 'utf-16be'];

function decodeBuffer(buffer, encoding) {
  const enc = (encoding || 'utf-8').toLowerCase();
  if (!SUPPORTED_ENCODINGS.includes(enc)) {
    throw new Error(`Unsupported encoding: ${encoding}`);
  }
  if (enc === 'utf-16le' || enc === 'utf-16be') {
    // Strip BOM if present; TextDecoder handles the rest.
    const decoder = new TextDecoder(enc);
    return decoder.decode(buffer);
  }
  const decoder = new TextDecoder(enc, { fatal: false });
  let text = decoder.decode(buffer);
  // Strip UTF-8 BOM.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

// --- Delimited parsing --------------------------------------------------------

function detectSeparator(text) {
  const sample = text.split(/\r\n|\r|\n/).slice(0, 5).join('\n');
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (let i = 0; i < sample.length; i++) {
    const ch = sample[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && Object.prototype.hasOwnProperty.call(counts, ch)) {
      counts[ch]++;
    }
  }
  let best = ',';
  let bestCount = -1;
  for (const [sep, count] of Object.entries(counts)) {
    if (count > bestCount) {
      best = sep;
      bestCount = count;
    }
  }
  return bestCount > 0 ? best : ',';
}

// Parses delimited text (handles quotes, escaped "" quotes, and multiline
// quoted fields) into an array of rows, each an array of string cells.
function parseDelimited(text, separator) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === separator) {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\r') {
      i++;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += ch;
    i++;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Drop fully-empty trailing rows.
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c.trim() === '')) {
    rows.pop();
  }

  return rows;
}

// --- Field parsing --------------------------------------------------------

// Rejects scientific notation and currency symbols; accepts up to 2 decimals.
// numberFormat: 'period' (1,234.56) or 'comma' (1.234,56)
function parseAmount(raw, numberFormat) {
  if (raw == null) return null;
  let str = normalizeDigits(String(raw)).trim();
  if (str === '') return null;
  if (/[eE]/.test(str)) return null; // reject scientific notation
  if (/[^\d.,\-+\s]/.test(str)) return null; // reject currency symbols/letters

  let negative = false;
  if (str.startsWith('-')) {
    negative = true;
    str = str.slice(1);
  } else if (str.startsWith('+')) {
    str = str.slice(1);
  }
  str = str.replace(/\s/g, '');

  if (numberFormat === 'comma') {
    str = str.replace(/\./g, '').replace(/,/g, '.');
  } else {
    str = str.replace(/,/g, '');
  }

  if (!/^\d+(\.\d+)?$/.test(str)) return null;
  const parts = str.split('.');
  if (parts[1] && parts[1].length > 2) return null;

  const value = Number(str);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

// dateOrder: 'MDY' | 'DMY' | 'YMD'. Gregorian calendar only.
function parseDate(raw, dateOrder) {
  if (raw == null) return null;
  const str = normalizeDigits(String(raw)).trim();
  if (str === '') return null;

  const match = str.match(/^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})$/);
  if (!match) return null;
  const [, a, b, c] = match;

  let year, month, day;
  if (dateOrder === 'YMD') {
    year = a; month = b; day = c;
  } else if (dateOrder === 'DMY') {
    day = a; month = b; year = c;
  } else {
    month = a; day = b; year = c;
  }

  if (year.length === 2) year = (Number(year) > 50 ? '19' : '20') + year;
  const y = Number(year), m = Number(month), d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1000 || y > 9999) return null;

  const iso = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const test = new Date(iso + 'T00:00:00Z');
  if (test.getUTCFullYear() !== y || test.getUTCMonth() + 1 !== m || test.getUTCDate() !== d) {
    return null;
  }
  return iso;
}

function parseTime(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const str = normalizeDigits(String(raw)).trim();

  let match = str.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|am|pm)?$/);
  if (!match) return null;
  let [, h, m, s, ampm] = match;
  h = Number(h); m = Number(m); s = s ? Number(s) : 0;

  if (ampm) {
    if (h < 1 || h > 12) return null;
    const isPM = ampm.toLowerCase() === 'pm';
    h = h % 12;
    if (isPM) h += 12;
  } else {
    if (h > 23) return null;
  }
  if (m > 59 || s > 59) return null;

  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Preserve leading zeros / text codes exactly as given.
function parseCode(raw) {
  if (raw == null) return '';
  return String(raw).trim();
}

const REQUIRED_FIELDS = ['price', 'recipient', 'date', 'description'];

// mapping: { price, recipient, date, description, time?, code?, bank?, type?, category?, currency? }
//   values are either a column header name, or for bank/type/currency may
//   instead be { default: <value> } to apply a fixed value to every row.
// options: { separator, numberFormat, dateOrder, typeMode, defaultBank,
//            defaultType, currency }
//   typeMode: 'column' | 'expense' | 'income' | 'signed'
function validateAndMapRows(headerRow, dataRows, mapping, options) {
  const headerIndex = {};
  headerRow.forEach((h, i) => { headerIndex[h] = i; });

  const colIndex = (field) => {
    const spec = mapping[field];
    if (spec == null || spec === '') return -1;
    return Object.prototype.hasOwnProperty.call(headerIndex, spec) ? headerIndex[spec] : -1;
  };

  const idx = {
    price: colIndex('price'),
    recipient: colIndex('recipient'),
    date: colIndex('date'),
    description: colIndex('description'),
    time: colIndex('time'),
    code: colIndex('code'),
    bank: colIndex('bank'),
    type: colIndex('type'),
    category: colIndex('category')
  };

  for (const field of REQUIRED_FIELDS) {
    if (idx[field] === -1) {
      return {
        ok: false,
        error: `Required field "${field}" is not mapped to a column.`
      };
    }
  }
  if (options.typeMode === 'column' && idx.type === -1) {
    return { ok: false, error: 'Transaction type column is not mapped.' };
  }
  if ((options.bank == null || options.bank === '') && idx.bank === -1) {
    return { ok: false, error: 'A bank column or default bank is required.' };
  }

  const results = [];
  const seenExact = new Set();
  const seenCodes = new Map(); // "bank|code" -> row detail signature

  dataRows.forEach((row, rowNumber) => {
    const rawPrice = row[idx.price];
    const rawRecipient = row[idx.recipient];
    const rawDate = row[idx.date];
    const rawDescription = row[idx.description];
    const rawTime = idx.time >= 0 ? row[idx.time] : null;
    const rawCode = idx.code >= 0 ? row[idx.code] : null;
    const rawBank = idx.bank >= 0 ? row[idx.bank] : options.bank;
    const rawType = idx.type >= 0 ? row[idx.type] : null;
    const rawCategory = idx.category >= 0 ? row[idx.category] : null;

    const errors = [];

    let amount = parseAmount(rawPrice, options.numberFormat);
    if (amount === null) errors.push('Invalid amount');

    const date = parseDate(rawDate, options.dateOrder);
    if (date === null) errors.push('Invalid date');

    const time = parseTime(rawTime);
    if (rawTime && String(rawTime).trim() !== '' && time === null) {
      errors.push('Invalid time');
    }

    const recipient = (rawRecipient || '').toString().trim();
    if (!recipient) errors.push('Missing recipient');

    const description = (rawDescription || '').toString().trim();
    const bank = (rawBank || '').toString().trim();
    if (!bank) errors.push('Missing bank');

    let type;
    if (options.typeMode === 'column') {
      const t = (rawType || '').toString().trim().toLowerCase();
      if (t === 'income' || t === 'expense') {
        type = t;
      } else {
        errors.push('Invalid or missing transaction type');
      }
    } else if (options.typeMode === 'expense') {
      type = 'expense';
    } else if (options.typeMode === 'income') {
      type = 'income';
    } else if (options.typeMode === 'signed') {
      if (amount !== null) {
        type = amount >= 0 ? 'income' : 'expense';
        amount = Math.abs(amount);
      }
    }

    const code = parseCode(rawCode);
    const category = (rawCategory || '').toString().trim();

    const record = {
      rowNumber,
      price: amount,
      recipient,
      date,
      time,
      description,
      code,
      bank,
      type,
      category,
      currency: options.currency,
      valid: errors.length === 0,
      errors
    };

    if (record.valid) {
      const exactKey = JSON.stringify([record.price, record.recipient, record.date, record.time, record.description, record.code, record.bank, record.type, record.currency]);
      if (seenExact.has(exactKey)) {
        record.duplicate = 'exact';
      } else {
        seenExact.add(exactKey);
      }

      if (record.code) {
        const codeKey = `${record.bank}|${record.code}`;
        const detailSig = JSON.stringify([record.price, record.recipient, record.date, record.description]);
        if (seenCodes.has(codeKey)) {
          if (seenCodes.get(codeKey) !== detailSig) {
            record.valid = false;
            record.errors.push('Bank + tracking code reused with different transaction details');
          }
        } else {
          seenCodes.set(codeKey, detailSig);
        }
      }
    }

    results.push(record);
  });

  return { ok: true, records: results };
}

module.exports = {
  MAX_BYTES,
  MAX_ROWS,
  SUPPORTED_ENCODINGS,
  decodeBuffer,
  detectSeparator,
  parseDelimited,
  parseAmount,
  parseDate,
  parseTime,
  validateAndMapRows
};
