const DEFAULT_TIMEOUT_MS = 30_000;
const HARD_MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BODY_CHARS = 32_000;
const HARD_MAX_BODY_CHARS = 200_000;
const MAX_REDIRECTS = 5;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

export function clampHttpTimeout(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.floor(n), HARD_MAX_TIMEOUT_MS);
}

export function clampHttpMaxBody(n) {
  if (n === undefined || n === null || n === "") {
    return DEFAULT_MAX_BODY_CHARS;
  }
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) {
    return HARD_MAX_BODY_CHARS;
  }
  return Math.min(Math.max(Math.floor(v), 1), HARD_MAX_BODY_CHARS);
}

/**
 * Parse and validate a URL. Loopback-only unless allowPublic.
 */
export function parseHttpUrl(url, { allowPublic = false } = {}) {
  if (typeof url !== "string" || !url.trim()) {
    throw new Error("url is required.");
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Only http and https URLs are allowed (got ${parsed.protocol}).`);
  }
  if (!allowPublic && !isLoopbackHostname(parsed.hostname)) {
    throw new Error(
      `http_request is locked to loopback (localhost, 127.0.0.1, ::1) by default. ` +
        `Got host "${parsed.hostname}". Pass allow_public=true for other hosts.`,
    );
  }
  return parsed;
}

export function isLoopbackHostname(hostname) {
  const host = String(hostname || "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  return LOOPBACK_HOSTS.has(host);
}

export function isLoopbackUrl(url) {
  try {
    return isLoopbackHostname(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * HTTP request helper for local lab servers (Ollama, mlx-vlm, etc.).
 * Follows redirects only while the destination remains allowed.
 */
export async function httpRequest({
  method = "GET",
  url,
  headers = {},
  json,
  body,
  timeoutMs,
  maxBodyChars,
  allowPublic = false,
} = {}) {
  const started = Date.now();
  const timeout = clampHttpTimeout(timeoutMs);
  const maxBody = clampHttpMaxBody(maxBodyChars);
  const verb = String(method || "GET").toUpperCase();
  if (!/^[A-Z]+$/.test(verb) || verb.length > 16) {
    throw new Error(`Invalid HTTP method: ${method}`);
  }

  let current = parseHttpUrl(url, { allowPublic }).href;
  let response;
  let redirects = 0;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    while (true) {
      const init = {
        method: verb,
        headers: normalizeHeaders(headers),
        signal: controller.signal,
        redirect: "manual",
      };

      if (json !== undefined && json !== null) {
        init.body = typeof json === "string" ? json : JSON.stringify(json);
        if (!hasHeader(init.headers, "content-type")) {
          init.headers["content-type"] = "application/json";
        }
      } else if (body !== undefined && body !== null) {
        init.body = typeof body === "string" ? body : String(body);
      }

      try {
        response = await fetch(current, init);
      } catch (error) {
        if (error && error.name === "AbortError") {
          throw new Error(`http_request timed out after ${timeout}ms (${verb} ${current}).`);
        }
        throw new Error(`http_request failed: ${error.message || error}`);
      }

      if (isRedirect(response.status)) {
        const location = response.headers.get("location");
        if (!location || redirects >= MAX_REDIRECTS) {
          break;
        }
        const next = new URL(location, current);
        parseHttpUrl(next.href, { allowPublic });
        current = next.href;
        redirects += 1;
        continue;
      }
      break;
    }

    const raw = await response.text();
    const truncated = raw.length > maxBody;
    const text = truncated ? raw.slice(0, maxBody) : raw;
    let parsedJson = null;
    const contentType = response.headers.get("content-type") || "";
    if (/\bjson\b/i.test(contentType) || looksLikeJson(text)) {
      try {
        parsedJson = JSON.parse(text);
      } catch {
        parsedJson = null;
      }
    }

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      url: response.url || current,
      redirected: redirects > 0,
      redirects,
      headers: pickHeaders(response.headers),
      body: text,
      json: parsedJson,
      truncated,
      bodyChars: raw.length,
      returnedChars: text.length,
      elapsedMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function formatHttpResult(result) {
  const headerLines = [
    `[http ${result.status} ${result.statusText} elapsed_ms=${result.elapsedMs} url=${result.url}` +
      `${result.redirected ? ` redirects=${result.redirects}` : ""}` +
      `${result.truncated ? ` truncated=true body_chars=${result.bodyChars}` : ""}]`,
  ];
  const body =
    result.json !== null
      ? JSON.stringify(result.json, null, 2)
      : result.body || "(empty body)";
  return `${headerLines.join("\n")}\n\n${body}`;
}

function normalizeHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null) {
      continue;
    }
    out[String(key)] = String(value);
  }
  return out;
}

function hasHeader(headers, name) {
  const want = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === want);
}

function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function looksLikeJson(text) {
  const trimmed = String(text || "").trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function pickHeaders(headers) {
  const names = [
    "content-type",
    "content-length",
    "location",
    "cache-control",
    "www-authenticate",
  ];
  const out = {};
  for (const name of names) {
    const value = headers.get(name);
    if (value) {
      out[name] = value;
    }
  }
  return out;
}
