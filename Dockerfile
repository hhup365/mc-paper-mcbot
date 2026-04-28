FROM node:18-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --production --ignore-scripts && npm cache clean --force

COPY index.js .

ENV PORT=8080
ENV PANEL_PASSWORD=admins
EXPOSE $PORT

CMD ["node", "index.js"]
