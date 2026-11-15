FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && mkdir -p /var/lib/pacosat && chown node:node /var/lib/pacosat
# Navegador interno del descargador (1.9.0): la constancia y la
# opinión se obtienen con un Chromium real DENTRO del contenedor
# (patrón sat-dm); playwright-core lo conduce sin descargar nada.
# La imagen crece (~350 MB más) a cambio de esa capacidad.
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-liberation \
  && rm -rf /var/lib/apt/lists/*
ENV PACOSAT_CHROMIUM_PATH=/usr/bin/chromium
# ejecutor-bundle.zip/.json (1.30.0): el paquete del ejecutor que
# el servidor ofrece para su auto-actualización. Se GENERAN al
# empaquetar el despliegue (zip del ejecutor + su manifiesto con
# versión y huella) y viajan dentro del paquete de despliegue; no
# viven en el árbol de código. Si algún día se construye la imagen
# fuera de ese paquete, hay que generarlos antes del build.
COPY local-server.mjs sat-direct.mjs sat-monitor.mjs sat-lists.mjs sat-doc-fetch.mjs sat-doc-browser.mjs sat-declaraciones.mjs sat-tributario.mjs sat-ciec.mjs sat-executor.mjs ejecutor-local.mjs pagos.mjs xml-core.mjs salidas-doc.mjs qr-cfdi.mjs pdf-invoice.mjs backup-core.mjs bank-statement.mjs news-mail.mjs secret-box.mjs push.mjs Faro-Fiscal.html capacidades.json lazy.json ejecutor-bundle.zip ejecutor-bundle.json ./
USER node
EXPOSE 43729
CMD ["node", "local-server.mjs"]
