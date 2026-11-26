# The server image (A§4, A§5, A§17.2): every Node role from one image, plus the `backup` image.
#
#   docker build -f deploy/server/Dockerfile --target server --build-arg REVISION=<git sha> .
#   docker build -f deploy/server/Dockerfile --target backup --build-arg REVISION=<git sha> .
#
# The build context is the repository root (.dockerignore keeps .git, node_modules, secrets and
# docs out of it). Compose runs a role as `command: ["api"]`; the entrypoint is `node main.ts`.
#
# Every base is pinned by digest (P1e pins list), as a literal `FROM image:tag@sha256:…` line, so that
# Dependabot's docker updater sees each one (P1e review S10). A sandbox without Docker Hub access builds
# with `--build-context <the FROM ref>=docker-image://<a mirror of the same digest>`, never another ref.
#
# Hand-kept sha256 pins of the binaries (ARCHITECTURE.md §16; Dependabot does not bump them), fetched by
# `ADD --checksum`, so no curl or apt is needed for them:
#   dbmate v2.36.0: the same version and sha256 as .github/workflows/ci.yml;
#   restic 0.19.1: the release tarball (the sha256 matches the release's SHA256SUMS), built from source;
#   go-pmtiles 1.31.2: the release tarball (the sha256 is Waterheight's pin of the same release; the archive
#   holds LICENSE, README.md and pmtiles), a static Go binary.
ARG RESTIC_VERSION=0.19.1

# ---------------------------------------------------------------------------------------------
# The runtime base on its own, so the library stages can ask which libraries it already has.
FROM gcr.io/distroless/cc-debian13:nonroot@sha256:cb87acc574abe719b6e5c547384defa2f7b1f24af9605d3f618cf852495d8be2 AS runtime

# ---------------------------------------------------------------------------------------------
# Build stage: the toolchain, pnpm 12.5.1 from the sha512-checked script (no corepack).
FROM node:26.13.1-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS toolchain
# apt stays here, and only here: scripts/install-pnpm.sh needs curl and the CA bundle to fetch pnpm,
# which it checks against its pinned sha512 itself. Debian's packages are signed; this is a build stage,
# and nothing from apt reaches an image (only node_modules and the build output leave it).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
COPY scripts/install-pnpm.sh /tmp/install-pnpm.sh
RUN /tmp/install-pnpm.sh /opt/pnpm
ENV PATH=/opt/pnpm/bin:$PATH
WORKDIR /app
# Manifests first: the install layers stay cached until a dependency changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json

# Production dependencies of the server only: no dev dependencies, no web, no root tooling.
FROM toolchain AS prod-deps
RUN pnpm install --frozen-lockfile --prod --filter '@mjk/server...'

# Everything the build needs (dev dependencies included).
FROM toolchain AS build
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json tsconfig.json ./
COPY packages/contracts packages/contracts
COPY apps/web apps/web
# The workspace packages resolve to dist through the mjk-dist export condition: Node does not
# strip types inside node_modules (CLAUDE.md gotcha).
RUN node_modules/.bin/tsc -b packages/contracts
# Paraglide, then the client and SSR bundles into apps/web/dist/{client,server}.
RUN pnpm --filter @mjk/web build
# Only apps/web/dist and packages/contracts/dist leave this stage: the web sources, tests and
# messages stay behind (the ssr bundle is one self-contained file).

# The Node binary and the libraries it links that the runtime base lacks (libatomic).
FROM node:26.13.1-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS node-rt
COPY --from=runtime / /rt/
RUN set -eu; \
    mkdir -p /out/usr/local/bin /out/usr/lib/x86_64-linux-gnu; \
    cp /usr/local/bin/node /out/usr/local/bin/node; \
    ldd /usr/local/bin/node | awk '/=> \//{print $3}' | while read -r lib; do \
      base=$(basename "$lib"); \
      [ -e "/rt/usr/lib/x86_64-linux-gnu/$base" ] || cp -L "$lib" "/out/usr/lib/x86_64-linux-gnu/$base"; \
    done; \
    ls /out/usr/lib/x86_64-linux-gnu

# go-pmtiles for the worker's quarterly `tiles_refresh` job (A§15.3, P1d): the tarball is checked by BuildKit,
# and only the binary leaves this stage.
FROM node:26.13.1-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS pmtiles
ADD --checksum=sha256:3ed7dbf4ec2e6dfe5e25b6f70d1ffc932729f93c86db353bf514dd71010a312f \
    https://github.com/protomaps/go-pmtiles/releases/download/v1.31.2/go-pmtiles_1.31.2_Linux_x86_64.tar.gz /tmp/go-pmtiles.tar.gz
RUN mkdir /out && tar -xzf /tmp/go-pmtiles.tar.gz -C /out pmtiles

