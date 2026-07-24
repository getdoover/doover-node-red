# syntax=docker/dockerfile:1
#
# Doover x Node-RED device app image.
#
# Based on the official Node-RED image (pinned LTS on Node 22), with the Doover
# Python/pydoover supervisor installed alongside. The supervisor is the
# entrypoint: it renders settings.js from the app config, then spawns and
# supervises the Node-RED runtime. The Doover palette is pre-installed into the
# Node-RED userDir so on-device customers install nothing.
#
# Multi-arch: the Node-RED base, the astral/uv image and Alpine's python3 are
# all available for linux/amd64 and linux/arm64. No exotic native deps.

# Pinned Node-RED LTS (4.x) on Node 22.
FROM nodered/node-red:4.0.9-22 AS nodered_base


############################################################################
# Stage 1 — pre-install the Doover palette into the Node-RED userDir (/data)
############################################################################
FROM nodered_base AS palette_builder
USER root

# Copy the workspace packages the palette depends on. (packages/ is owned by
# other tasks; here we only consume it.)
COPY packages/ /opt/doover/packages/

# Install the palette + its @doover/nodered-core dependency into the Node-RED
# userDir so the palette is available with zero user action.
#
# --install-links is REQUIRED: without it, `npm install <local-path>` installs
# each package as a SYMLINK into /opt/doover/packages/... . The final image does
# not copy /opt/doover/packages, so those symlinks dangle — the palette fails to
# load and none of the Doover node types register. Worse, a mapped /data volume
# would carry the dangling links. --install-links instead copies the local
# packages (and installs their transitive deps: @grpc, doover-js, protobufjs, …)
# as real files under /data/node_modules, making the userDir fully
# self-contained so the palette survives being copied into a mounted volume.
WORKDIR /data
RUN npm install --omit=dev --install-links --no-audit --no-fund \
        /opt/doover/packages/nodered-core \
        /opt/doover/packages/node-red-contrib-doover \
    && chown -R node-red:node-red /data


############################################################################
# Stage 2 — build the Python supervisor virtualenv with uv
############################################################################
FROM nodered_base AS py_builder
USER root

COPY --from=ghcr.io/astral-sh/uv:0.7.3 /uv /uvx /bin/
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=0

# Alpine python for both amd64 and arm64.
RUN apk add --no-cache python3

WORKDIR /opt/doover/supervisor

# Create the project venv (default .venv) and resolve deps first for caching.
RUN uv venv --python python3
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --locked --no-install-project --no-dev

# Now install the project itself.
COPY pyproject.toml uv.lock README.md ./
COPY src/ ./src/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev


############################################################################
# Final image
############################################################################
FROM nodered_base AS final_image

LABEL com.doover.app="true"
LABEL com.doover.managed="true"

USER root

# Runtime deps for the supervisor + healthcheck. `tini` is a tiny init used as
# PID 1 (see ENTRYPOINT below): it reaps orphaned grandchildren (Node-RED exec/
# daemon/function subprocesses reparented to PID 1) and forwards signals to the
# supervisor, so zombies don't accumulate on a long-running deployment.
RUN apk add --no-cache python3 curl tini

# Python supervisor: virtualenv + source (the .venv references /usr/bin/python3,
# provided by apk in this stage too).
COPY --from=py_builder /opt/doover/supervisor /opt/doover/supervisor

# Node-RED settings template consumed by the supervisor at startup.
COPY settings/ /opt/doover/settings/

# Pre-installed Doover palette in the Node-RED userDir.
COPY --from=palette_builder --chown=node-red:node-red /data /data

ENV PATH="/opt/doover/supervisor/.venv/bin:$PATH" \
    PYTHONPATH="/opt/doover/supervisor/src" \
    DOOVER_NODE_RED_USER_DIR=/data \
    DOOVER_SETTINGS_TEMPLATE=/opt/doover/settings/settings.js.tmpl \
    DOOVER_NODE_RED_PORT=1880

# Healthcheck hits the Node-RED admin API (the /settings endpoint responds even
# with the editor's auth enabled, and is cheap).
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:1880/settings" -o /dev/null || exit 1

USER node-red
WORKDIR /data

# tini runs as PID 1 and reaps zombies + forwards signals (incl. SIGTERM from
# `docker stop`) to the pydoover supervisor, which spawns and manages node-red.
# `-g` forwards signals to the whole process group.
ENTRYPOINT ["/sbin/tini", "-g", "--"]
CMD ["doover-app-run"]
