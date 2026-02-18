const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const { scrapeProduct } = require("./scraper");

const app = express();

/**
 * CORS:
 * - Permite dominio prod (chilepricetrack.com)
 * - Permite localhost
 * - Permite cualquier preview de Vercel de precio-chile-track-*
 *
 * OJO: Si tu proyecto Vercel cambia el prefijo, ajusta el regex.
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
      // Permite requests sin Origin (cron, curl, server-to-server)
      if (!origin) return cb(null, true);

      if (allowlist.has(origin)) return cb(null, true);
      if (vercelPreviewRegex.test(origin)) return cb(null, true);

      // En vez de lanzar error (que a veces tumba preflight),
      // devolvemos false y listo.
      return cb(null, false);
    },
    credentials: false,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    optionsSuccessStatus: 204,
  })
);

// Importante para preflight
app.options("*", cors());

app.use(express.json());

let productos = [];

/* Healthcheck (Railway / monitoreo) */
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

/* Endpoint manual */
app.get("/search", async (req, res) => {
  const id = req.query.id;
  const regiones = req.query.regiones ? req.query.regiones.split(",") : ["RM"];

  if (!id) return res.status(400).json({ error: "Falta ID" });

  try {
    const data = await scrapeProduct(id, regiones);
    res.json(data);
  } catch (err) {
    console.error("Error en /search:", err);
    res.status(500).json({ error: "Error scraping" });
  }
});

/* Agregar producto al monitoreo */
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

/* Ver productos monitoreados */
app.get("/productos", (req, res) => {
  res.json(productos);
});

/* Actualización automática cada 3 horas */
cron.schedule("0 */3 * * *", async () => {
  console.log("Actualizando productos...");

  for (let p of productos) {
    try {
      const data = await scrapeProduct(p.id, p.regiones);
      p.ultimo = data;
    } catch (e) {
      console.log("Error actualizando", p.id, e?.message || e);
    }
  }
});

/* Railway: usar el puerto que entrega la plataforma */
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("Servidor en puerto", PORT);
});
