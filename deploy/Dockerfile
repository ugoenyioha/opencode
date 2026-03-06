FROM oven/bun:1.3.10 AS build

WORKDIR /app

COPY package.json bun.lock ./
COPY packages ./packages
COPY patches ./patches
COPY .github ./.github

RUN bun install
RUN cd packages/opencode && OPENCODE_CHANNEL=latest bun run script/build.ts --single --skip-install

FROM debian:bookworm-slim AS runtime

RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin opencode

WORKDIR /home/opencode

ARG TARGETARCH
COPY --from=build /app/packages/opencode/dist /tmp/dist

RUN if [ "$TARGETARCH" = "amd64" ]; then cp /tmp/dist/opencode-linux-x64/bin/opencode /usr/local/bin/opencode; else cp /tmp/dist/opencode-linux-arm64/bin/opencode /usr/local/bin/opencode; fi

RUN chmod 0755 /usr/local/bin/opencode && mkdir -p /home/opencode/.config/opencode /home/opencode/.local/share/opencode /home/opencode/.local/state/opencode && chown -R opencode:opencode /home/opencode

USER opencode

EXPOSE 4096

ENTRYPOINT ["/usr/local/bin/opencode"]
CMD ["serve", "--hostname", "0.0.0.0", "--port", "4096"]
