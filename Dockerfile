# The pipe's image. A pipe is a container on the step's Docker service, so it
# carries everything a run uses: Node for the scripts and the CLIs, git, jq
# for the agent's live log, curl for the reachability check, and the Docker
# CLI with Compose and Buildx to start the application on the step's daemon
# (DOCKER_HOST). Buildx is required, not optional: Compose 2.40.2 and later
# refuse a build without Buildx 0.17 or newer.
FROM node:22-bookworm

LABEL org.opencontainers.image.source="https://github.com/ironbee-ai/ironbee-bitbucket" \
      org.opencontainers.image.description="IronBee verification as a Bitbucket Pipe" \
      org.opencontainers.image.licenses="MIT"

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git gnupg jq \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends docker-ce-cli docker-buildx-plugin docker-compose-plugin \
 && rm -rf /var/lib/apt/lists/*

COPY scripts/ /ironbee-bitbucket/scripts/
COPY pipe.sh /pipe.sh
RUN chmod +x /pipe.sh
ENV IRONBEE_BITBUCKET_HOME=/ironbee-bitbucket

ENTRYPOINT ["/pipe.sh"]
