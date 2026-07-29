"use strict";

const crypto = require("node:crypto");
const dns = require("node:dns").promises;
const https = require("node:https");
const net = require("node:net");

const MAXIMUM_RESPONSE_BYTES = 1024 * 1024;
const MAXIMUM_PAGES = 8;
const CRAWL_PATH_PATTERN = /(?:pricing|plans|product|features|solutions|services|industries|customers|case-stud|about|company|blog|resources)/i;
const CTA_PATTERN = /\b(?:get started|start free|try free|book (?:a )?demo|request (?:a )?demo|contact sales|contact us|buy now|shop now|sign up|subscribe|download|learn more|see pricing|view plans|create account|join now)\b/i;
const OFFER_PATTERN = /\b(?:free trial|free plan|money.back|discount|save \d|%\s*off|limited.time|starting at|\$\s?\d|€\s?\d|£\s?\d|per month|\/month|annual plan)\b/i;

function scannerError(message, statusCode = 502, code = "GOODADS_PUBLIC_SCAN_ERROR", retryable = false) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.retryable = retryable;
  return error;
}

function boundedText(value, maximum = 1000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function blockedIpv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return (
    a === 0 || a === 10 || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && c === 2)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224
  );
}

function blockedIp(address) {
  const family = net.isIP(address);
  if (family === 4) return blockedIpv4(address);
  if (family !== 6) return true;
  const normalized = address.toLowerCase().split("%")[0];
  if (normalized.startsWith("::ffff:")) return blockedIpv4(normalized.slice(7));
  return normalized === "::"
    || normalized === "::1"
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || /^fe[89ab]/.test(normalized)
    || normalized.startsWith("ff")
    || normalized.startsWith("2001:db8");
}

async function requirePublicHttpsUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw scannerError("Competitor scan URL is invalid.", 400, "GOODADS_PUBLIC_SCAN_URL_INVALID");
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    throw scannerError(
      "Competitor scans require a public HTTPS website.",
      400,
      "GOODADS_PUBLIC_SCAN_URL_INVALID"
    );
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || hostname === "metadata.google.internal"
  ) {
    throw scannerError("Competitor scan host must be public.", 400, "GOODADS_PUBLIC_SCAN_HOST_BLOCKED");
  }
  const directIp = net.isIP(hostname);
  const addresses = directIp
    ? [{ address: hostname, family: directIp }]
    : await dns.lookup(hostname, { all: true, verbatim: true }).catch(() => []);
  if (!addresses.length || addresses.some((entry) => blockedIp(entry.address))) {
    throw scannerError(
      "Competitor scan host must resolve only to public addresses.",
      400,
      "GOODADS_PUBLIC_SCAN_HOST_BLOCKED"
    );
  }
  return { url, addresses };
}

function pinnedLookup(addresses) {
  return (_hostname, options, callback) => {
    const requestedFamily = Number(options?.family || 0);
    const eligible = requestedFamily ? addresses.filter((entry) => entry.family === requestedFamily) : addresses;
    const selected = eligible[0] || addresses[0];
    if (!selected) return callback(new Error("No validated public address is available."));
    if (options?.all) return callback(null, eligible.length ? eligible : addresses);
    return callback(null, selected.address, selected.family);
  };
}

