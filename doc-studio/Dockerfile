# Playwright image: Chromium and its system libraries are already installed.
# The tag must match the "playwright" version pinned in package.json.
FROM mcr.microsoft.com/playwright:v1.64.1-jammy
WORKDIR /app
COPY package.json package-lock.json ./
# Chromium ships with the image, so skip the postinstall download.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production PORT=3333 DOCSTUDIO_UI=off
EXPOSE 3333
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3333)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","server.js"]
