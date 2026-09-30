# syntax=docker/dockerfile:1
# Builds one of the two React/Vite SPAs and serves it with unprivileged nginx,
# which also proxies /api/* to the gateway (see nginx-spa.conf).
#
# Build context: dristhi/ (the npm workspaces root)
#   docker build -f infra/docker/web.Dockerfile --build-arg APP=portal \
#     --build-arg VITE_ROBOT_CONSOLE_URL=https://robot.example -t drishti-portal .
#   docker build -f infra/docker/web.Dockerfile --build-arg APP=robot-console \
#     --build-arg VITE_PORTAL_URL=https://portal.example -t drishti-robot-console .

FROM node:22-slim AS build
WORKDIR /repo

# Workspace manifests first so the dependency layer is cached across source edits.
COPY package.json package-lock.json ./
COPY packages/ui/package.json packages/ui/
COPY apps/portal/package.json apps/portal/
COPY apps/robot-console/package.json apps/robot-console/
RUN npm ci --no-audit --no-fund

COPY packages/ui packages/ui
ARG APP=portal
COPY apps/${APP} apps/${APP}

# Vite inlines VITE_* at build time. Empty values are unset so the app's own
# defaults apply (VITE_API_BASE defaults to "/api", served by nginx below).
ARG VITE_API_BASE
ARG VITE_PORTAL_URL
ARG VITE_ROBOT_CONSOLE_URL
RUN set -eu; \
    for v in VITE_API_BASE VITE_PORTAL_URL VITE_ROBOT_CONSOLE_URL; do \
      eval "val=\${$v:-}"; [ -n "$val" ] || unset "$v"; \
    done; \
    npm --workspace "apps/${APP}" run build

FROM nginxinc/nginx-unprivileged:1.28-alpine
ARG APP=portal
COPY infra/docker/nginx-spa.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/${APP}/dist /usr/share/nginx/html
EXPOSE 8080
