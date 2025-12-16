import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { parseStringPromise } from "xml2js";
import * as dotenv from "dotenv";

dotenv.config();

/* ====== ENV ====== */
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const CLOUDFLARE_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

/* ====== DOMAIN / PROXY / UA ====== */
const DOMAINS_MAP = {
  fr: "https://penidadivecenter.fr",
};

const PROXIES = {
  fr: process.env.BRD_PROXY_FR,
};

const USER_AGENTS = {
  fr: "PenidaDiveCenter - CacheWarmer - FR / 1.0",
};

/* ====== UTIL ====== */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cryptoRandomId = () =>
  Math.random().toString(36).slice(2) + Date.now().toString(36);

function extractCfEdge(cfRay) {
  if (typeof cfRay === "string" && cfRay.includes("-")) {
    return cfRay.split("-").pop(); // FRA, CDG, AMS, dll
  }
  return "N/A";
}

function makeSheetNameForRun(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const local = new Date(date.getTime() + 8 * 3600 * 1000);
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(
    local.getUTCDate()
  )}_${pad(local.getUTCHours())}-${pad(local.getUTCMinutes())}-${pad(
    local.getUTCSeconds()
  )}_WITA`;
}

/* ====== LOGGER → GSHEETS ====== */
class AppsScriptLogger {
  constructor() {
    this.rows = [];
    this.runId = cryptoRandomId();
    this.startedAt = new Date().toISOString();
    this.finishedAt = null;
    this.sheetName = makeSheetNameForRun();
  }

  log({
    country = "", // ⬅️ ISI = CF EDGE
    url = "",
    status = "",
    cfCache = "",
    lsCache = "",
    cfRay = "",
    responseMs = "",
    error = 0,
    message = "",
  } = {}) {
    this.rows.push([
      this.runId,
      this.startedAt,
      this.finishedAt,
      country, // EDGE CF
      url,
      status,
      cfCache,
      lsCache,
      cfRay,
      typeof responseMs === "number" ? responseMs : "",
      error ? 1 : 0,
      message,
    ]);
  }

  setFinished() {
    this.finishedAt = new Date().toISOString();
    this.rows = this.rows.map((r) => ((r[2] = this.finishedAt), r));
  }

  async flush() {
    if (!APPS_SCRIPT_URL || this.rows.length === 0) return;

    await axios.post(
      APPS_SCRIPT_URL,
      { sheetName: this.sheetName, rows: this.rows },
      { timeout: 20000, headers: { "Content-Type": "application/json" } }
    );
    this.rows = [];
  }
}

/* ====== HTTP ====== */
function buildAxiosCfg(countryKey, extra = {}) {
  const proxy = PROXIES[countryKey];
  const headers = {
    "User-Agent": USER_AGENTS[countryKey],
    Accept: "application/xml,text/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
    ...extra.headers,
  };

  const cfg = {
    headers,
    timeout: 30000,
    ...extra,
  };

  if (proxy) cfg.httpsAgent = new HttpsProxyAgent(proxy);
  return cfg;
}

async function fetchWithProxy(url, countryKey, timeout = 15000) {
  const res = await axios.get(url, buildAxiosCfg(countryKey, { timeout }));
  return res.data;
}

/* ====== SITEMAP ====== */
async function fetchRobotsSitemaps(domain, countryKey) {
  try {
    const txt = await fetchWithProxy(`${domain}/robots.txt`, countryKey, 10000);
    return String(txt)
      .split(/\r?\n/)
      .filter((l) => /^sitemap:\s*/i.test(l))
      .map((l) => l.split(/:\s*/i)[1].trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function fetchIndexSitemaps(domain, countryKey) {
  const candidates = [
    ...(await fetchRobotsSitemaps(domain, countryKey)),
    `${domain}/sitemap.xml`,
    `${domain}/sitemap_index.xml`,
  ];

  for (const url of [...new Set(candidates)]) {
    try {
      const xml = await fetchWithProxy(url, countryKey);
      const parsed = await parseStringPromise(xml, {
        explicitArray: false,
        ignoreAttrs: true,
      });

      if (parsed?.sitemapindex?.sitemap) {
        const list = Array.isArray(parsed.sitemapindex.sitemap)
          ? parsed.sitemapindex.sitemap
          : [parsed.sitemapindex.sitemap];
        return list.map((e) => e.loc).filter(Boolean);
      }

      if (parsed?.urlset?.url) return [url];
    } catch {}
  }
  return [];
}

async function fetchUrlsFromSitemap(sitemapUrl, countryKey) {
  try {
    const xml = await fetchWithProxy(sitemapUrl, countryKey);
    const parsed = await parseStringPromise(xml, {
      explicitArray: false,
      ignoreAttrs: true,
    });
    const list = parsed?.urlset?.url;
    if (!list) return [];
    return (Array.isArray(list) ? list : [list])
      .map((u) => u.loc)
      .filter(Boolean);
  } catch {
    return [];
  }
}

/* ====== CLOUDFLARE ====== */
async function purgeCloudflareCache(url) {
  if (!CLOUDFLARE_ZONE_ID || !CLOUDFLARE_API_TOKEN) return;

  await axios.post(
    `https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/purge_cache`,
    { files: [url] },
    {
      headers: {
        Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

/* ====== WARMING (LS = TRUTH) ====== */
async function warmUrls(urls, countryKey, logger, batchSize = 1, delay = 2000) {
  const batches = Array.from(
    { length: Math.ceil(urls.length / batchSize) },
    (_, i) => urls.slice(i * batchSize, i * batchSize + batchSize)
  );

  for (const batch of batches) {
    await Promise.all(
      batch.map(async (url) => {
        const t0 = Date.now();
        try {
          const res = await axios.get(
            url,
            buildAxiosCfg(countryKey, { timeout: 15000 })
          );

          const dt = Date.now() - t0;
          const cfCache = res.headers["cf-cache-status"] || "N/A";
          const lsCache = res.headers["x-litespeed-cache"] || "N/A";
          const cfRay = res.headers["cf-ray"] || "N/A";
          const edge = extractCfEdge(cfRay);

          console.log(
            `[${edge}] ${res.status} cf=${cfCache} ls=${lsCache} - ${url}`
          );

          logger.log({
            country: edge,
            url,
            status: res.status,
            cfCache,
            lsCache,
            cfRay,
            responseMs: dt,
          });

          if (String(lsCache).toLowerCase() !== "hit") {
            await purgeCloudflareCache(url);
          }
        } catch (e) {
          logger.log({
            country: "ERROR",
            url,
            error: 1,
            message: e?.message || "request failed",
          });
        }
      })
    );

    await sleep(delay);
  }
}

/* ====== MAIN ====== */
(async () => {
  const logger = new AppsScriptLogger();

  try {
    for (const [countryKey, domain] of Object.entries(DOMAINS_MAP)) {
      const sitemaps = await fetchIndexSitemaps(domain, countryKey);
      const urls = (
        await Promise.all(
          sitemaps.map((s) => fetchUrlsFromSitemap(s, countryKey))
        )
      ).flat();

      await warmUrls(urls, countryKey, logger);
    }
  } finally {
    logger.setFinished();
    await logger.flush();
  }
})();
