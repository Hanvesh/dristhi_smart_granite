# syntax=docker/dockerfile:1
# DRISHTI API gateway (FastAPI). Build context: services/gateway
#   docker build -t drishti-gateway services/gateway
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

# Flat module layout (main, store, pipeline, secure_link, ...). Tests and the
# Spring Boot skeleton are excluded via .dockerignore.
COPY *.py ./

RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin app
USER 10001

EXPOSE 8080
# One worker on purpose: robot-link sessions and roam threads live in memory.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080", "--proxy-headers", "--forwarded-allow-ips", "*"]
