FROM mcr.microsoft.com/playwright:v1.64.1-jammy
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ENV PORT=3333
EXPOSE 3333
CMD ["node","server.js"]
