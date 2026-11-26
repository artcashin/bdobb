# syntax=docker/dockerfile:1
# Libre Terminal (https://github.com/samlazs/libre-terminal, AGPL-3.0-or-later) installed from a pinned
# commit by its own installer, plus the libre-bdobb guard. Nothing from Libre Terminal is copied into this
# repository; the image fetches it at build time.
ARG PYTHON_IMAGE=python:3.12-slim
FROM ${PYTHON_IMAGE}

# v1.0.0. Change both together; the commit is what is actually built.
ARG LIBRE_VERSION=v1.0.0
ARG LIBRE_COMMIT=ac9b247bdedd0291b35754cfaf88297dbcc349a3
ARG UV_VERSION=0.11.32

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    UV_NO_CACHE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never

# uv runs the upstream installer; procps gives its launcher `ps`.
# Behind a TLS-inspecting proxy, pass its CA with: --secret id=extra_ca,src=/path/to/ca.crt
# mode=0444: apt drops to its own user to download and must still read the CA.
RUN --mount=type=secret,id=extra_ca,required=false,mode=0444 \
    if [ -s /run/secrets/extra_ca ]; then \
      export SSL_CERT_FILE=/run/secrets/extra_ca PIP_CERT=/run/secrets/extra_ca; \
      APT_CA="-o Acquire::https::CAInfo=/run/secrets/extra_ca"; \
    fi; \
    sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get ${APT_CA:-} update \
    && apt-get ${APT_CA:-} install -y --no-install-recommends procps \
    && rm -rf /var/lib/apt/lists/* \
    && python -m pip install "uv==${UV_VERSION}" \
    && useradd --create-home --uid 10001 libre

ADD --chown=10001:10001 https://github.com/samlazs/libre-terminal.git#${LIBRE_COMMIT} /opt/libre-terminal

USER libre
WORKDIR /opt/libre-terminal
# The upstream installer: creates .venv-v5 from config/requirements-v5.lock.txt and builds OpenBB.
RUN --mount=type=secret,id=extra_ca,required=false,uid=10001 \
    if [ -s /run/secrets/extra_ca ]; then export SSL_CERT_FILE=/run/secrets/extra_ca; fi; \
    python scripts/launcher.py install \
    && mkdir -p local /home/libre/.openbb_platform

COPY --chown=10001:10001 guard/guard.py /opt/guard/guard.py
COPY --chown=10001:10001 --chmod=755 entrypoint.sh /opt/guard/entrypoint.sh

LABEL org.opencontainers.image.title="libre-bdobb" \
      org.opencontainers.image.description="Libre Terminal as a BDOBB backend" \
      libre-terminal.version="${LIBRE_VERSION}" libre-terminal.commit="${LIBRE_COMMIT}"

# 7900: OpenBB data backend (widgets.json, apps.json, /api/v1).  7950: Libre Terminal's computed views (/x).
EXPOSE 7900 7950
HEALTHCHECK --interval=30s --timeout=10s --start-period=300s --retries=5 \
    CMD ["python", "-c", "import urllib.request as u; [u.urlopen(f'http://127.0.0.1:{p}/widgets.json', timeout=8).read() for p in (7900, 7950)]"]
ENTRYPOINT ["/opt/guard/entrypoint.sh"]
