// Minimal fetch wrapper: timeout, JSON, retry on transient network errors.
// Inside Electron it goes through net.fetch so the Windows system proxy is
// honored (undici/global fetch ignores it); under plain Node (tests) it
// falls back to global fetch.
'use strict';

let netFetch = null;
try {
  const electron = require('electron');
  if (electron && electron.net && electron.net.fetch) netFetch = electron.net.fetch.bind(electron.net);
} catch { }
const doFetch = netFetch || globalThis.fetch;

const RETRYABLE = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);

async function request(url, opts = {}) {
  const timeoutMs = opts.timeoutMs || 20000;
  const retries = opts.retries == null ? 2 : opts.retries;
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(url, {
        method: opts.method || 'GET',
        headers: opts.headers || {},
        body: opts.body,
        signal: controller.signal,
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
      return { status: res.status, json, text };
    } catch (err) {
      lastErr = err;
      const code = err && (err.cause?.code || err.code || err.name);
      const retryable = RETRYABLE.has(code) || err.name === 'AbortError' || err.name === 'TimeoutError';
      if (attempt < retries && retryable) {
        await sleep(600 * (attempt + 1));
        continue;
      }
      return { status: 0, json: null, text: null, error: err };
    } finally {
      clearTimeout(timer);
    }
  }
  return { status: 0, json: null, text: null, error: lastErr };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function bearer(key) {
  let k = String(key).trim().replace(/^["']+|["']+$/g, '');
  if (k.toLowerCase().startsWith('bearer ')) k = k.slice(7).trim();
  return { Authorization: `Bearer ${k}`, Accept: 'application/json' };
}

module.exports = { request, bearer, sleep };
