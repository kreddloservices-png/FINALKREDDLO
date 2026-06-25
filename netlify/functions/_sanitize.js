/**
 * _sanitize.js — Shared input sanitization helper
 *
 * Exports pure functions that sanitize free-text user input before it is
 * written to Firestore or forwarded to external APIs (email, Cloudinary, etc.).
 *
 * Usage:
 *   const { sanitizeString, sanitizeEmail, sanitizeUrl, sanitizeInt, sanitizeObject } = require('./_sanitize');
 *
 * What is sanitized: free-text user input — display names, emails, notes,
 *   messages, descriptions, wallet addresses, bank details, review text, etc.
 *
 * What is NOT sanitized: Firestore doc IDs, enum strings (status, currency,
 *   payment method), numeric amounts, booleans, server-generated timestamps.
 *   Those are validated by type-check guards in each function, not here.
 *
 * No new npm dependencies — plain Node.js require()-able module.
 * No changes to any existing function signatures or HTML pages.
 */

'use strict';

/* ── Field length caps (match real-world maximums documented in Fix B spec) ── */
const MAX_LENGTHS = {
  displayName:       80,
  name:              80,
  email:             254,
  bio:               1000,
  description:       1000,
  productTitle:      120,
  productDesc:       5000,
  bankAccountName:   100,
  bankAccountNumber: 30,
  message:           2000,
  note:              2000,
  url:               2048,
  walletAddress:     200,
  invoiceLabel:      200,
};

/* ── HTML-tag regex — strips every tag including self-closing ── */
const HTML_TAG_RE = /<[^>]*>/g;

/* ── Collapse internal whitespace runs ── */
const WHITESPACE_RUN_RE = /\s+/g;

/**
 * sanitizeString(value, maxLength)
 *
 * 1. Returns '' if value is not a string.
 * 2. Strips all HTML tags using /<[^>]*>/g.
 * 3. Trims leading/trailing whitespace.
 * 4. Collapses internal whitespace runs to a single space.
 * 5. Truncates to maxLength characters.
 *
 * @param {*}      value      — Raw user input
 * @param {number} maxLength  — Maximum character length after sanitization
 * @returns {string}
 */
function sanitizeString(value, maxLength) {
  if (typeof value !== 'string') return '';
  const stripped  = value.replace(HTML_TAG_RE, '');
  const trimmed   = stripped.trim();
  const collapsed = trimmed.replace(WHITESPACE_RUN_RE, ' ');
  return collapsed.slice(0, maxLength);
}

/* ── Basic email regex — RFC 5321 simplified, good enough for server-side guard ── */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * sanitizeEmail(value)
 *
 * Calls sanitizeString(value, 254), lowercases, validates the basic email
 * format. Returns null if value is not a valid-looking email.
 *
 * @param {*} value
 * @returns {string|null}
 */
function sanitizeEmail(value) {
  const s = sanitizeString(value, MAX_LENGTHS.email).toLowerCase();
  if (!s || !EMAIL_RE.test(s)) return null;
  return s;
}

/**
 * sanitizeUrl(value, maxLength)
 *
 * Strips HTML tags from value, then validates it begins with https://.
 * Returns null if validation fails or value is not a string.
 *
 * @param {*}      value
 * @param {number} [maxLength=2048]
 * @returns {string|null}
 */
function sanitizeUrl(value, maxLength) {
  const limit = typeof maxLength === 'number' ? maxLength : MAX_LENGTHS.url;
  if (typeof value !== 'string') return null;
  // Strip tags first, then trim
  const stripped = value.replace(HTML_TAG_RE, '').trim();
  if (!stripped.startsWith('https://')) return null;
  return stripped.slice(0, limit);
}

/**
 * sanitizeInt(value, min, max)
 *
 * Parses value to an integer (parseInt) and clamps to [min, max].
 * Returns null if the result is NaN (unparseable).
 *
 * @param {*}      value
 * @param {number} min
 * @param {number} max
 * @returns {number|null}
 */
function sanitizeInt(value, min, max) {
  const n = parseInt(value, 10);
  if (isNaN(n)) return null;
  return Math.min(max, Math.max(min, n));
}

/**
 * sanitizeObject(obj, schema)
 *
 * Applies the appropriate sanitizer to each field in obj according to schema.
 * schema shape: { fieldName: { type, maxLength?, required? } }
 *
 * Supported types: 'string', 'email', 'url', 'int'
 * For 'int' fields, include min and max in the schema entry.
 *
 * Throws a structured { statusCode: 400, message } error if a required field
 * is missing or fails sanitization (sanitized value is '', null, or NaN).
 *
 * Returns an object containing only the fields declared in schema, with their
 * sanitized values.
 *
 * @param {object} obj    — Raw body/payload object
 * @param {object} schema — Field descriptors
 * @returns {object}      — Sanitized fields
 * @throws {{ statusCode: number, message: string }}
 */
function sanitizeObject(obj, schema) {
  const result = {};
  const source = (obj && typeof obj === 'object') ? obj : {};

  for (const [field, descriptor] of Object.entries(schema)) {
    const { type, maxLength, required, min, max } = descriptor;
    const raw = source[field];

    let sanitized;
    switch (type) {
      case 'email':
        sanitized = sanitizeEmail(raw);
        break;
      case 'url':
        sanitized = sanitizeUrl(raw, maxLength);
        break;
      case 'int':
        sanitized = sanitizeInt(raw, min ?? 0, max ?? Number.MAX_SAFE_INTEGER);
        break;
      case 'string':
      default:
        sanitized = sanitizeString(raw, maxLength ?? 2000);
        break;
    }

    const missing = sanitized === null || sanitized === '' || sanitized === undefined;

    if (required && missing) {
      const err = new Error(`Missing or invalid required field: ${field}`);
      err.statusCode = 400;
      throw err;
    }

    result[field] = sanitized;
  }

  return result;
}

module.exports = {
  sanitizeString,
  sanitizeEmail,
  sanitizeUrl,
  sanitizeInt,
  sanitizeObject,
  MAX_LENGTHS,
};
