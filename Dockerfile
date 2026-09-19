# syntax=docker/dockerfile:1

# ---- build stage: compile TypeScript ----
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- production dependencies ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV FIXTURES_DIR=/app/fixtures
ENV DATABASE_URL=postgres://pig_risk:scaffold-only@postgres:5432/pig_risk

# busybox wget (present in node:alpine) backs the container HEALTHCHECK.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json package-lock.json ./
COPY migrations ./migrations
COPY fixtures ./fixtures
COPY contracts ./contracts
COPY scaffold ./scaffold
COPY scripts ./scripts

EXPOSE 8080
HEALTHCHECK --interval=5s --timeout=3s --retries=20 \
  CMD wget -q -O - http://127.0.0.1:8080/health >/dev/null 2>&1 || exit 1

CMD ["node", "dist/server.js"]
