const { chromium } = require("playwright");

const SEARCH_URL =
  "https://conveniomarco2.mercadopublico.cl/ferreteria2/productos-de-ferreteria";

// OJO: estos valores deben coincidir con los <option value="..."> del select
const REGIONES = {
  RM: "13",
  VALPO: "5",
  OHIGGINS: "6",
};

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function toNumberFromText(s) {
  const n = Number(String(s || "").replace(/[^\d]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/* =========================================================
   ✅ Semaphore simple: limita concurrencia de scrapes
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
  if (_launching) return _launching;
  if (_browser && _context) return _context;

  _launching = (async () => {
    if (!_browser) {
      _browser = await chromium.launch({
        headless: true,
        args: [
          "--disable-dev-shm-usage",
          "--no-sandbox",
          "--disable-blink-features=AutomationControlled",
        ],
      });

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

    // bloquea assets pesados
    await _context.route("**/*", (route) => {
      const type = route.request().resourceType();
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
   ✅ helpers de espera tolerantes
========================================================= */
async function safeWait(fn, timeoutMs, onFailValue = false) {
  try {
    await fn({ timeout: timeoutMs });
    return true;
  } catch {
    return onFailValue;
  }
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

async function waitOffersLoaded(page, timeoutMs = 25000) {
  // acepta precio por data-base o por texto
  return await safeWait(
    (opts) =>
      page.waitForFunction(() => {
        const tds = Array.from(document.querySelectorAll("td.wk-ap-price"));
        if (!tds.length) return false;

        return tds.some((td) => {
          const db = Number(td.getAttribute("data-base") || "0");
          if (Number.isFinite(db) && db > 0) return true;
          const txt = (td.textContent || "").replace(/[^\d]/g, "");
          const n = Number(txt || "0");
          return Number.isFinite(n) && n > 0;
        });
      }, opts),
    timeoutMs,
    false
  );
}

async function ensureProvidersSectionVisible(page) {
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
   ✅ navegación a producto (con retry)
========================================================= */
async function goToFirstProductFromSearch(page) {
  const searchInput = page.locator("input#search, input[name='q']");
  await searchInput.waitFor({ state: "visible", timeout: 30000 });

  await searchInput.fill("");
  await searchInput.type(String(page.__query), { delay: 10 });
  await searchInput.press("Enter");

  const firstCardA = page.locator("li.item.product.product-item").first();
  const firstCardB = page.locator("li.product-item").first();
  const firstCardC = page.locator("[data-container='product-grid'] li").first();

  let found =
    (await safeWait(() => firstCardA.waitFor({ state: "visible" }), 25000, false)) ||
    (await safeWait(() => firstCardB.waitFor({ state: "visible" }), 25000, false)) ||
    (await safeWait(() => firstCardC.waitFor({ state: "visible" }), 25000, false));

  if (!found) {
    if (await hasNoResults(page)) throw new Error("Sin resultados para el ID buscado");

    // retry soft
    await sleep(1200);
    await searchInput.press("Enter");

    found =
      (await safeWait(() => firstCardA.waitFor({ state: "visible" }), 30000, false)) ||
      (await safeWait(() => firstCardB.waitFor({ state: "visible" }), 30000, false)) ||
      (await safeWait(() => firstCardC.waitFor({ state: "visible" }), 30000, false));

    if (!found) throw new Error("No pude ver resultados (timeout en lista de productos)");
  }

  const firstCard =
    (await firstCardA.count()) ? firstCardA :
    (await firstCardB.count()) ? firstCardB :
    firstCardC;

  const verProducto = firstCard.locator("a.action.tocart.primary.cc-link").first();
  const fallbackText = firstCard.locator('a:has-text("Ver Producto")').first();
  const fallbackTitle = firstCard
    .locator("a.product-item-link, a[href*='/ferreteria2/']")
    .first();

  if ((await verProducto.count()) > 0) {
    await verProducto.click();
  } else if ((await fallbackText.count()) > 0) {
    await fallbackText.click();
  } else if ((await fallbackTitle.count()) > 0) {
    await fallbackTitle.click();
  } else {
    throw new Error("No encontré link para entrar al producto desde resultados");
  }

  // gate de producto
  const okTitle = await safeWait(
    (opts) => page.waitForSelector("h1.page-title", opts),
    30000,
    false
  );
  if (!okTitle) throw new Error("No cargó la página del producto (sin h1.page-title)");
}

/* =========================================================
   ✅ buscar selector de región (con fallbacks)
========================================================= */
async function findRegionSelect(page) {
  // tu selector original
  const s1 = page.locator("select#attribute2276").first();
  if (await safeWait((opts) => s1.waitFor({ state: "visible", ...opts }), 6000, false)) {
    return s1;
  }

  // fallbacks comunes (por si MP cambia)
  const s2 = page.locator("select[name*='region' i]").first();
  if (await safeWait((opts) => s2.waitFor({ state: "visible", ...opts }), 6000, false)) {
    return s2;
  }

  const s3 = page.locator("select[id*='region' i]").first();
  if (await safeWait((opts) => s3.waitFor({ state: "visible", ...opts }), 6000, false)) {
    return s3;
  }

  return null;
}

/* =========================================================
   ✅ extracción de filas (precio por data-base o texto)
========================================================= */
async function extractMinOffer(page) {
  await ensureProvidersSectionVisible(page);

  const ok = await waitOffersLoaded(page, 25000);
  if (!ok) return null;

  const rows = await page.$$eval("tr.flag-row-seller", (trs) => {
    function numFromText(s) {
      const n = Number(String(s || "").replace(/[^\d]/g, ""));
      return Number.isFinite(n) ? n : 0;
    }

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

        const tdPrice = tr.querySelector("td.wk-ap-price");
        const base = Number(tdPrice?.getAttribute("data-base") || "0");
        const textNum = numFromText(tdPrice?.textContent || "");
        const precio = Number.isFinite(base) && base > 0 ? base : textNum;

        return {
          proveedor,
          diasHabiles: diasText,
          precio,
        };
      })
      .filter((x) => x && x.proveedor && Number.isFinite(x.precio) && x.precio > 0);
  });

  if (!rows.length) return null;
  return rows.reduce((a, b) => (a.precio < b.precio ? a : b));
}

/* =========================================================
   ✅ scrapeProduct (resiliente)
========================================================= */
async function scrapeProduct(query, regionesElegidas = ["RM"]) {
  await acquire();

  let page = null;

  try {
    const context = await getContext();
    page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.__query = query;

    // navegación con retry
    let navOk = await safeWait(
      (opts) => page.goto(SEARCH_URL, { waitUntil: "domcontentloaded", ...opts }),
      45000,
      false
    );
    if (!navOk) {
      await sleep(1200);
      navOk = await safeWait(
        (opts) => page.goto(SEARCH_URL, { waitUntil: "domcontentloaded", ...opts }),
        45000,
        false
      );
      if (!navOk) throw new Error("No pude abrir SEARCH_URL");
    }

    // entrar a producto con retry
    try {
      await goToFirstProductFromSearch(page);
    } catch (e1) {
      // retry completo una vez
      await sleep(1200);
      await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded" });
      await goToFirstProductFromSearch(page);
    }

    const title = await page.locator("h1.page-title").first().innerText();

    const result = {
      id: String(query),
      nombre: title?.trim() || "",
      regiones: {},
    };

    // encontrar selector región (fallbacks)
    const regionSelect = await findRegionSelect(page);

    // Caso 1: hay selector región => tu flujo normal
    if (regionSelect) {
      for (const regionKey of regionesElegidas) {
        const regionId = REGIONES[regionKey];
        if (!regionId) continue;

        // selectOption con retry (a veces el DOM se re-renderiza)
        let okSel = true;
        try {
          await regionSelect.selectOption(regionId);
        } catch (_) {
          okSel = false;
        }

        if (!okSel) {
          // re-buscar selector y reintentar
          const rs2 = await findRegionSelect(page);
          if (!rs2) {
            result.regiones[regionKey] = null;
            continue;
          }
          try {
            await rs2.selectOption(regionId);
          } catch (_) {
            result.regiones[regionKey] = null;
            continue;
          }
        }

        const minOffer = await extractMinOffer(page);
        result.regiones[regionKey] = minOffer ? minOffer : null;
      }

      return result;
    }

    // Caso 2: NO hay selector región
    // => no reventamos. Scrapeamos ofertas del estado actual
    // y asignamos al menos a la primera región pedida (o RM).
    const fallbackRegion = regionesElegidas?.[0] || "RM";
    const minOffer = await extractMinOffer(page);

    if (minOffer) {
      result.regiones[fallbackRegion] = minOffer;
      // las otras regiones quedan null (honesto)
      for (const rk of regionesElegidas) {
        if (rk !== fallbackRegion) result.regiones[rk] = null;
      }
      return result;
    }

    // si ni siquiera hay tabla, devolvemos todo null (pero sin romper el proceso)
    for (const rk of regionesElegidas) result.regiones[rk] = null;
    return result;
  } catch (e) {
    const msg = String(e?.message || e);

    // reset si es error “crítico” de Playwright
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
   ✅ cierre limpio
========================================================= */
async function shutdownScraper() {
  await resetBrowser();
}

module.exports = { scrapeProduct, shutdownScraper };
