# Monster CAPTCHA — static, buildless site.
# index.html/test.html load main.js as a native ES module; three.js itself
# resolves from the jsdelivr CDN via the importmap in those two files. There
# is no npm install/build step for the shipped game — nginx just serves the
# files as-is.
FROM nginxinc/nginx-unprivileged:1.31-alpine@sha256:901e944d1f4fc2bd077e8f5568b98c1f6f8cdacf6b97a87747c43134a339b9a7

USER root
RUN apk upgrade --no-cache
USER 101

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/index.html
COPY test.html /usr/share/nginx/html/test.html
COPY main.js /usr/share/nginx/html/main.js
COPY style.css /usr/share/nginx/html/style.css
COPY src/ /usr/share/nginx/html/src/
# Embeddable widget for third-party sites (embed/monster-captcha.js) plus its
# integration demo. Served from the same origin as the challenge, because the
# widget derives the challenge origin from its own script src.
COPY embed/ /usr/share/nginx/html/embed/
# Brand mark: the favicon index.html/test.html reference, plus the README's
# banner stills. Without this the image serves a 404 for both.
COPY assets/ /usr/share/nginx/html/assets/

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8080/ >/dev/null || exit 1
