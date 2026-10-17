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

  const res = await attemptAll(url, opts, timeoutMs, retries, doFetch);
  // Electron's network stack honors the system proxy, which makes it the
  // flaky one — a proxy client mid-switch, a dead PAC rule, an IPv6 route
  // nothing else uses. One Node-direct attempt stands in for the user
  // switching proxy off and on again.
  if (res.status === 0 && doFetch === netFetch && globalThis.fetch && !opts.noDirectFallback) {
    return attemptAll(url, opts, timeoutMs, 0, globalThis.fetch);
  }
  return res;
}

async function attemptAll(url, opts, timeoutMs, retries, fetchImpl) {
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
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
