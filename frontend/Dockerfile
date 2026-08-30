# Beta Launch Hardening — minimum deployment configuration for the
# frontend. Build from the REPO ROOT (npm workspaces + the
# `@tms/shared-constants` workspace package the frontend imports
# directly need the root package.json/package-lock.json/packages/ to
# resolve correctly):
#
#   docker build -f frontend/Dockerfile -t tms-frontend .
#
# Serves the built SPA and reverse-proxies /api/* to the backend from
# ONE nginx origin (see nginx.conf.template) — the same same-origin
# topology the local dev server's own Vite proxy already established
# (vite.config.ts), so the browser never needs backend CORS at all.

FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY frontend/package.json ./frontend/package.json
COPY backend/package.json ./backend/package.json
COPY packages ./packages
RUN npm ci

COPY frontend ./frontend
RUN npm run build --workspace=frontend

FROM nginx:1.27-alpine AS runtime

COPY --from=builder /app/frontend/dist /usr/share/nginx/html
COPY frontend/nginx.conf.template /etc/nginx/templates/default.conf.template

# nginx's own docker-entrypoint runs `envsubst` over every file in
# /etc/nginx/templates/*.template using ONLY the container's actual
# environment variables (never nginx's own $uri/$host/etc runtime
# variables, which aren't shell env vars) — the standard, safe mechanism
# for injecting BACKEND_UPSTREAM/S3_ORIGIN at container start without a
# custom entrypoint script. See "Environment variables required by the
# frontend/nginx container" in nginx.conf.template's header comment.

EXPOSE 80