# The revision gate: a build without a git sha fails here, and the sha is also kept in the image.
FROM node:26.13.1-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS gate
ARG REVISION
RUN test -n "${REVISION}" && printf '%s' "${REVISION}" | grep -Eq '^[0-9a-f]{7,64}$' \
 && printf '%s\n' "${REVISION}" > /REVISION

# ---------------------------------------------------------------------------------------------
FROM runtime AS server
ARG REVISION
LABEL org.opencontainers.image.revision=${REVISION} \
      org.opencontainers.image.source=https://github.com/mwijkhuisen/Museumjaarkaart \
      org.opencontainers.image.title=mjk-server
COPY --from=node-rt /out/ /
# dbmate, sha256-checked by BuildKit (the `migrate` role runs it as mjk_migrator).
ADD --checksum=sha256:47e284b3d8cbad1ba5f090495aa05afd1bbd5f35e2ed5577aad06da74ce780ce --chmod=0555 \
    https://github.com/amacneil/dbmate/releases/download/v2.36.0/dbmate-linux-amd64 /usr/local/bin/dbmate
# go-pmtiles 1.31.2, sha256-checked in its stage (the worker's `tiles_refresh` runs it as /usr/local/bin/pmtiles).
COPY --from=pmtiles --chown=0:0 --chmod=0555 /out/pmtiles /usr/local/bin/pmtiles
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=prod-deps /app/apps/server/node_modules /app/apps/server/node_modules
COPY --from=prod-deps /app/packages/contracts/node_modules /app/packages/contracts/node_modules
COPY package.json /app/package.json
COPY apps/server/package.json /app/apps/server/package.json
COPY apps/server/src /app/apps/server/src
COPY packages/contracts/package.json /app/packages/contracts/package.json
COPY --from=build /app/packages/contracts/dist /app/packages/contracts/dist
COPY db/migrations /app/db/migrations
# apps/web/package.json only for its "type": "module" (the ssr bundle is a .js file there).
COPY --from=build /app/apps/web/package.json /app/apps/web/package.json
COPY --from=build /app/apps/web/dist /app/apps/web/dist
COPY --from=gate /REVISION /app/REVISION
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NODE_ENV=production \
    NODE_OPTIONS=--conditions=mjk-dist
WORKDIR /app
USER 63532:63532
ENTRYPOINT ["/usr/local/bin/node", "/app/apps/server/src/main.ts"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["/usr/local/bin/node", "/app/apps/server/src/main.ts", "healthcheck"]

# ---------------------------------------------------------------------------------------------
# The backup image's tools. pg_dump 18 comes from the pinned postgres image, with exactly the
# libraries ldd lists for it that the runtime base does not already have.
FROM postgres:18.6-trixie@sha256:e3d24f6906d0760bf4da0dae872415391ededefad23fd471c47dc53b0ddf3c42 AS pg
COPY --from=runtime / /rt/
RUN set -eu; \
    mkdir -p /out/usr/local/bin /out/usr/lib/x86_64-linux-gnu; \
    cp /usr/lib/postgresql/18/bin/pg_dump /out/usr/local/bin/pg_dump; \
    ldd /usr/lib/postgresql/18/bin/pg_dump | awk '/=> \//{print $3}' | while read -r lib; do \
      base=$(basename "$lib"); \
      [ -e "/rt/usr/lib/x86_64-linux-gnu/$base" ] || cp -L "$lib" "/out/usr/lib/x86_64-linux-gnu/$base"; \
    done; \
    ls /out/usr/lib/x86_64-linux-gnu

# restic from the release tarball: pinned sha256, a static binary (CGO off), local toolchain only.
FROM golang:1.25.14-trixie@sha256:2c4c60ef415fbfa5e90300722293bef36c5e63fae17570ce18f580af933dbd73 AS restic
ARG RESTIC_VERSION
ENV GOTOOLCHAIN=local CGO_ENABLED=0
WORKDIR /src
ADD --checksum=sha256:bb9b1a19040744d26d8a79be029d4e6b189c45ccc9d8831d7fe367d3c33df725 \
    https://github.com/restic/restic/releases/download/v0.19.1/restic-0.19.1.tar.gz /src/restic.tar.gz
RUN tar -xzf restic.tar.gz --strip-components=1 \
 && go build -trimpath -ldflags "-s -w -X main.version=${RESTIC_VERSION}" -o /restic ./cmd/restic \
 && /restic version

# The `backup` role: the server image plus pg_dump and restic, in no other role's image (Q2).
FROM server AS backup
ARG REVISION
LABEL org.opencontainers.image.title=mjk-backup
COPY --from=pg /out/ /
COPY --from=restic /restic /usr/local/bin/restic
# A one-shot job: it writes no heartbeat, so the server image's healthcheck does not apply.
HEALTHCHECK NONE
