// server.js
const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const { scrapeProduct, shutdownScraper } = require("./scraper");

// ✅ Supabase (solo backend)
const { createClient } = require("@supabase/supabase-js");

const app = express();

/**
 * CORS:
 * - Permite dominio prod (chilepricetrack.com)
 * - Permite localhost
 * - Permite cualquier preview de Vercel de precio-chile-track-*
 */
const allowlist = new Set([
  "http://localhost:5173",
  "http://localhost:3000",
  "https://chilepricetrack.com",
  "https://www.chilepricetrack.com",
]);

const vercelPreviewRegex =
  /^https:\/\/precio-chile-track-[a-z0-9-]+\.vercel\.app$/i;

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowlist.has(origin)) return cb(null, true);
      if (vercelPreviewRegex.test(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: false,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    optionsSuccessStatus: 204,
  })
);

app.options("*", cors());
app.use(express.json());

/* ----------------------------------------
   🔥 Supabase client (backend)
----------------------------------------- */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false },
      })
    : null;

/* ----------------------------------------
   ✅ Tu store en memoria (lo dejo intacto)
----------------------------------------- */
let productos = [];

/* Healthcheck (Railway / monitoreo) */
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

/* Endpoint manual (igual que antes) */
app.get("/search", async (req, res) => {
  const id = req.query.id;
  const regiones = req.query.regiones ? req.query.regiones.split(",") : ["RM"];

  if (!id) return res.status(400).json({ error: "Falta ID" });

  try {
    const data = await scrapeProduct(id, regiones);
    res.json(data);
  } catch (err) {
    console.error("Error en /search:", err?.message || err);
    res.status(500).json({ error: "Error scraping" });
  }
});

/* Agregar producto al monitoreo (memoria) */
app.post("/add", (req, res) => {
  const { id, regiones } = req.body;

  if (!id) return res.status(400).json({ error: "Falta ID" });

  productos.push({
    id,
    regiones: Array.isArray(regiones) && regiones.length ? regiones : ["RM"],
    ultimo: null,
  });

  res.json({ ok: true });
});

/* Ver productos monitoreados (memoria) */
app.get("/productos", (req, res) => {
  res.json(productos);
});

/* ----------------------------------------
   ✅ Batch sync real desde Supabase
----------------------------------------- */
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 20);
const BATCH_DELAY_MS = Number(process.env.BATCH_DELAY_MS || 1500);

// evita correr dos batches en paralelo
let BATCH_RUNNING = false;

function regionKeyToSnapshotColumn(regionKey) {
  if (regionKey === "RM") return "rm_price";
  if (regionKey === "VALPO") return "valpo_price";
  if (regionKey === "OHIGGINS") return "ohiggins_price";
  return null;
}

