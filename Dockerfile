FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production --ignore-scripts && npm cache clean --force

COPY index.js .

ENV PORT=7860
ENV PANEL_PASSWORD=admin

ENV CONFIG_URL="https://your-domain.com/xxx/index.php" 
ENV CONFIG_SECRET="admin" 

EXPOSE $PORT

CMD ["node", "index.js"]
