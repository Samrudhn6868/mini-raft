FROM node:18-slim

WORKDIR /app

# Install dependencies first for caching
COPY package.json  ./
RUN npm install
RUN npm install -g nodemon

# Copy the rest of the code
COPY . .

# Expose the Gateway port
EXPOSE 3000
# Expose the internal RAFT ports just in case (though used on localhost)
EXPOSE 5001 5002 5003

# Entry point: start the Gateway which spawns the replicas
CMD ["node", "gateway.js"]
