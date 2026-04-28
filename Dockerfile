FROM node:18-slim

WORKDIR /app

COPY package*.json ./

RUN npm install --production --ignore-scripts

COPY index.js .

CMD ["node", "index.js"]
