# syntax=docker/dockerfile:1
# Hub image: React UI + Go server in one static binary on distroless (no shell, non-root).

FROM node:24-slim AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN mkdir -p ../server/web/dist && npm run build

FROM golang:1.27-alpine AS server
WORKDIR /src/server
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
COPY --from=web /src/server/web/dist ./web/dist
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/hlm-server . \
 && mkdir -p /out/data

FROM gcr.io/distroless/static-debian13:nonroot
COPY --from=server /out/hlm-server /hlm-server
COPY --from=server --chown=65532:65532 /out/data /data
ENV HLM_DATA_DIR=/data HLM_LISTEN=:8080
VOLUME /data
EXPOSE 8080
USER nonroot:nonroot
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["/hlm-server", "healthcheck"]
ENTRYPOINT ["/hlm-server"]
