FROM --platform=$BUILDPLATFORM alpine:3.20 AS downloader

ARG TARGETARCH

RUN apk add --no-cache curl \
    && curl -fSL "https://github.com/blaxel-ai/sandbox/releases/latest/download/sandbox-api-linux-${TARGETARCH}" \
       -o /sandbox-api \
    && chmod +x /sandbox-api

FROM alpine:3.20

RUN apk add --no-cache bash

COPY --from=downloader /sandbox-api /usr/local/bin/sandbox-api

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/sandbox-api"]