async function runBatchSync() {
  if (!supabase) {
    console.warn(
      "[batch] Supabase no configurado: faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"
    );
    return;
  }

  if (BATCH_RUNNING) {
    console.log("[batch] Ya hay un batch corriendo, salto esta ejecución.");
    return;
  }

  BATCH_RUNNING = true;

  try {
    console.log(`[batch] Iniciando batch: ${BATCH_SIZE} productos`);

    let products = null;

    // Intento con last_sync (si existe)
    {
      const { data, error } = await supabase
        .from("tracked_products")
        .select("id, product_id, regions, created_at, last_sync")
        .order("last_sync", { ascending: true, nullsFirst: true })
        .limit(BATCH_SIZE);

      if (!error) {
        products = data || [];
      } else {
        console.warn(
          "[batch] No pude ordenar por last_sync (quizás no existe aún). Fallback a created_at.",
          error.message
        );

        const { data: data2, error: error2 } = await supabase
          .from("tracked_products")
          .select("id, product_id, regions, created_at")
          .order("created_at", { ascending: true })
          .limit(BATCH_SIZE);

        if (error2) throw error2;
        products = data2 || [];
      }
    }

    if (!products.length) {
      console.log("[batch] No hay productos en tracked_products.");
      return;
    }

    for (const p of products) {
      const regiones =
        Array.isArray(p.regions) && p.regions.length ? p.regions : ["RM"];

      const normalizeRegionKey = (r) => {
        if (!r) return null;
        const s = String(r).trim();
        if (s === "RM" || s === "VALPO" || s === "OHIGGINS") return s;
        if (s.includes("Metropolitana")) return "RM";
        if (s.includes("Valpara")) return "VALPO";
        if (
          s.includes("O'Higgins") ||
          s.includes("OHiggins") ||
          s.includes("Bernardo O'Higgins")
        )
          return "OHIGGINS";
        return null;
      };

      const regionKeys = regiones.map(normalizeRegionKey).filter(Boolean);
      const uniqueRegionKeys = Array.from(
        new Set(regionKeys.length ? regionKeys : ["RM"])
      );

      try {
        console.log(
          `[batch] Sync ${p.product_id} (${uniqueRegionKeys.join(",")})`
        );

        const data = await scrapeProduct(p.product_id, uniqueRegionKeys);

        const snapshot = {
          tracked_product_id: p.id,
          title: data?.nombre || null,
          ok: true,
          error: null,
          fetched_at: new Date().toISOString(),
        };

        for (const rk of uniqueRegionKeys) {
          const col = regionKeyToSnapshotColumn(rk);
          if (!col) continue;
          const precio = data?.regiones?.[rk]?.precio;
          snapshot[col] = Number.isFinite(Number(precio)) ? Number(precio) : null;
        }

        const { error: insErr } = await supabase
          .from("product_snapshots")
          .insert(snapshot);
        if (insErr) throw insErr;

        // last_sync opcional
        const { error: upErr } = await supabase
          .from("tracked_products")
          .update({ last_sync: new Date().toISOString() })
          .eq("id", p.id);

        if (upErr) {
          console.warn(
            "[batch] No pude actualizar last_sync (ok por ahora):",
            upErr.message
          );
        }
      } catch (e) {
        console.error("[batch] Error syncing", p.product_id, e?.message || e);

        try {
          await supabase.from("product_snapshots").insert({
            tracked_product_id: p.id,
            title: null,
            rm_price: null,
            valpo_price: null,
            ohiggins_price: null,
            ok: false,
            error: String(e?.message || e),
            fetched_at: new Date().toISOString(),
          });
        } catch (e2) {
          console.error(
            "[batch] Error guardando snapshot de error:",
            e2?.message || e2
          );
        }
      }

      await new Promise((res) => setTimeout(res, BATCH_DELAY_MS));
    }

    console.log("[batch] Batch terminado OK");
  } catch (e) {
    console.error("[batch] Batch falló:", e?.message || e);
  } finally {
    BATCH_RUNNING = false;
  }
}

// ✅ Cron interno (NO uses Railway Cron Schedule en Settings)
cron.schedule("*/10 * * * *", async () => {
  await runBatchSync();
});

// ✅ Endpoint manual para probar
app.post("/batch-sync", async (req, res) => {
  try {
    await runBatchSync();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* Railway: usar el puerto que entrega la plataforma */
const PORT = process.env.PORT || 8080;

const httpServer = app.listen(PORT, "0.0.0.0", () => {
  console.log("Servidor en puerto", PORT);
});

/* ---------------------------
   ✅ Graceful shutdown REAL
---------------------------- */
let shuttingDown = false;

async function gracefulExit(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`${signal} recibido, cerrando servidor y scraper...`);

  // 1) deja de aceptar requests
  await new Promise((resolve) => {
    httpServer.close(() => resolve());
  }).catch(() => {});

  // 2) cierra playwright
  try {
    await shutdownScraper();
  } catch (e) {
    console.warn("Error cerrando scraper:", e?.message || e);
  }

  process.exit(0);
}

process.on("SIGTERM", () => gracefulExit("SIGTERM"));
process.on("SIGINT", () => gracefulExit("SIGINT"));

process.on("unhandledRejection", (err) => {
  console.error("unhandledRejection:", err);
});

process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
});
