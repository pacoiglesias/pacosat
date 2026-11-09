FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && mkdir -p /var/lib/pacosat && chown node:node /var/lib/pacosat
COPY local-server.mjs sat-direct.mjs sat-monitor.mjs sat-lists.mjs xml-core.mjs pdf-invoice.mjs backup-core.mjs bank-statement.mjs Faro-Fiscal.html ./
USER node
EXPOSE 43729
CMD ["node", "local-server.mjs"]
