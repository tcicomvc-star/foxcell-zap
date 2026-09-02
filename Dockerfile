FROM node:20-alpine

WORKDIR /app

# Instalar git e dependencias necessarias para o Baileys
RUN apk add --no-cache git python3 make g++

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
