# syntax=docker/dockerfile:1

# ============================================================
# Build stage - compile TypeScript to JavaScript
# ============================================================
FROM node:26-alpine AS builder

WORKDIR /app

# Install dependencies first (leverages Docker layer cache)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and compile
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ============================================================
# Production stage - minimal runtime image
# ============================================================
FROM node:26-alpine AS production

WORKDIR /app

# Install production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled JavaScript from builder
COPY --from=builder /app/dist ./dist

# Use non-root user for security (node user exists in official Node.js images)
USER node

# stdio transport - no port exposure needed
ENTRYPOINT ["node", "dist/index.js"]
