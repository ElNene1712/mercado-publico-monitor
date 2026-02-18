const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const { scrapeProduct } = require("./scraper");

const app = express();

/**
 * CORS:
 * - Permite localhost (dev)
 * - Permite dominio propio (prod)
 * - Permite cualquier deploy/preview de Vercel (*.vercel.app)
 *
 * Así no tienes que estar agregando el preview nuevo cada vez.
 */
const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:3000",
  "https://chilepricetrack.com",
  "https://www.chilepricetrack.com",
];

app.use(
  cors({
    origin: (origin, cb) => {
      // Permite requests sin Origin (Postman, cron, server-to-server)
      if (!origin) return cb(null, true);

      // Permite lista fija
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);

      // Permite cualquier preview/deploy de Vercel
      if (origin.endsWith(".vercel.app")) return cb(null, true);

      return cb(new Error(`CORS bloqueado para origin: ${origin}`));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

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

/* Railway: usar el puerto que te entrega la plataforma */
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("Servidor en puerto", PORT);
});
