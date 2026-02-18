const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const { scrapeProduct } = require("./scraper");

const app = express();

/**
 * CORS (Vercel + dominio propio + localhost)
 * Tu problema ahora es que el ORIGIN que llega es un preview DISTINTO:
 *   https://precio-chile-track-5g58veadx-martin-gonzalezs-projects-ff1669a3.vercel.app
 * y no está en la lista, entonces queda bloqueado.
 *
 * Solución: permitir wildcard seguro para *.vercel.app + tus dominios.
 */
const ALLOWED_ORIGINS = new Set([
  "http://localhost:5173",
  "http://localhost:3000",
  "https://chilepricetrack.com",
  "https://www.chilepricetrack.com",
]);

const ALLOWED_ORIGIN_REGEX = [
  // cualquier preview de vercel para tu proyecto
  /^https:\/\/precio-chile-track-[a-z0-9-]+-martin-gonzalezs-projects-ff1669a3\.vercel\.app$/i,

  // si algún día cambia el subdominio del proyecto, esto lo cubre igual:
  /^https:\/\/[a-z0-9-]+\.vercel\.app$/i,
];

function isOriginAllowed(origin) {
  if (!origin) return true; // server-to-server, cron, postman
  if (ALLOWED_ORIGINS.has(origin)) return true;
  return ALLOWED_ORIGIN_REGEX.some((re) => re.test(origin));
}

const corsOptions = {
  origin: (origin, cb) => {
    if (isOriginAllowed(origin)) return cb(null, true);
    return cb(null, false); // NO tires error (si tiras error, queda sin headers y se ve "No Access-Control-Allow-Origin")
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
  maxAge: 86400,
};

app.use(cors(corsOptions));
// Preflight para cualquier ruta
app.options("*", cors(corsOptions));

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
