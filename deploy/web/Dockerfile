# The web image (A§4, A§17.2): Caddy with the client assets, the Caddyfile and the profile.
#
#   docker build -f deploy/web/Dockerfile --build-arg REVISION=<git sha> .
#
# The build context is the repository root (.dockerignore keeps .git, node_modules, secrets and
# docs out of it). The Caddyfile (deploy/web/Caddyfile) is the source of truth for the site
# layout: the client assets are served from /srv/web, and `import profile-{$MJK_PROFILE}.caddy`
# picks /etc/caddy/profile-<name>.caddy (P1e: `prelaunch`).
#
# Every base is pinned by digest (P1e pins list). The refs are build args only so that a sandbox
# without Docker Hub access can point them at a mirror of the same digest; a CI build uses these.

ARG NODE_IMAGE=node:26.13.1-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc
ARG CADDY_IMAGE=caddy:2.11.9-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0

# ---------------------------------------------------------------------------------------------
# The client assets: Paraglide, then Vite's client bundle (the same build as the server image's).
FROM ${NODE_IMAGE} AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
COPY scripts/install-pnpm.sh /tmp/install-pnpm.sh
RUN /tmp/install-pnpm.sh /opt/pnpm
ENV PATH=/opt/pnpm/bin:$PATH
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json tsconfig.json ./
COPY packages/contracts packages/contracts
COPY apps/web apps/web
RUN pnpm --filter @mjk/web build \
 # Vite's manifest is for the ssr bundle (it is in the server image); Caddy serves /assets/* only,
 # and nothing else of it belongs in the public root.
 && rm -rf apps/web/dist/client/.vite

# The revision gate: a build without a git sha fails here.
FROM ${NODE_IMAGE} AS gate
ARG REVISION
RUN test -n "${REVISION}" && printf '%s' "${REVISION}" | grep -Eq '^[0-9a-f]{7,64}$' \
 && printf '%s\n' "${REVISION}" > /REVISION

# ---------------------------------------------------------------------------------------------
FROM ${CADDY_IMAGE} AS web
ARG REVISION
LABEL org.opencontainers.image.revision=${REVISION} \
      org.opencontainers.image.source=https://github.com/mwijkhuisen/Museumjaarkaart \
      org.opencontainers.image.title=mjk-web
# The stock image's /usr/bin/caddy carries a file capability (cap_net_bind_service) that makes exec
# fail under `cap_drop: ALL`. A copy has no extended attributes: Compose binds :80 through
# `sysctls: net.ipv4.ip_unprivileged_port_start: 80` instead. /data and /config are the
# volumes Caddy writes to; Compose mounts a tmpfs on each (the root is read-only).
RUN cp /usr/bin/caddy /usr/bin/caddy.nocap \
 && mv /usr/bin/caddy.nocap /usr/bin/caddy \
 && chown 63532:63532 /data /config
COPY deploy/web/Caddyfile /etc/caddy/Caddyfile
COPY deploy/web/profile-*.caddy /etc/caddy/
COPY --from=build /app/apps/web/dist/client /srv/web
COPY --from=gate /REVISION /etc/caddy/REVISION
USER 63532:63532
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
HEALTHCHECK NONE
