/**
 * HTTP fetching for the Tontonan EPG pipeline.
 *
 * Kept in its own module (no top-level side effects) so it can be
 * unit-tested with node:test against a local HTTP server without running
 * the whole build. Every network fetch in the repo goes through
 * fetchBuf — build-epg.mjs directly, and the scripts via
 * lib/catalog.mjs loadCatalog (scripts/regenerate-matches.mjs also
 * calls fetchBuf directly for --verify-sources) — so there is one
 * User-Agent, one byte-cap discipline, and one retry policy.
 */
import zlib from "node:zlib";

/* Single User-Agent for every fetch in the repo (build + scripts).
 * Bumped from Chrome/124.0 (mid-2024) to the Nov 2026 stable
 * (157.0.8103.79, 11 Nov 2026) — a stale UA is the kind of thing a
 * bot filter notices. If it goes stale again, bump this one line. */
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.8103.79 Safari/537.36";

/* Error carrying the URL that failed, for the build report.
 *
 * `label` (optional) is a display-safe name for a SECRET URL (E2: the
 * epg.best feed URL is a personal token from the EPG_BEST_URL secret).
 * With a label, the error's message and `url` carry the label, never
 * the raw URL — build-report.json is committed to a public repo, and
 * Actions masks secrets only in logs, not in committed files. The raw
 * URL is kept on `fullUrl` (never written to the report) so the
 * console log can still name it for diagnosis. Without a label the
 * behaviour is unchanged: public URLs appear in message and `url`. */
export function fetchError(url, message, label = null) {
  const shown = label ?? url;
  const e = new Error(`${message} (${shown})`);
  e.url = shown;
  if (label) e.fullUrl = url;
  return e;
}

/* Tag a failure with its URL (or, when a label is given, with the
 * label — see fetchError). A labelled error whose message still names
 * the raw URL (e.g. a runtime "Failed to parse URL from ..." TypeError)
 * is replaced by a copy with the URL scrubbed out of the message: some
 * native errors (DOMException) have a read-only message, so the copy
 * is the one safe way to scrub it. */
function tagError(e, url, label) {
  if (!label) {
    if (!e.url) e.url = url;
    return e;
  }
  let out = e;
  const msg = String(e?.message ?? "");
  if (url && msg.includes(url)) {
    out = new Error(msg.split(url).join(label), { cause: e?.cause });
    out.name = e?.name ?? "Error";
    if (e?.code !== undefined) out.code = e.code;
  }
  out.url = label;
  out.fullUrl = url;
  return out;
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
 * isTransientFetchError. `label` names a secret URL safely in errors
 * (see fetchError). */
export async function fetchBuf(url, timeoutMs = 60_000, { maxBytes = Infinity, retries = 1, retryDelayMs = 2000, label = null } = {}) {
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      return await fetchBufOnce(url, timeoutMs, maxBytes, label);
    } catch (err) {
      // Tag every fetch failure with the URL (or its label), so
      // build-report.json can name the failing fetch. (The Nov 2026
      // epgshare incident was undiagnosable for 2 days precisely
      // because the report recorded only "HTTP 403".)
      const e = tagError(err, url, label);
      if (attempt <= retries && isTransientFetchError(e)) {
        await sleep(retryDelayMs);
        continue;
      }
      throw e;
    }
  }
}

async function fetchBufOnce(url, timeoutMs, maxBytes, label) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { "User-Agent": USER_AGENT }, redirect: "follow" });
    if (!r.ok) throw fetchError(url, `HTTP ${r.status}`, label);
    const declared = Number(r.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes)
      throw fetchError(url, `content-length ${declared} exceeds cap ${maxBytes}`, label);
    if (!r.body) {
      // Defensive fallback (a body-less Response): the old behaviour,
      // still capped — only reachable for synthetic responses.
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > maxBytes) throw fetchError(url, `downloaded ${buf.length} bytes, exceeds cap ${maxBytes}`, label);
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
          throw fetchError(url, `downloaded ${total} bytes, exceeds cap ${maxBytes}`, label);
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

/* Gunzip with an output cap; tags errors with the source URL like
 * fetchBuf (or with `label` for a secret URL, see fetchError). */
export function gunzipCapped(gz, maxBytes, url, { label = null } = {}) {
  try {
    return zlib.gunzipSync(gz, { maxOutputLength: maxBytes });
  } catch (e) {
    throw tagError(e, url, label);
  }
}
