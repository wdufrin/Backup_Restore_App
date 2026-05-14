# Step 1: Build the React app
FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Step 2: Serve the app
FROM node:20-slim
WORKDIR /app
RUN npm install -g sirv-cli
COPY --from=builder /app/dist ./dist
EXPOSE 8080
# Cloud Run sets the PORT environment variable
CMD ["sh", "-c", "sirv dist --port ${PORT:-8080} --single"]
