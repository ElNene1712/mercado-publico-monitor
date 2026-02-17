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

async function waitOffersLoaded(page, timeoutMs = 25000) {
  // Espera a que exista al menos 1 precio real (>0) en la tabla
  await page.waitForFunction(() => {
    const els = Array.from(document.querySelectorAll("td.wk-ap-price[data-base]"));
    if (!els.length) return false;
    return els.some((el) => {
      const v = Number(el.getAttribute("data-base") || "0");
      return Number.isFinite(v) && v > 0;
    });
  }, { timeout: timeoutMs });
}

async function goToFirstProductFromSearch(page) {
  // En la home, el input real es #search (según tu HTML)
  const searchInput = page.locator('input#search, input[name="q"]');
  await searchInput.waitFor({ state: "visible", timeout: 20000 });

  // Limpia, escribe, Enter
  await searchInput.fill("");
  await searchInput.type(String(page.__query), { delay: 10 });
  await searchInput.press("Enter");

  // Espera resultados
  const firstCard = page.locator("li.item.product.product-item").first();
  await firstCard.waitFor({ state: "visible", timeout: 20000 });

  // El botón real en resultados (tu screenshot) es:
  // a.action.tocart.primary.cc-link (aunque el texto diga "Ver Producto")
  const verProducto = firstCard.locator('a.action.tocart.primary.cc-link').first();

  // fallback por si cambia el class y queda el texto
  const fallback = firstCard.locator('a:has-text("Ver Producto")').first();

  if (await verProducto.count()) {
    await verProducto.click();
  } else {
    await fallback.click();
  }

  // Espera título producto
  await page.waitForSelector("h1.page-title", { timeout: 20000 });
}

async function ensureProvidersSectionVisible(page) {
  // A veces la tabla carga abajo; scroll ayuda a que renderice.
  // También existe el botón "VER PROVEEDORES" en la página.
  const btn = page.locator('button:has-text("VER PROVEEDORES"), button:has-text("Ver proveedores")').first();
  if (await btn.count()) {
    await btn.scrollIntoViewIfNeeded();
    // si está habilitado, clic
    try {
      await btn.click({ timeout: 3000 });
    } catch (_) {}
  }

  // baja un poco para forzar render del bloque
  await page.mouse.wheel(0, 1200);
}

async function scrapeProduct(query, regionesElegidas = ["RM"]) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  // RÁPIDO: bloquea imágenes, fuentes, css (reduce tiempos MUCHO)
  await page.route("**/*", (route) => {
    const req = route.request();
    const type = req.resourceType();
    if (type === "image" || type === "stylesheet" || type === "font") {
      return route.abort();
    }
    route.continue();
  });

  page.setDefaultTimeout(20000);
  page.__query = query;

  // Entra
  await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded" });

  // Busca y entra al producto
  await goToFirstProductFromSearch(page);

  const title = await page.locator("h1.page-title").first().innerText();

  const result = {
    id: String(query),
    nombre: title?.trim() || "",
    regiones: {},
  };

  // Selector real de región (según tu screenshot)
  const regionSelect = page.locator("select#attribute2276").first();
  await regionSelect.waitFor({ state: "visible", timeout: 20000 });

  for (const regionKey of regionesElegidas) {
    const regionId = REGIONES[regionKey];
    if (!regionId) continue;

    // Cambia región
    await regionSelect.selectOption(regionId);

    // Asegura que la zona de proveedores esté lista / visible
    await ensureProvidersSectionVisible(page);

    // Espera a que aparezca al menos 1 precio real (>0)
    await waitOffersLoaded(page, 25000);

    // Extrae filas (proveedor + dias + precio)
    const rows = await page.$$eval("tr.flag-row-seller", (trs) => {
      return trs.map((tr) => {
        const proveedor =
          tr.querySelector("td.wk-ap-seller-name a.wk-ap-shop-link")?.textContent?.trim() ||
          tr.querySelector("td.wk-ap-seller-name")?.textContent?.trim() ||
          null;

        const diasText =
          tr.querySelector("td.wk-ap-delivery-days span.bdays")?.textContent?.trim() || null;

        const precioBaseAttr =
          tr.querySelector("td.wk-ap-price")?.getAttribute("data-base") || "0";

        const precio = Number(precioBaseAttr);

        return {
          proveedor,
          diasHabiles: diasText,
          precio,
        };
      })
      // filtra inválidos (precios 0 o sin proveedor)
      .filter((x) => x && x.proveedor && Number.isFinite(x.precio) && x.precio > 0);
    });

    if (rows.length > 0) {
      const min = rows.reduce((a, b) => (a.precio < b.precio ? a : b));
      result.regiones[regionKey] = min;
    } else {
      result.regiones[regionKey] = null;
    }
  }

  await browser.close();
  return result;
}

module.exports = { scrapeProduct };
