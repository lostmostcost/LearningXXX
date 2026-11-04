FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
RUN apt-get update \
    && apt-get install -y --no-install-recommends libreoffice-impress fonts-noto-cjk fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /work