function requestPinnedPage(resolved, accept) {
  return new Promise((resolve, reject) => {
    const request = https.request({
      protocol: "https:",
      hostname: resolved.url.hostname,
      port: 443,
      method: "GET",
      path: `${resolved.url.pathname}${resolved.url.search}`,
      servername: resolved.url.hostname,
      lookup: pinnedLookup(resolved.addresses),
      headers: {
        Accept: accept,
        "Accept-Encoding": "identity",
        "User-Agent": "GoodAdsCompetitorResearch/1.0 (+https://ads.goodos.app)",
      },
    }, (response) => {
      const declaredLength = Number(response.headers["content-length"] || 0);
      if (declaredLength > MAXIMUM_RESPONSE_BYTES) {
        response.destroy();
        reject(scannerError("Competitor page exceeds the 1 MB scan limit.", 413, "GOODADS_PUBLIC_SCAN_TOO_LARGE"));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAXIMUM_RESPONSE_BYTES) {
          response.destroy(scannerError("Competitor page exceeds the 1 MB scan limit.", 413, "GOODADS_PUBLIC_SCAN_TOO_LARGE"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({
        status: Number(response.statusCode || 0),
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
      response.on("error", reject);
    });
    request.setTimeout(12000, () => request.destroy(
      scannerError("Competitor website timed out.", 502, "GOODADS_PUBLIC_SCAN_TIMEOUT", true)
    ));
    request.on("error", (error) => reject(
      Number.isInteger(error.statusCode)
        ? error
        : scannerError("Competitor website could not be reached.", 502, "GOODADS_PUBLIC_SCAN_UNREACHABLE", true)
    ));
    request.end();
  });
}

function sameCompetitorHost(left, right) {
  const normalize = (value) => String(value || "").toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  const leftHost = normalize(left);
  const rightHost = normalize(right);
  return leftHost === rightHost
    || leftHost.endsWith(`.${rightHost}`)
    || rightHost.endsWith(`.${leftHost}`);
}

async function fetchPublicPage(value, { accept = "text/html,application/xhtml+xml,text/plain", maximumRedirects = 3 } = {}) {
  let resolved = await requirePublicHttpsUrl(value);
  const originalHost = resolved.url.hostname;
  for (let redirect = 0; redirect <= maximumRedirects; redirect += 1) {
    const response = await requestPinnedPage(resolved, accept);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.location;
      if (!location || redirect === maximumRedirects) {
        throw scannerError("Competitor website redirected too many times.", 502, "GOODADS_PUBLIC_SCAN_REDIRECT_INVALID");
      }
      const redirected = new URL(location, resolved.url);
      if (!sameCompetitorHost(originalHost, redirected.hostname)) {
        throw scannerError("Competitor website redirected to a different domain.", 422, "GOODADS_PUBLIC_SCAN_REDIRECT_BLOCKED");
      }
      resolved = await requirePublicHttpsUrl(redirected.toString());
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw scannerError(
        `Competitor website returned HTTP ${response.status}.`,
        502,
        "GOODADS_PUBLIC_SCAN_PROVIDER_REJECTED",
        response.status === 429 || response.status >= 500
      );
    }
    return {
      body: response.body,
      contentType: String(response.headers["content-type"] || "").toLowerCase(),
      sourceUrl: resolved.url.toString(),
      status: response.status,
    };
  }
  throw scannerError("Competitor website could not be loaded.", 502, "GOODADS_PUBLIC_SCAN_UNREACHABLE", true);
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Math.min(Number(code) || 0, 0x10ffff)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Math.min(Number.parseInt(code, 16) || 0, 0x10ffff)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&");
}

function plainText(value, maximum = 1000) {
  return boundedText(
    decodeHtml(String(value || "")
      .replace(/<(?:script|style|noscript|svg)\b[\s\S]*?<\/(?:script|style|noscript|svg)>/gi, " ")
      .replace(/<[^>]+>/g, " ")),
    maximum
  );
}

function attribute(tag, name) {
  const match = String(tag || "").match(new RegExp(`\\b${name}\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))`, "i"));
  return decodeHtml(match?.[1] || match?.[2] || match?.[3] || "");
}

function firstMatch(html, pattern, maximum = 1000) {
  const match = String(html || "").match(pattern);
  return plainText(match?.[1] || "", maximum);
}

function unique(values, limit = 30, maximum = 300) {
  return [...new Set(values.map((value) => boundedText(value, maximum)).filter(Boolean))].slice(0, limit);
}

function absoluteHttpsUrl(value, base) {
  try {
    const url = new URL(value, base);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function metaContent(html, matcher) {
  const tags = String(html || "").match(/<meta\b[^>]*>/gi) || [];
  const match = tags.find((tag) => matcher.test(attribute(tag, "name")) || matcher.test(attribute(tag, "property")));
  return boundedText(attribute(match || "", "content"), 1000);
}

function detectTechnologies(html) {
  const source = String(html || "").toLowerCase();
  const signatures = [
    ["Google Tag Manager", /googletagmanager\.com\/gtm\.js|gtm-[a-z0-9]+/],
    ["Google Analytics", /google-analytics\.com|googletagmanager\.com\/gtag|g-[a-z0-9]{6,}/],
    ["Meta Pixel", /connect\.facebook\.net\/.*fbevents|fbq\s*\(/],
    ["LinkedIn Insight Tag", /snap\.licdn\.com\/li\.lms-analytics|_linkedin_partner_id/],
    ["TikTok Pixel", /analytics\.tiktok\.com|ttq\./],
    ["HubSpot", /js\.hs-scripts\.com|hubspotutk/],
    ["Segment", /cdn\.segment\.com|analytics\.load/],
    ["Hotjar", /static\.hotjar\.com|hj\s*\(/],
    ["Stripe", /js\.stripe\.com|stripe\.com\/v3/],
    ["Shopify", /cdn\.shopify\.com|shopify\.theme/],
    ["WordPress", /wp-content|wp-includes/],
    ["Webflow", /webflow\.js|data-wf-page/],
    ["Wix", /wixstatic\.com|x-wix-/],
    ["Squarespace", /static1\.squarespace\.com|squarespace-cdn/],
    ["Intercom", /widget\.intercom\.io|intercomsettings/],
    ["Drift", /js\.driftt\.com|drift\.load/],
  ];
  return signatures.filter(([, pattern]) => pattern.test(source)).map(([name]) => name);
}

function parseStructuredTypes(html) {
  const scripts = String(html || "").match(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
  const types = [];
  for (const script of scripts.slice(0, 20)) {
    const body = script.replace(/^<script\b[^>]*>/i, "").replace(/<\/script>$/i, "");
    try {
      const walk = (value, depth = 0) => {
        if (!value || depth > 5) return;
        if (Array.isArray(value)) return value.forEach((item) => walk(item, depth + 1));
        if (typeof value !== "object") return;
        const type = value["@type"];
        if (Array.isArray(type)) types.push(...type);
        else if (type) types.push(type);
        Object.values(value).forEach((item) => walk(item, depth + 1));
      };
      walk(JSON.parse(decodeHtml(body)));
    } catch {
      // Invalid publisher JSON-LD is ignored; the raw page fingerprint still records the change.
    }
  }
  return unique(types, 30, 100);
}

function parsePage(html, sourceUrl) {
  const title = firstMatch(html, /<title\b[^>]*>([\s\S]*?)<\/title>/i, 300);
  const headings = unique([
    ...(String(html || "").match(/<h1\b[^>]*>[\s\S]*?<\/h1>/gi) || []).map((item) => plainText(item, 400)),
    ...(String(html || "").match(/<h2\b[^>]*>[\s\S]*?<\/h2>/gi) || []).map((item) => plainText(item, 400)),
  ], 30, 400);
  const interactiveText = [
    ...(String(html || "").match(/<(?:a|button)\b[^>]*>[\s\S]*?<\/(?:a|button)>/gi) || []),
    ...(String(html || "").match(/<input\b[^>]*>/gi) || []).map((tag) => attribute(tag, "value")),
  ].map((item) => plainText(item, 160));
  const callsToAction = unique(interactiveText.filter((item) => CTA_PATTERN.test(item)), 20, 160);
  const bodyText = plainText(html, 25000);
  const offers = unique(
    bodyText.split(/(?<=[.!?])\s+|\s{2,}/).filter((item) => OFFER_PATTERN.test(item)),
    20,
    300
  );
  const linkTags = String(html || "").match(/<a\b[^>]*>/gi) || [];
  const links = unique(linkTags.map((tag) => absoluteHttpsUrl(attribute(tag, "href"), sourceUrl)).filter(Boolean), 250, 2048);
  const socialProfiles = {};
  for (const link of links) {
    const host = new URL(link).hostname.toLowerCase().replace(/^www\./, "");
    const provider = [
      ["facebook.com", "facebook"], ["instagram.com", "instagram"], ["linkedin.com", "linkedin"],
      ["x.com", "x"], ["twitter.com", "x"], ["youtube.com", "youtube"],
      ["tiktok.com", "tiktok"], ["pinterest.com", "pinterest"], ["threads.net", "threads"],
    ].find(([domain]) => host === domain || host.endsWith(`.${domain}`));
    if (provider && !socialProfiles[provider[1]]) socialProfiles[provider[1]] = link;
  }
  const canonicalTag = (String(html || "").match(/<link\b[^>]*rel\s*=\s*["'][^"']*canonical[^"']*["'][^>]*>/i) || [])[0] || "";
  const canonicalUrl = absoluteHttpsUrl(attribute(canonicalTag, "href"), sourceUrl);
  return {
    sourceUrl,
    title,
    description: metaContent(html, /^description$/i),
    canonicalUrl,
    openGraphImage: absoluteHttpsUrl(metaContent(html, /^og:image$/i), sourceUrl),
    headings,
    callsToAction,
    offers,
    technologies: detectTechnologies(html),
    structuredDataTypes: parseStructuredTypes(html),
    socialProfiles,
    forms: (String(html || "").match(/<form\b/gi) || []).length,
    links,
    textFingerprint: crypto.createHash("sha256").update(bodyText).digest("hex"),
  };
}

function parseRobots(text, userAgent = "GoodAdsCompetitorResearch") {
  const groups = [];
  let current = null;
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === "user-agent") {
      if (!current || current.hasRules) {
        current = { agents: [], rules: [], hasRules: false };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (current && (key === "allow" || key === "disallow")) {
      current.hasRules = true;
      if (value) current.rules.push({ type: key, path: value });
    }
  }
  const agent = userAgent.toLowerCase();
  const applicable = groups.filter((group) => group.agents.some((value) => value === "*" || agent.includes(value)));
  return {
    allowed(pathname) {
      const matches = applicable
        .flatMap((group) => group.rules)
        .filter((rule) => pathname.startsWith(rule.path))
        .sort((left, right) => right.path.length - left.path.length);
      return !matches.length || matches[0].type === "allow";
    },
    groups: applicable.length,
  };
}

function aggregatePages(domain, pages, robotsStatus) {
  const socialProfiles = {};
  for (const page of pages) Object.assign(socialProfiles, page.socialProfiles);
  const pageFingerprints = pages.map((page) => `${page.sourceUrl}:${page.textFingerprint}`).sort();
  return {
    methodology: "Direct observations from public pages on the competitor website. These are not traffic estimates.",
    source: {
      provider: "public_web",
      provenance: "public_first_party",
      confidence: "observed",
      domain,
      robots: robotsStatus,
    },
    profile: {
      title: pages[0]?.title || domain,
      description: pages[0]?.description || "",
      headings: unique(pages.flatMap((page) => page.headings), 50, 400),
      callsToAction: unique(pages.flatMap((page) => page.callsToAction), 40, 160),
      offers: unique(pages.flatMap((page) => page.offers), 30, 300),
      technologies: unique(pages.flatMap((page) => page.technologies), 50, 160),
      structuredDataTypes: unique(pages.flatMap((page) => page.structuredDataTypes), 50, 100),
      socialProfiles,
      formCount: pages.reduce((total, page) => total + page.forms, 0),
      openGraphImage: pages[0]?.openGraphImage || null,
    },
    crawl: {
      pageCount: pages.length,
      pages: pages.map((page) => ({
        url: page.sourceUrl,
        title: page.title,
        description: page.description,
        callsToAction: page.callsToAction,
        offers: page.offers,
        forms: page.forms,
      })),
    },
    fingerprint: crypto.createHash("sha256").update(JSON.stringify(pageFingerprints)).digest("hex"),
  };
}

async function scanPublicWebsite(domain) {
  const rootUrl = `https://${domain}/`;
  let robotsStatus = "unavailable";
  let robots = { allowed: () => true, groups: 0 };
  try {
    const response = await fetchPublicPage(`https://${domain}/robots.txt`, {
      accept: "text/plain,*/*;q=0.1",
      maximumRedirects: 2,
    });
    robots = parseRobots(response.body);
    robotsStatus = robots.groups ? "respected" : "no_applicable_rules";
  } catch {
    robotsStatus = "unavailable";
  }
  if (!robots.allowed("/")) {
    throw scannerError("Competitor robots.txt does not permit this public scan.", 409, "GOODADS_PUBLIC_SCAN_ROBOTS_DENIED");
  }
  const home = await fetchPublicPage(rootUrl);
  if (home.contentType && !/(?:text\/html|application\/xhtml\+xml|text\/plain)/.test(home.contentType)) {
    throw scannerError("Competitor homepage is not an HTML page.", 422, "GOODADS_PUBLIC_SCAN_CONTENT_INVALID");
  }
  const homePage = parsePage(home.body, home.sourceUrl);
  const rootHost = new URL(home.sourceUrl).hostname;
  const candidates = unique(
    homePage.links
      .filter((link) => {
        const url = new URL(link);
        return sameCompetitorHost(rootHost, url.hostname)
          && url.pathname !== "/"
          && CRAWL_PATH_PATTERN.test(url.pathname)
          && robots.allowed(url.pathname);
      }),
    MAXIMUM_PAGES - 1,
    2048
  );
  const results = await Promise.allSettled(candidates.map((url) => fetchPublicPage(url)));
  const pages = [homePage];
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    if (result.value.contentType && !/(?:text\/html|application\/xhtml\+xml|text\/plain)/.test(result.value.contentType)) continue;
    pages.push(parsePage(result.value.body, result.value.sourceUrl));
  }
  return aggregatePages(domain, pages, robotsStatus);
}

module.exports = {
  scanPublicWebsite,
  _test: {
    blockedIp,
    parsePage,
    parseRobots,
    aggregatePages,
    sameCompetitorHost,
  },
};
