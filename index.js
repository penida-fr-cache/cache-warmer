// cachewarmer_tw_gsheets.js
import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { parseStringPromise } from "xml2js";
import * as dotenv from "dotenv";

dotenv.config();

/* ====== ENV WAJIB (LOG KE GSHEETS) ====== */
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL; // URL Web App GAS (/exec)

/* ====== KONFIG DOMAIN/PROXY/UA ====== */
const DOMAINS_MAP = {
  fr: "https://penidadivecenter.fr",
};

const PROXIES = {
  fr: process.env.BRD_PROXY_FR, // boleh kosong
};

// UA browser-like agar tidak mudah diblokir WAF/CDN
const USER_AGENTS = {
  fr: "PenidaDiveCenter - CacheWarmer - FR / 1.0",
};

/* ====== CLOUDFLARE (opsional) ====== */
const CLOUDFLARE_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

/* ====== UTIL ====== */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cryptoRandomId = () =>
  Math.random().toString(36).slice(2) + Date.now().toString(36);

/** Nama tab per-run: YYYY-MM-DD_HH-mm-ss_WITA (tanpa +0800) */
function makeSheetNameForRun(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const local = new Date(date.getTime() + 8 * 3600 * 1000); // WITA +08
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(
    local.getUTCDate()
  )}_${pad(local.getUTCHours())}-${pad(local.getUTCMinutes())}-${pad(
    local.getUTCSeconds()
  )}_WITA`;
}

/* ====== LOGGER → APPS SCRIPT (BATCH PER-RUN) ====== */
class AppsScriptLogger {
  constructor() {
    this.rows = [];
    this.runId = cryptoRandomId();
    this.startedAt = new Date().toISOString();
    this.finishedAt = null;
    this.sheetName = makeSheetNameForRun(); // satu tab per-run
  }

  log({
    country = "",
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
      this.runId, // run_id
      this.startedAt, // started_at (ISO)
      this.finishedAt, // finished_at (diisi saat finalize)
      country, // country
      url, // url
      status, // status code
      cfCache, // cf_cache
      lsCache, // vercel_cache (dipakai utk LiteSpeed)
      cfRay, // cf_ray
      typeof responseMs === "number" ? responseMs : "", // response_ms
      error ? 1 : 0, // error (0/1)
      message, // message
    ]);
  }

  setFinished() {
    this.finishedAt = new Date().toISOString();
    this.rows = this.rows.map((r) => ((r[2] = this.finishedAt), r));
  }

  async flush() {
    if (!APPS_SCRIPT_URL) {
      console.warn("Apps Script logging disabled (missing APPS_SCRIPT_URL).");
      return;
    }
    if (this.rows.length === 0) return;

    try {
      const res = await axios.post(
        APPS_SCRIPT_URL,
        { sheetName: this.sheetName, rows: this.rows },
        { timeout: 20000, headers: { "Content-Type": "application/json" } }
      );
      console.log("Apps Script response:", res.status, res.data);
      if (!res.data?.ok) console.warn("Apps Script replied error:", res.data);
      this.rows = []; // bersihkan buffer
    } catch (e) {
      console.warn(
        "Apps Script logging error:",
        e?.response?.status,
        e?.response?.data || e?.message || e
      );
    }
  }
}

/* ====== HTTP helper (dgn/tnp proxy) ====== */
function buildAxiosCfg(country, extra = {}) {
  const proxy = PROXIES[country];
  const headers = {
    "User-Agent": USER_AGENTS[country],
    Accept: "application/xml,text/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
    ...extra.headers,
  };

  const cfg = {
    headers,
    timeout: 30000,
    ...extra,
  };

  // Proxy opsional — hanya set agent jika ada
  if (proxy) {
    cfg.httpsAgent = new HttpsProxyAgent(proxy);
  }

  return cfg;
}

async function fetchWithProxy(url, country, timeout = 15000) {
  const cfg = buildAxiosCfg(country, { timeout });
  const res = await axios.get(url, cfg);
  return res.data;
}

/* ====== SITEMAP UTIL ====== */
async function fetchRobotsSitemaps(domain, country) {
  try {
    const txt = await fetchWithProxy(`${domain}/robots.txt`, country, 10000);
    return String(txt)
      .split(/\r?\n/)
      .filter((l) => /^sitemap:\s*/i.test(l))
      .map((l) => l.split(/:\s*/i)[1].trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Mengembalikan daftar URL sitemap (bisa sitemap index atau langsung urlset)
 * - Coba robots.txt
 * - Coba beberapa kandidat umum: wp-sitemap.xml, sitemap.xml, sitemap_index.xml
 */
async function fetchIndexSitemaps(domain, country) {
  const candidates = [
    ...(await fetchRobotsSitemaps(domain, country)),
    `${domain}/sitemap.xml`,
    `${domain}/sitemap_index.xml`,
  ];

  // Hilangkan duplikat
  const uniqueCandidates = [...new Set(candidates)];

  for (const url of uniqueCandidates) {
    try {
      const xml = await fetchWithProxy(url, country, 15000);
      const parsed = await parseStringPromise(xml, {
        explicitArray: false,
        ignoreAttrs: true,
      });

      // Jika sitemap index
      if (parsed?.sitemapindex?.sitemap) {
        const list = Array.isArray(parsed.sitemapindex.sitemap)
          ? parsed.sitemapindex.sitemap
          : [parsed.sitemapindex.sitemap];
        const locs = list.map((e) => e.loc).filter(Boolean);
        if (locs.length) return locs;
      }

      // Jika langsung urlset (single sitemap berisi URL)
      if (parsed?.urlset?.url) {
        return [url];
      }
    } catch (err) {
      console.warn(
        `[${country}] ⚠️ sitemap candidate failed ${url}: ${
          err?.message || err
        }`
      );
    }
  }

  console.warn(`[${country}] ❌ No sitemap found via robots/candidates`);
  return [];
}

async function fetchUrlsFromSitemap(sitemapUrl, country) {
  try {
    const xml = await fetchWithProxy(sitemapUrl, country, 15000);
    const result = await parseStringPromise(xml, {
      explicitArray: false,
      ignoreAttrs: true,
    });
    const urlList = result?.urlset?.url;
    if (!urlList) return [];
    const urls = Array.isArray(urlList) ? urlList : [urlList];
    return urls.map((entry) => entry.loc).filter(Boolean);
  } catch (err) {
    console.warn(
      `[${country}] ❌ Failed to fetch URLs from ${sitemapUrl}: ${
        err?.message || err
      }`
    );
    return [];
  }
}

/* ====== WARMING ====== */
async function retryableGet(url, cfg, retries = 3) {
  let lastError = null;
  for (let i = 0; i < retries; i++) {
    try {
      return await axios.get(url, cfg);
    } catch (err) {
      lastError = err;
      const code = err?.code || "";
      const retryable =
        axios.isAxiosError(err) &&
        ["ECONNABORTED", "ECONNRESET", "ETIMEDOUT"].includes(code);
      if (!retryable) break;
      await sleep(2000);
    }
  }
  throw lastError;
}

async function purgeCloudflareCache(url) {
  if (!CLOUDFLARE_ZONE_ID || !CLOUDFLARE_API_TOKEN) return;
  try {
    const purgeRes = await axios.post(
      `https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/purge_cache`,
      { files: [url] },
      {
        headers: {
          Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
    if (purgeRes.data?.success) {
      console.log(`✅ Cloudflare cache purged: ${url}`);
    } else {
      console.warn(`⚠️ Failed to purge Cloudflare: ${url}`);
    }
  } catch {
    console.warn(`❌ Error purging Cloudflare: ${url}`);
  }
}

async function warmUrls(urls, country, logger, batchSize = 1, delay = 2000) {
  const batches = Array.from(
    { length: Math.ceil(urls.length / batchSize) },
    (_, i) => urls.slice(i * batchSize, i * batchSize + batchSize)
  );

  for (const batch of batches) {
    await Promise.all(
      batch.map(async (url) => {
        const t0 = Date.now();
        try {
          const res = await retryableGet(
            url,
            buildAxiosCfg(country, { timeout: 15000 }),
            3
          );
          const dt = Date.now() - t0;

          const cfCache = res.headers["cf-cache-status"] || "N/A";
          const lsCache = res.headers["x-litespeed-cache"] || "N/A";
          const cfRay = res.headers["cf-ray"] || "N/A";
          const cfEdge =
            cfRay && cfRay.includes("-") ? cfRay.split("-")[1] : "N/A";

          console.log(
            `[${country}] ${res.status} cf=${cfCache} ls=${lsCache} edge=${cfEdge} - ${url}`
          );

          // Kumpulkan log (dikirim sekali di akhir run)
          logger.log({
            country,
            url,
            status: res.status,
            cfCache,
            lsCache,
            cfRay,
            responseMs: dt,
            error: 0,
            message: "",
          });

          // Aturan purge: kalau LiteSpeed bukan HIT → purge CF
          if (String(lsCache).toLowerCase() !== "hit") {
            await purgeCloudflareCache(url);
          }
        } catch (err) {
          const dt = Date.now() - t0;
          console.warn(
            `[${country}] ❌ Failed to warm ${url}: ${err?.message || err}`
          );

          logger.log({
            country,
            url,
            responseMs: dt,
            error: 1,
            message: err?.message || "request failed",
          });
        }
      })
    );

    // tidak flush di sini → supaya semua baris masuk satu tab
    await sleep(delay);
  }
}

/* ====== MAIN (batch per-run, satu tab) ====== */
(async () => {
  console.log(`[CacheWarmer] Started: ${new Date().toISOString()}`);
  const logger = new AppsScriptLogger();

  try {
    await Promise.all(
      Object.entries(DOMAINS_MAP).map(async ([country, domain]) => {
        const sitemapList = await fetchIndexSitemaps(domain, country);
        const urlArrays = await Promise.all(
          sitemapList.map((sitemapUrl) =>
            fetchUrlsFromSitemap(sitemapUrl, country)
          )
        );
        const urls = urlArrays.flat().filter(Boolean);

        console.log(`[${country}] Found ${urls.length} URLs`);
        logger.log({
          country,
          message: `Found ${urls.length} URLs for ${country}`,
        });

        await warmUrls(urls, country, logger);
      })
    );
  } finally {
    // Kirim SEKALI di akhir → semua baris tersimpan dalam SATU tab (sheetName per-run)
    logger.setFinished();
    await logger.flush();
  }

  console.log(`[CacheWarmer] Finished: ${new Date().toISOString()}`);
})();
