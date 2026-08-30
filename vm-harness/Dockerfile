# vm-harness/Dockerfile — QEMU + OVMF + swtpm in a privileged container.
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      qemu-system-x86 qemu-utils ovmf swtpm socat \
      && rm -rf /var/lib/apt/lists/*
WORKDIR /work
COPY vm-harness /work/vm-harness
RUN chmod +x /work/vm-harness/*.sh
