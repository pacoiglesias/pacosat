FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && mkdir -p /var/lib/faro && chown node:node /var/lib/faro
COPY local-server.mjs sat-direct.mjs sat-monitor.mjs xml-core.mjs pdf-invoice.mjs Faro-Fiscal.html ./
USER node
EXPOSE 43729
CMD ["node", "local-server.mjs"]
