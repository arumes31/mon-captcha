# 3D Voxel CAPTCHA — static, buildless site.
# index.html/test.html load main.js as a native ES module; three.js itself
# resolves from the jsdelivr CDN via the importmap in those two files. There
# is no npm install/build step for the shipped game — nginx just serves the
# files as-is.
FROM nginx:1.27-alpine

COPY index.html /usr/share/nginx/html/index.html
COPY test.html /usr/share/nginx/html/test.html
COPY main.js /usr/share/nginx/html/main.js
COPY style.css /usr/share/nginx/html/style.css
COPY src/ /usr/share/nginx/html/src/

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
