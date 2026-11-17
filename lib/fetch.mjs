/**
 * HTTP fetching for the Tontonan EPG pipeline.
 *
 * Kept in its own module (no top-level side effects) so it can be
 * unit-tested with node:test against a local HTTP server without running
 * the whole build. build-epg.mjs and the scripts import from here, so
 * there is exactly one User-Agent, one byte-cap discipline, and one
 * retry policy in the repo.
 */
import zlib from "node:zlib";

/* Single User-Agent for every fetch in the repo (build + scripts).
 * Bumped from Chrome/124.0 (mid-2024) to the Nov 2026 stable
 * (157.0.8103.79, 11 Nov 2026) — a stale UA is the kind of thing a
 * bot filter notices. If it goes stale again, bump this one line. */
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.8103.79 Safari/537.36";

/* Error carrying the URL that failed, for the build report. */
export function fetchError(url, message) {
  const e = new Error(`${message} (${url})`);
  e.url = url;
  return e;
}

/* Whether a fetch failure is worth one retry: a 5xx, a timeout, or a
 * connection-level failure (reset, DNS blip). Deliberately NOT retried:
 * 4xx (the server answered; asking again changes nothing), a response
 * over the byte cap (re-downloading it would hit the cap again), and a
 * malformed body. One retry only, after a short backoff — a second
 * failure is recorded and the adapter moves on. */
export function isTransientFetchError(e) {
  if (e?.name === "AbortError") return true; // our own timeout fired
  if (/^HTTP 5\d\d\b/.test(String(e?.message ?? ""))) return true;
  const code = e?.cause?.code ?? e?.code;
  return ["ECONNRESET", "EPIPE", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNABORTED"].includes(code);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Fetch a URL whole, with a timeout and a byte cap.
 *
 * The cap is enforced DURING streaming, not after buffering: the
 * response body is read chunk by chunk and the download is aborted
 * the moment it passes maxBytes, so a feed that lies about (or omits)
 * content-length cannot OOM the runner before the cap trips. The
 * content-length pre-check stays as a cheap early exit for honest
 * servers. (Before this fix the cap was checked only after
 * `await r.arrayBuffer()` had buffered the whole body — the Nov 2026
 * report shows Roku's 37 MB was fully downloaded first.)
 *
 * `retries` (default 1) applies only to transient failures, see
 * isTransientFetchError. */
export async function fetchBuf(url, timeoutMs = 60_000, { maxBytes = Infinity, retries = 1, retryDelayMs = 2000 } = {}) {
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      return await fetchBufOnce(url, timeoutMs, maxBytes);
    } catch (e) {
      // Tag every fetch failure with the URL, so build-report.json can
      // name the failing fetch. (The Nov 2026 epgshare incident was
      // undiagnosable for 2 days precisely because the report recorded
      // only "HTTP 403".)
      if (!e.url) e.url = url;
      if (attempt <= retries && isTransientFetchError(e)) {
        await sleep(retryDelayMs);
        continue;
      }
      throw e;
    }
  }
}

async function fetchBufOnce(url, timeoutMs, maxBytes) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { "User-Agent": USER_AGENT }, redirect: "follow" });
    if (!r.ok) throw fetchError(url, `HTTP ${r.status}`);
    const declared = Number(r.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes)
      throw fetchError(url, `content-length ${declared} exceeds cap ${maxBytes}`);
    if (!r.body) {
      // Defensive fallback (a body-less Response): the old behaviour,
      // still capped — only reachable for synthetic responses.
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > maxBytes) throw fetchError(url, `downloaded ${buf.length} bytes, exceeds cap ${maxBytes}`);
      return buf;
    }
    const reader = r.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw fetchError(url, `downloaded ${total} bytes, exceeds cap ${maxBytes}`);
        }
        chunks.push(Buffer.from(value));
      }
    } catch (e) {
      try {
        await reader.cancel();
      } catch {
        // Already cancelled / destroyed; the original error is the one to report.
      }
      throw e;
    }
    return Buffer.concat(chunks, total);
  } finally {
    clearTimeout(t);
  }
}

/* Gunzip with an output cap; tags errors with the source URL like fetchBuf. */
export function gunzipCapped(gz, maxBytes, url) {
  try {
    return zlib.gunzipSync(gz, { maxOutputLength: maxBytes });
  } catch (e) {
    if (!e.url) e.url = url;
    throw e;
  }
}
