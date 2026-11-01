# Shared check image (WBS-005). Versions must match infra/dev/toolchain.json;
# tests/tooling/test_toolchain.py enforces it inside the container.
FROM node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS node

FROM python:3.13.9-slim-bookworm@sha256:b685a4fa58bb19d1814d78a1ec0f0208f351452724f78b20212c984d6e124a34
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
# The pnpm binary is stored in the image so checks run with a read-only source
# mount and without network at run time.
ENV COREPACK_HOME=/opt/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack \
    && corepack enable --install-directory /usr/local/bin pnpm \
    && corepack install --global pnpm@12.14.0 \
    && pnpm --version

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 LEARNINGXXX_CONTAINER=1
WORKDIR /workspace
CMD ["python", "scripts/check.py"]
