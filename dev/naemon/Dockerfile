# Naemon Core with Livestatus, from the Naemon project's packages, to try
# nuthatch against. Not part of nuthatch.
FROM debian:13-slim

ARG NAEMON_CORE_VERSION=1.5.2-1
ARG NAEMON_LIVESTATUS_VERSION=1.5.1-1

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsS -o /etc/apt/trusted.gpg.d/naemon.asc \
      "https://build.opensuse.org/projects/home:naemon/signing_keys/download?kind=gpg" \
 && echo "deb [signed-by=/etc/apt/trusted.gpg.d/naemon.asc] http://download.opensuse.org/repositories/home:/naemon/Debian_13/ ./" \
      > /etc/apt/sources.list.d/naemon-stable.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      "naemon-core=${NAEMON_CORE_VERSION}" "naemon-livestatus=${NAEMON_LIVESTATUS_VERSION}" \
 && rm -rf /var/lib/apt/lists/*
