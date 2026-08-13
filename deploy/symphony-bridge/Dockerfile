FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /opt/symphony-bridge
COPY pyproject.toml ./
COPY app/ ./app/
# The `live` extra (`symphony-bdk-python`) is installed by default: this
# image's entire purpose is to be the one process that ever authenticates to
# Symphony as the bot (see README.md), so an image that can't do that on
# first deploy is a footgun, not a size optimization -- `pip install .`
# alone silently produced an image that ModuleNotFoundError's on its first
# live send (two independent reviewers flagged this). BRIDGE_FAKE=1
# deployments pay a modestly larger image for an extra they don't use, but
# still work unchanged: app/live_client.py only imports `symphony.bdk.*`
# lazily, inside its methods, so its presence has no effect on fake mode.
RUN pip install ".[live]"
CMD ["python", "-m", "app.main"]
