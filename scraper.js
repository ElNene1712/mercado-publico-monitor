// scraper.js
const { chromium } = require("playwright");

const SEARCH_URL =
  "https://conveniomarco2.mercadopublico.cl/ferreteria2/productos-de-ferreteria";

// OJO: estos valores deben coincidir con los <option value="..."> del select#attribute2276
const REGIONES = {
  RM: "13",
  VALPO: "5",
  OHIGGINS: "6",
};

function parsePrecioBase(value) {
  const n = Number(String(value || "").replace(/[^\d]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

/* =========================================================
   ✅ Semaphore simple: limita concurrencia de scrapes
   - Por defecto: 1 (seguro para Railway + MP)
   - Puedes setear env SCRAPER_CONCURRENCY=2 si quieres
========================================================= */
const SCRAPER_CONCURRENCY = Number(process.env.SCRAPER_CONCURRENCY || 1);
let active = 0;
const queue = [];

async function acquire() {
  if (active < SCRAPER_CONCURRENCY) {
    active++;
    return;
  }
  await new Promise((resolve) => queue.push(resolve));
  active++;
}

function release() {
  active--;
  const next = queue.shift();
  if (next) next();
}

/* =========================================================
   ✅ Browser/Context singleton (REUSO)
========================================================= */
let _browser = null;
let _context = null;
let _launching = null;

// Si algo se rompe, reiniciamos el browser.
async function resetBrowser() {
  try {
    if (_context) {
      await _context.close().catch(() => {});
      _context = null;
    }
    if (_browser) {
      await _browser.close().catch(() => {});
      _browser = null;
    }
  } finally {
    _launching = null;
  }
}

async function getContext() {
  // Evita doble launch simultáneo
  if (_launching) return _launching;

  if (_browser && _context) return _context;

  _launching = (async () => {
    // Si existe browser pero no context, lo rearmamos
    if (!_browser) {
      _browser = await chromium.launch({
        headless: true,
        args: [
          "--disable-dev-shm-usage",
          "--no-sandbox",
          "--disable-blink-features=AutomationControlled",
        ],
      });

      // Si Railway mata proceso, esto ayuda a detectar estado raro
      _browser.on("disconnected", async () => {
        console.warn("[scraper] Browser disconnected, resetting...");
        await resetBrowser();
      });
    }

    _context = await _browser.newContext({
      locale: "es-CL",
      timezoneId: "America/Santiago",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 720 },
    });

    // ✅ Importante: route SOLO una vez en el context (NO por page)
    await _context.route("**/*", (route) => {
      const req = route.request();
      const type = req.resourceType();
      if (type === "image" || type === "stylesheet" || type === "font") {
        return route.abort();
      }
      route.continue();
    });

    return _context;
  })();

  try {
    const ctx = await _launching;
    _launching = null;
    return ctx;
  } catch (e) {
    _launching = null;
    await resetBrowser();
    throw e;
  }
}

/* =========================================================
   ✅ Wait wrappers "no destructivos"
========================================================= */
async function safeWait(fn, timeoutMs, onFailValue = false) {
  try {
    await fn({ timeout: timeoutMs });
    return true;
  } catch {
    return onFailValue;
  }
}

async function waitOffersLoaded(page, timeoutMs = 25000) {
  return await safeWait(
    (opts) =>
      page.waitForFunction(() => {
        // ✅ suficiente con que aparezca tabla de sellers O algún price>0
        const sellerRows = document.querySelectorAll("tr.flag-row-seller");
        if (sellerRows && sellerRows.length > 0) return true;

        const els = Array.from(
          document.querySelectorAll("td.wk-ap-price[data-base]")
        );
        if (!els.length) return false;
        return els.some((el) => {
          const v = Number(el.getAttribute("data-base") || "0");
          return Number.isFinite(v) && v > 0;
        });
      }, opts),
    timeoutMs,
    false
  );
}

async function hasNoResults(page) {
  const noRes1 = page.locator("text=/No se encontraron resultados/i");
  const noRes2 = page.locator("text=/Sin resultados/i");
  const noRes3 = page.locator("text=/No hay resultados/i");
  return (
    (await noRes1.count()) > 0 ||
    (await noRes2.count()) > 0 ||
    (await noRes3.count()) > 0
  );
}

/* =========================================================
   ✅ Helpers anti-banner / overlay (no rompe si no existe)
========================================================= */
async function dismissOverlays(page) {
  // cookies / banners típicos
  const candidates = [
    'button:has-text("Aceptar")',
    'button:has-text("ACEPTAR")',
    'button:has-text("Entendido")',
    'button:has-text("OK")',
    'button:has-text("Cerrar")',
    '[aria-label="close"]',
    '[aria-label="Close"]',
    'button[title="Close"]',
  ];

  for (const sel of candidates) {
    const btn = page.locator(sel).first();
    if ((await btn.count()) > 0) {
      try {
        await btn.click({ timeout: 800 });
      } catch (_) {}
    }
  }
}

async function goToFirstProductFromSearch(page) {
  await dismissOverlays(page);

  const searchInput = page.locator("input#search, input[name='q']");
  const okSearch = await safeWait(
    (opts) => searchInput.waitFor({ state: "visible", ...opts }),
    30000,
    false
  );
  if (!okSearch) throw new Error("No apareció el buscador (input#search)");

  // Limpia y busca
  await searchInput.fill("");
  await searchInput.type(String(page.__query), { delay: 10 });

  // al apretar Enter a veces navega, a veces solo refresca listado
  await Promise.allSettled([
    searchInput.press("Enter"),
    page.waitForLoadState("domcontentloaded", { timeout: 15000 }),
  ]);

  await dismissOverlays(page);

  // ✅ Selector unificado (esto corrige tu timeout en Railway)
  const anyFirstCard = page
    .locator(
      "li.item.product.product-item, li.product-item, [data-container='product-grid'] li"
    )
    .first();

  let found = await safeWait(
    (opts) => anyFirstCard.waitFor({ state: "visible", ...opts }),
    30000,
    false
  );

  if (!found) {
    if (await hasNoResults(page)) {
      throw new Error("Sin resultados para el ID buscado");
    }

    // retry suave (a veces MP no refresca el grid en el primer enter)
    await sleep(1200);
    await Promise.allSettled([
      searchInput.press("Enter"),
      page.waitForLoadState("domcontentloaded", { timeout: 15000 }),
    ]);

    found = await safeWait(
      (opts) => anyFirstCard.waitFor({ state: "visible", ...opts }),
      35000,
      false
    );

    if (!found) {
      // último intento: recarga la URL base y reintenta una vez
      await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded" });
      await dismissOverlays(page);

      const okSearch2 = await safeWait(
        (opts) => searchInput.waitFor({ state: "visible", ...opts }),
        30000,
        false
      );
      if (!okSearch2) throw new Error("No reapareció el buscador tras recarga");

      await searchInput.fill("");
      await searchInput.type(String(page.__query), { delay: 10 });

      await Promise.allSettled([
        searchInput.press("Enter"),
        page.waitForLoadState("domcontentloaded", { timeout: 15000 }),
      ]);

      found = await safeWait(
        (opts) => anyFirstCard.waitFor({ state: "visible", ...opts }),
        35000,
        false
      );

      if (!found) {
        throw new Error("No pude ver resultados (timeout en lista de productos)");
      }
    }
  }

  // ya tenemos el primer card visible
  const firstCard = anyFirstCard;

  const verProducto = firstCard
    .locator("a.action.tocart.primary.cc-link")
    .first();
  const fallbackText = firstCard.locator('a:has-text("Ver Producto")').first();
  const fallbackTitle = firstCard
    .locator("a.product-item-link, a[href*='/ferreteria2/']")
    .first();

  const clickTarget =
    (await verProducto.count()) > 0
      ? verProducto
      : (await fallbackText.count()) > 0
      ? fallbackText
      : (await fallbackTitle.count()) > 0
      ? fallbackTitle
      : null;

  if (!clickTarget) {
    throw new Error("No encontré link para entrar al producto desde resultados");
  }

  await Promise.allSettled([
    clickTarget.click(),
    page.waitForLoadState("domcontentloaded", { timeout: 20000 }),
  ]);

  const okTitle = await safeWait(
    (opts) => page.waitForSelector("h1.page-title", opts),
    30000,
    false
  );
  if (!okTitle) {
    // a veces el click abre en misma página pero demora; un wait extra no hace daño
    const okTitle2 = await safeWait(
      (opts) => page.waitForSelector("h1.page-title", opts),
      20000,
      false
    );
    if (!okTitle2) {
      throw new Error("No cargó la página del producto (sin h1.page-title)");
    }
  }
}

async function ensureProvidersSectionVisible(page) {
  await dismissOverlays(page);

  const btn = page
    .locator(
      'button:has-text("VER PROVEEDORES"), button:has-text("Ver proveedores")'
    )
    .first();

  if ((await btn.count()) > 0) {
    await btn.scrollIntoViewIfNeeded();
    try {
      await btn.click({ timeout: 3000 });
    } catch (_) {}
  }

  await page.mouse.wheel(0, 1200);
}

/* =========================================================
   ✅ scrapeProduct: ahora NO abre browser ni context
   - Solo pide context singleton
   - Crea una page, trabaja, y la cierra
========================================================= */
async function scrapeProduct(query, regionesElegidas = ["RM"]) {
  await acquire();

  let page = null;

  try {
    const context = await getContext();

    page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.__query = query;

    await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded" });

    await goToFirstProductFromSearch(page);

    const title = await page.locator("h1.page-title").first().innerText();

    const result = {
      id: String(query),
      nombre: title?.trim() || "",
      regiones: {},
    };

    const regionSelect = page.locator("select#attribute2276").first();
    const okRegionSelect = await safeWait(
      (opts) => regionSelect.waitFor({ state: "visible", ...opts }),
      30000,
      false
    );
    if (!okRegionSelect) {
      throw new Error("No apareció el selector de regiones (#attribute2276)");
    }

    for (const regionKey of regionesElegidas) {
      const regionId = REGIONES[regionKey];
      if (!regionId) continue;

      // Cambia región
      await regionSelect.selectOption(regionId);

      // A veces el cambio dispara requests; domcontentloaded no cambia, así que esperamos un pelín
      await sleep(300);

      await ensureProvidersSectionVisible(page);

      const offersOk = await waitOffersLoaded(page, 30000);
      if (!offersOk) {
        result.regiones[regionKey] = null;
        continue;
      }

      const rows = await page.$$eval("tr.flag-row-seller", (trs) => {
        return trs
          .map((tr) => {
            const proveedor =
              tr.querySelector("td.wk-ap-seller-name a.wk-ap-shop-link")
                ?.textContent?.trim() ||
              tr.querySelector("td.wk-ap-seller-name")?.textContent?.trim() ||
              null;

            const diasText =
              tr.querySelector("td.wk-ap-delivery-days span.bdays")
                ?.textContent?.trim() || null;

            const precioBaseAttr =
              tr.querySelector("td.wk-ap-price")?.getAttribute("data-base") ||
              "0";

            const precio = Number(precioBaseAttr);

            return {
              proveedor,
              diasHabiles: diasText,
              precio,
            };
          })
          .filter(
            (x) => x && x.proveedor && Number.isFinite(x.precio) && x.precio > 0
          );
      });

      if (rows.length > 0) {
        const min = rows.reduce((a, b) => (a.precio < b.precio ? a : b));
        result.regiones[regionKey] = min;
      } else {
        result.regiones[regionKey] = null;
      }
    }

    return result;
  } catch (e) {
    // Si Playwright queda en estado malo, reseteamos el browser
    const msg = String(e?.message || e);
    if (
      msg.includes("Target closed") ||
      msg.includes("has been closed") ||
      msg.includes("Browser disconnected") ||
      msg.includes("Execution context was destroyed")
    ) {
      console.warn("[scraper] Error crítico, reseteando browser:", msg);
      await resetBrowser();
    }
    throw e;
  } finally {
    try {
      if (page) await page.close().catch(() => {});
    } finally {
      release();
    }
  }
}

/* =========================================================
   ✅ Opcional: cierre limpio del browser (server.js)
========================================================= */
async function shutdownScraper() {
  await resetBrowser();
}

module.exports = { scrapeProduct, shutdownScraper };
