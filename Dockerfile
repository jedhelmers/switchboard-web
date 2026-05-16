# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS web-build
WORKDIR /src
COPY package.json package-lock.json* ./
# Cache npm's package store so a cold rebuild doesn't re-download every dep.
RUN --mount=type=cache,target=/root/.npm \
    npm install
COPY . .
RUN npm run build

FROM golang:1.25-alpine AS go-build
WORKDIR /src
COPY go.mod go.sum* ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download
COPY cmd ./cmd
# Build cache mounts here for the same reason as server/Dockerfile — without
# them, any code change triggers a full from-scratch recompile.
RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/web ./cmd/web

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=go-build /out/web /app/web
COPY --from=web-build /src/dist /app/dist
ENV DIST_DIR=/app/dist
ENV ADDR=:8081
USER nonroot:nonroot
EXPOSE 8081
ENTRYPOINT ["/app/web"]
