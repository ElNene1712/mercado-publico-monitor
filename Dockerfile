# Imagen oficial Playwright alineada con tu versión actual (1.58.x)
FROM mcr.microsoft.com/playwright:v1.58.2-jammy

WORKDIR /app

# Copiamos package primero para aprovechar cache
COPY package*.json ./

# Instala dependencias (sin dev si no las necesitas en prod)
RUN npm ci --omit=dev

# Copiamos el resto del proyecto
COPY . .

ENV NODE_ENV=production

# Railway entrega el puerto por variable de entorno
# NO fijamos PORT manualmente aquí
EXPOSE 8080

CMD ["node", "server.js"]
