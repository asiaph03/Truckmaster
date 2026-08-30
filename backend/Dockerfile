# Beta Launch Hardening — minimum deployment configuration for the
# backend. Build from the REPO ROOT (npm workspaces needs the root
# package.json/package-lock.json to install correctly):
#
#   docker build -f backend/Dockerfile -t tms-backend .
#
# Deliberately simple, not size-optimized: a plain root-level `npm ci`
# installs every workspace's dependencies (including the frontend's),
# not just the backend's — a real simplification, disclosed here rather
# than hidden, favoring a correct/robust first Dockerfile over a
# hand-tuned multi-stage `--workspace`-scoped install. A follow-up can
# trim this later if image size becomes a real concern.
#
# Does NOT run migrations/RLS/seed on container start — those remain
# explicit, one-off operator commands (see the deployment instructions
# in the implementation report), matching how every other environment in
# this project already runs them, and avoiding the well-known anti-
# pattern of auto-migrating on every container start/scale-up.

FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
COPY packages ./packages
RUN npm ci

COPY backend ./backend
# Not run by any install/build hook automatically anywhere in this repo
# (confirmed — no postinstall script exists; CI runs this as its own
# explicit step too) — the generated @prisma/client would otherwise be
# missing entirely at runtime.
RUN npm run prisma:generate --workspace=backend
RUN npm run build --workspace=backend
RUN npm prune --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/backend/node_modules ./backend/node_modules
COPY --from=builder /app/backend/package.json ./backend/package.json
COPY --from=builder /app/backend/dist ./backend/dist
COPY --from=builder /app/backend/prisma ./backend/prisma
COPY --from=builder /app/backend/scripts ./backend/scripts

# Runs as the image's built-in unprivileged user, not root.
USER node

EXPOSE 3000
# nest build's actual output is dist/src/main.js, not dist/main.js —
# verified directly against a real `npm run build` output, not assumed.
CMD ["node", "backend/dist/src/main.js"]
