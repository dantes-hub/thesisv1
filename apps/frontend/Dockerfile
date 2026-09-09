# Build context is the repo root, because npm workspaces resolve from there.
#   docker build -f apps/frontend/Dockerfile --build-arg NEXT_PUBLIC_API_URL=... .

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/frontend/package.json ./apps/frontend/
COPY apps/retriever-api/package.json ./apps/retriever-api/
RUN npm ci --workspace frontend

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY apps/frontend ./apps/frontend

# NEXT_PUBLIC_* values are inlined into the client bundle at build time, so the
# API URL must be supplied here as a build argument. Setting it at runtime has
# no effect on an already-built image.
ARG NEXT_PUBLIC_API_URL=http://localhost:8000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build --workspace frontend

FROM node:20-alpine AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
WORKDIR /app

# The standalone bundle carries its own trimmed node_modules; static assets and
# public/ are not included in it and must be copied alongside.
COPY --from=builder --chown=node:node /app/apps/frontend/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/frontend/.next/static ./apps/frontend/.next/static
COPY --from=builder --chown=node:node /app/apps/frontend/public ./apps/frontend/public

USER node
EXPOSE 3000
CMD ["node", "apps/frontend/server.js"]
