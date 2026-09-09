# Build context is the repo root, because npm workspaces resolve from there.
#   docker build -f apps/retriever-api/Dockerfile .

FROM node:20-alpine AS deps
WORKDIR /app
# Both workspace manifests are needed: npm ci validates the whole workspace
# against the root lockfile even when installing only one of them.
COPY package.json package-lock.json ./
COPY apps/retriever-api/package.json ./apps/retriever-api/
COPY apps/frontend/package.json ./apps/frontend/
RUN npm ci --omit=dev --workspace retriever-api

FROM node:20-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
# Copy the whole installed tree, not just /app/node_modules. npm workspaces
# hoist most packages to the root but keep any that cannot be hoisted (a pinned
# version conflicting with another dependency) in the workspace's own
# node_modules, and those would otherwise be missing at runtime.
COPY --from=deps /app ./
COPY apps/retriever-api ./apps/retriever-api

# index.js resolves uploads/ and logs/ relative to cwd.
WORKDIR /app/apps/retriever-api
RUN mkdir -p uploads logs && chown -R node:node /app
USER node

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "index.js"]
