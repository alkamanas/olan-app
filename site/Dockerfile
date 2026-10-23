# docs.olan.app: static site built from the SDK docs, served by nginx on port 80.
# Build from the root of the olan-app repository (the build needs docs/ and packages/app-sdk/):
#   docker build -f site/Dockerfile -t olan-app-docs .
FROM node:24-alpine AS build
WORKDIR /src
COPY site/package.json site/package-lock.json site/
RUN npm ci --prefix site --ignore-scripts --no-audit --no-fund
COPY docs docs
COPY packages/app-sdk/README.md packages/app-sdk/llms.txt packages/app-sdk/
COPY site/build.mjs site/style.css site/
RUN node site/build.mjs --root /src --out /out

FROM nginx:1.29-alpine
COPY site/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /out /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
