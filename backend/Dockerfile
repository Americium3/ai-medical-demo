# Consultation backend image (#11). Build from the repository root:
#   docker build -f backend/Dockerfile -t consult-backend .
# The server is bundled with esbuild; node_modules keeps production dependencies only.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Behind a TLS-inspecting proxy, pass its CA: --secret id=extra_ca,src=<ca.pem> (plus --build-arg HTTPS_PROXY=...).
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca npm_config_cafile=/run/secrets/extra_ca; fi; \
    npm ci --no-audit --no-fund
COPY backend ./backend
COPY shared ./shared
COPY tsconfig.json ./
RUN npx esbuild backend/src/main.ts --bundle --platform=node --target=node22 --packages=external --outfile=dist/main.cjs \
 && npm prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8787
# CA bundle for TLS to Amazon RDS (node-postgres verifies the server certificate).
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/rds-global-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/app/rds-global-bundle.pem
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# node as PID 1 receives SIGTERM directly; main.ts drains in-flight requests before exiting.
CMD ["node", "dist/main.cjs"]
