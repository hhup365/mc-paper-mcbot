FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production --ignore-scripts && npm cache clean --force

COPY index.js .

ENV PORT=8080
ENV PANEL_PASSWORD=admin
EXPOSE $PORT

CMD ["node", "index.js"]
