FROM node:18

WORKDIR /app

COPY package*.json ./
RUN npm install
RUN npm install -g nodemon

COPY . .

EXPOSE 4000 5001 5002 5003

CMD ["node", "gateway.js"]
