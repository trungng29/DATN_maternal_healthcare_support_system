# =====================================================
# Stage 1: Builder
# Build context phải là ROOT của monorepo
# docker build -f services/auth-service/Dockerfile .
# =====================================================
FROM node:20-alpine AS builder

WORKDIR /app

# Copy workspace manifests trước để tận dụng Docker layer cache
COPY package.json package-lock.json ./
COPY libs/common/package.json ./libs/common/
COPY libs/contracts/package.json ./libs/contracts/
COPY services/auth-service/package.json ./services/auth-service/

# Cài đặt toàn bộ dependencies (bao gồm devDependencies để build)
RUN npm ci

# Copy source code
COPY tsconfig.base.json ./
COPY libs/ ./libs/
COPY services/auth-service/ ./services/auth-service/

# Build shared libraries
RUN npm run build -w @app/common
RUN npm run build -w @app/contracts

# Build auth-service
RUN npm run build -w auth-service

# =====================================================
# Stage 2: Runner (Production)
# =====================================================
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Copy chỉ những gì cần thiết cho runtime
COPY package.json package-lock.json ./
COPY libs/common/package.json ./libs/common/
COPY libs/contracts/package.json ./libs/contracts/
COPY services/auth-service/package.json ./services/auth-service/

# Chỉ cài production dependencies
RUN npm ci --omit=dev

# Copy dist đã build từ stage builder
COPY --from=builder /app/libs/common/dist ./libs/common/dist
COPY --from=builder /app/libs/contracts/dist ./libs/contracts/dist
COPY --from=builder /app/services/auth-service/dist ./services/auth-service/dist

EXPOSE 3000

CMD ["node", "services/auth-service/dist/main"]
