FROM node:20-slim
WORKDIR /app
COPY apps/api/package.json apps/api/package-lock.json* ./
RUN npm install
COPY apps/api .
RUN npm run build

# Run as a non-root user (§33) rather than the container default root.
RUN groupadd -r leadintel && useradd -r -g leadintel leadintel
USER leadintel

EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
