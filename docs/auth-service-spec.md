# Đặc tả Auth Service — Hướng triển khai chi tiết

> Tài liệu này mô tả chi tiết cách triển khai **Auth Service** — service đầu tiên cần code trong hệ thống, vì mọi service khác đều phụ thuộc vào nó để xác thực và phân quyền.

**Tech Stack:**
- **Backend**: NestJS (TypeScript) + TypeORM
- **Database**: PostgreSQL 16
- **Frontend**: React (Vite) + TypeScript
- **Container**: Docker + Docker Compose

---

## 1. Tổng quan Auth Service

### 1.1 Vai trò trong hệ thống

Auth Service là **Utility Service** (Dịch vụ Tiện ích), chịu trách nhiệm:
- Đăng ký tài khoản người dùng (tất cả actor)
- Đăng nhập và phát hành JWT (Access Token + Refresh Token)
- Phân quyền RBAC theo vai trò (Role-Based Access Control)
- Quản lý tài khoản (Admin: tạo/khóa/cấp quyền)
- Ghi audit log cho mọi hành động thay đổi quyền

### 1.2 Tại sao làm trước?

Theo thứ tự triển khai đã xác định (file `xac-dinh-yeu-cau.md` — Bước 7):

> **Auth Service** — mọi service khác đều cần xác thực/RBAC, làm trước tiên hoặc chí ít có bản mock JWT sớm.

Khi Auth Service có API ổn định, các service khác (Patient, Doctor, Appointment...) có thể:
1. Verify JWT token từ request header
2. Kiểm tra role để phân quyền endpoint
3. Lấy `userId` từ token payload để biết "ai đang gọi"

---

## 2. Xác định Actor & Vai trò RBAC

### 2.1 Danh sách Actor → Role

| Actor | Role code | Mô tả | Cách tạo tài khoản |
|-------|-----------|-------|---------------------|
| Thai phụ | `PATIENT` | Người dùng chính, tự đăng ký qua app/web | Tự đăng ký (POST /auth/register) |
| Lễ tân | `RECEPTIONIST` | Nhân sự tiếp đón, xử lý thủ tục | Admin tạo (POST /auth/admin/users) |
| Bác sĩ | `DOCTOR` | Nhân sự khám và tư vấn chuyên môn | Admin tạo |
| Y tá / Hộ sinh | `NURSE` | Nhân sự hỗ trợ nhập liệu, scan hồ sơ | Admin tạo |
| Admin | `ADMIN` | Quản trị viên toàn quyền | Seed sẵn trong DB hoặc Super Admin tạo |

### 2.2 Ma trận phân quyền chi tiết

| Endpoint / Hành động | PATIENT | RECEPTIONIST | DOCTOR | NURSE | ADMIN |
|----------------------|---------|--------------|--------|-------|-------|
| Đăng ký tài khoản | ✅ (tự đăng ký) | ❌ | ❌ | ❌ | ✅ (tạo cho mọi role) |
| Đăng nhập | ✅ | ✅ | ✅ | ✅ | ✅ |
| Xem hồ sơ của chính mình | ✅ | ✅ | ✅ | ✅ | ✅ |
| Sửa hồ sơ của chính mình | ✅ | ✅ | ✅ | ✅ | ✅ |
| Đổi mật khẩu | ✅ | ✅ | ✅ | ✅ | ✅ |
| Xem danh sách tất cả user | ❌ | ❌ | ❌ | ❌ | ✅ |
| Tạo tài khoản nhân sự | ❌ | ❌ | ❌ | ❌ | ✅ |
| Khóa/mở khóa tài khoản | ❌ | ❌ | ❌ | ❌ | ✅ |
| Thay đổi role người dùng | ❌ | ❌ | ❌ | ❌ | ✅ |
| Xem audit log | ❌ | ❌ | ❌ | ❌ | ✅ |

### 2.3 Quy tắc nghiệp vụ đặc biệt

- **Chỉ PATIENT được tự đăng ký** — các role khác (RECEPTIONIST, DOCTOR, NURSE) phải do Admin tạo để tránh tự ý nâng quyền.
- **Admin không thể tự xóa/khóa chính mình** — tránh tình huống không còn Admin nào trong hệ thống.
- **Tài khoản bị khóa (isActive=false)** vẫn tồn tại trong DB nhưng không thể đăng nhập và mọi token cũ bị thu hồi (invalidate tất cả refresh token).

---

## 3. Chiến lược Bảo mật

### 3.1 Token Strategy

| Thành phần | Chi tiết |
|-----------|---------|
| **Access Token** | JWT, thuật toán HS256 (hoặc RS256 nếu cần verify ở nhiều service không share secret); thời hạn **15 phút**; chứa `userId`, `role`, `email` |
| **Refresh Token** | UUID v4 random, lưu DB (bảng `refresh_tokens`); thời hạn **7 ngày**; dùng để cấp access token mới khi hết hạn |
| **Token Rotation** | Mỗi lần dùng refresh token, token cũ bị xóa và phát hành token mới → giảm rủi ro token bị đánh cắp |

### 3.2 JWT Payload

```json
{
  "sub": "uuid-user-id",
  "email": "user@example.com",
  "role": "PATIENT",
  "iat": 1690000000,
  "exp": 1690000900
}
```

### 3.3 Password Hashing

- Sử dụng **bcrypt** với salt round = 10
- Không bao giờ lưu plain text password
- Khi đổi mật khẩu, invalidate tất cả refresh token của user đó

### 3.4 Rate Limiting

| Endpoint | Giới hạn | Lý do |
|----------|---------|-------|
| POST /auth/login | 5 lần/phút/IP | Chống brute-force |
| POST /auth/register | 3 lần/phút/IP | Chống spam tạo tài khoản |
| POST /auth/refresh | 10 lần/phút/user | Chống abuse refresh token |

### 3.5 Bảo mật bổ sung

- **CORS**: Chỉ cho phép origin từ Frontend (localhost:3000 trong dev)
- **Helmet**: Set security headers (X-Frame-Options, X-Content-Type-Options, etc.)
- **Validation**: Dùng `class-validator` của NestJS để validate mọi input (email format, password strength, etc.)
- **Password policy**: Tối thiểu 8 ký tự, phải có ít nhất 1 chữ hoa, 1 chữ thường, 1 số

---

## 4. Đặc tả Endpoint REST

### 4.1 Public Endpoints (không cần token)

#### `POST /auth/register` — Đăng ký tài khoản (chỉ PATIENT)

```
Request Body:
{
  "email": "string (required, valid email)",
  "password": "string (required, min 8 chars)",
  "fullName": "string (required)",
  "phoneNumber": "string (required, VN format)"
}

Response 201:
{
  "id": "uuid",
  "email": "string",
  "fullName": "string",
  "role": "PATIENT",
  "createdAt": "ISO 8601"
}

Error 400: Validation error (email sai format, password yếu...)
Error 409: Email đã tồn tại
```

#### `POST /auth/login` — Đăng nhập

```
Request Body:
{
  "email": "string (required)",
  "password": "string (required)"
}

Response 200:
{
  "accessToken": "JWT string",
  "refreshToken": "UUID string",
  "user": {
    "id": "uuid",
    "email": "string",
    "fullName": "string",
    "role": "PATIENT | RECEPTIONIST | DOCTOR | NURSE | ADMIN"
  }
}

Error 401: Sai email/password hoặc tài khoản bị khóa
```

#### `POST /auth/refresh` — Làm mới token

```
Request Body:
{
  "refreshToken": "UUID string (required)"
}

Response 200:
{
  "accessToken": "JWT string (mới)",
  "refreshToken": "UUID string (mới, token cũ bị xóa)"
}

Error 401: Refresh token không hợp lệ hoặc đã hết hạn
```

### 4.2 Authenticated Endpoints (cần Bearer token)

#### `POST /auth/logout` — Đăng xuất

```
Headers: Authorization: Bearer <accessToken>

Request Body:
{
  "refreshToken": "UUID string (required)"
}

Response 200: { "message": "Logged out successfully" }
```

#### `GET /auth/me` — Xem thông tin cá nhân

```
Headers: Authorization: Bearer <accessToken>

Response 200:
{
  "id": "uuid",
  "email": "string",
  "fullName": "string",
  "phoneNumber": "string",
  "role": "string",
  "isActive": true,
  "createdAt": "ISO 8601",
  "updatedAt": "ISO 8601"
}
```

#### `PATCH /auth/me` — Cập nhật thông tin cá nhân

```
Headers: Authorization: Bearer <accessToken>

Request Body (partial):
{
  "fullName": "string (optional)",
  "phoneNumber": "string (optional)"
}

Response 200: { ...updated user }
Error 400: Validation error
```

#### `PATCH /auth/me/password` — Đổi mật khẩu

```
Headers: Authorization: Bearer <accessToken>

Request Body:
{
  "currentPassword": "string (required)",
  "newPassword": "string (required, min 8 chars)"
}

Response 200: { "message": "Password changed successfully" }
Error 400: Mật khẩu mới không đủ mạnh
Error 401: Mật khẩu hiện tại sai
```

### 4.3 Admin-Only Endpoints (cần role ADMIN)

#### `GET /auth/admin/users` — Danh sách tất cả user

```
Headers: Authorization: Bearer <accessToken> (role=ADMIN)
Query: ?page=1&limit=20&role=DOCTOR&search=keyword

Response 200:
{
  "data": [ { ...user }, ... ],
  "meta": { "total": 100, "page": 1, "limit": 20, "totalPages": 5 }
}
```

#### `POST /auth/admin/users` — Tạo tài khoản nhân sự

```
Headers: Authorization: Bearer <accessToken> (role=ADMIN)

Request Body:
{
  "email": "string (required)",
  "password": "string (required)",
  "fullName": "string (required)",
  "phoneNumber": "string (required)",
  "role": "RECEPTIONIST | DOCTOR | NURSE | ADMIN (required)"
}

Response 201: { ...created user }
Error 400: Validation error
Error 409: Email đã tồn tại
```

#### `PATCH /auth/admin/users/:userId` — Cập nhật tài khoản

```
Headers: Authorization: Bearer <accessToken> (role=ADMIN)

Request Body (partial):
{
  "fullName": "string (optional)",
  "phoneNumber": "string (optional)",
  "role": "string (optional)",
  "isActive": "boolean (optional — true/false để khóa/mở khóa)"
}

Response 200: { ...updated user }
Error 403: Không thể khóa/thay đổi role chính mình
Error 404: User không tồn tại
```

#### `GET /auth/admin/users/:userId` — Xem chi tiết 1 user

```
Headers: Authorization: Bearer <accessToken> (role=ADMIN)

Response 200: { ...user detail }
Error 404: User không tồn tại
```

#### `GET /health` — Health check

```
Response 200: { "status": "ok", "service": "auth-service" }
```

---

## 5. Database Schema (PostgreSQL)

### 5.1 Bảng `users`

```sql
CREATE TABLE users (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email       VARCHAR(255) UNIQUE NOT NULL,
    password    VARCHAR(255) NOT NULL,         -- bcrypt hash
    full_name   VARCHAR(255) NOT NULL,
    phone_number VARCHAR(20),
    role        VARCHAR(20) NOT NULL DEFAULT 'PATIENT'
                CHECK (role IN ('PATIENT', 'RECEPTIONIST', 'DOCTOR', 'NURSE', 'ADMIN')),
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users (email);
CREATE INDEX idx_users_role ON users (role);
```

### 5.2 Bảng `refresh_tokens`

```sql
CREATE TABLE refresh_tokens (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token       VARCHAR(255) UNIQUE NOT NULL,  -- UUID v4
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens (user_id);
CREATE INDEX idx_refresh_tokens_token ON refresh_tokens (token);
```

### 5.3 Bảng `audit_logs` (chỉ cho Auth Service)

```sql
CREATE TABLE audit_logs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID REFERENCES users(id),     -- ai thực hiện
    action      VARCHAR(50) NOT NULL,           -- 'LOGIN', 'REGISTER', 'CHANGE_PASSWORD', 'DEACTIVATE_USER', 'CHANGE_ROLE'
    target_id   UUID,                           -- user bị tác động (nếu có)
    details     JSONB,                          -- chi tiết thay đổi
    ip_address  VARCHAR(45),
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_user ON audit_logs (user_id);
CREATE INDEX idx_audit_logs_action ON audit_logs (action);
CREATE INDEX idx_audit_logs_created ON audit_logs (created_at);
```

### 5.4 Seed data (Admin mặc định)

```sql
INSERT INTO users (email, password, full_name, role) VALUES
('admin@hospital.local', '$2b$10$...hashed...', 'System Admin', 'ADMIN');
```

> Password mặc định: `Admin@123` — bắt buộc đổi sau lần đăng nhập đầu tiên (có thể implement thêm flag `must_change_password`).

---

## 6. Cấu trúc thư mục — Auth Service (NestJS)

Với microservice, chúng ta sẽ giữ cấu trúc gọn gàng: gộp logic quản lý token vào module `auth`, gộp audit log vào module `users`, và gộp các DTO liên quan vào chung một file để giảm bớt số lượng file.

```
services/auth-service/
├── Dockerfile
├── .dockerignore
├── .env.example
├── package.json
├── tsconfig.json
├── nest-cli.json
│
├── src/
│   ├── main.ts                          # Entry point
│   ├── app.module.ts                    # Root module
│   │
│   ├── config/                          # Cấu hình
│   │   ├── database.config.ts           # TypeORM config
│   │   └── app.config.ts                # Env variables (jwt, port...)
│   │
│   ├── auth/                            # Module xác thực (bao gồm cả token)
│   │   ├── auth.module.ts
│   │   ├── auth.controller.ts           # Endpoints: login, register, refresh...
│   │   ├── auth.service.ts              # Business logic (hash, verify, token)
│   │   ├── strategies/
│   │   │   └── jwt.strategy.ts          # Xác thực JWT
│   │   ├── guards/
│   │   │   ├── jwt-auth.guard.ts        # Guard check token
│   │   │   └── roles.guard.ts           # Guard check quyền
│   │   ├── decorators/
│   │   │   ├── current-user.decorator.ts
│   │   │   ├── roles.decorator.ts
│   │   │   └── public.decorator.ts
│   │   ├── auth.dto.ts                  # Gộp các DTO: LoginDto, RegisterDto, RefreshDto...
│   │   └── entities/
│   │       └── refresh-token.entity.ts  # Entity refresh token
│   │
│   ├── users/                           # Module quản lý user và audit
│   │   ├── users.module.ts
│   │   ├── users.controller.ts          # Endpoints cho Admin
│   │   ├── users.service.ts             # CRUD user và hàm ghi audit log
│   │   ├── users.dto.ts                 # Gộp các DTO: CreateUserDto, UpdateUserDto...
│   │   └── entities/
│   │       ├── user.entity.ts           # Entity user
│   │       └── audit-log.entity.ts      # Entity audit log
│   │
│   └── common/                          # Shared utilities
│       ├── http-exception.filter.ts     # Format lỗi thống nhất
│       ├── transform.interceptor.ts     # Format response
│       └── constants.ts                 # Chứa Role Enum
│
└── test/                                # E2E Tests
    └── app.e2e-spec.ts
```

---

## 7. Cấu trúc thư mục — Frontend (React + Vite)

```
frontend/
├── Dockerfile
├── .dockerignore
├── package.json
├── vite.config.ts
├── tsconfig.json
├── index.html
│
├── public/
│   └── favicon.ico
│
└── src/
    ├── main.tsx                          # Entry point
    ├── App.tsx                           # Root component + Router
    ├── vite-env.d.ts
    │
    ├── config/
    │   └── api.ts                        # Axios instance, base URL, interceptors
    │
    ├── contexts/                         # React Context
    │   └── AuthContext.tsx               # AuthProvider: user state, login/logout/refresh
    │
    ├── hooks/                            # Custom hooks
    │   ├── useAuth.ts                    # Lấy user/token từ AuthContext
    │   └── useApi.ts                     # Hook wrapper cho API calls
    │
    ├── services/                         # API call functions
    │   └── authService.ts               # login(), register(), refresh(), getMe()...
    │
    ├── pages/                            # Trang theo route
    │   ├── LoginPage.tsx
    │   ├── RegisterPage.tsx
    │   ├── DashboardPage.tsx             # Redirect theo role
    │   ├── ProfilePage.tsx               # Xem/sửa thông tin cá nhân
    │   ├── ChangePasswordPage.tsx
    │   └── admin/
    │       ├── UserListPage.tsx          # Danh sách user (Admin)
    │       └── UserCreatePage.tsx        # Tạo user nhân sự (Admin)
    │
    ├── components/                       # UI components tái sử dụng
    │   ├── layout/
    │   │   ├── Header.tsx
    │   │   ├── Sidebar.tsx
    │   │   └── MainLayout.tsx
    │   ├── auth/
    │   │   ├── LoginForm.tsx
    │   │   ├── RegisterForm.tsx
    │   │   └── ProtectedRoute.tsx        # Redirect nếu chưa login hoặc sai role
    │   └── common/
    │       ├── Button.tsx
    │       ├── Input.tsx
    │       ├── Alert.tsx
    │       └── LoadingSpinner.tsx
    │
    ├── types/                            # TypeScript types
    │   ├── auth.types.ts                 # User, LoginRequest, LoginResponse...
    │   └── api.types.ts                  # PaginatedResponse, ApiError...
    │
    ├── utils/                            # Utility functions
    │   ├── storage.ts                    # localStorage wrapper cho token
    │   └── validators.ts                # Email/password validation
    │
    └── styles/
        └── index.css                     # Global styles
```

---

## 8. Cấu trúc thư mục tổng thể Project

```
DATN_maternal_healthcare_support_system/
├── README.md
├── GETTING_STARTED.md
├── .env.example
├── .gitignore
├── docker-compose.yml                    # Orchestrate tất cả service
├── Makefile
│
├── docs/
│   ├── analysis-and-design.md
│   ├── architecture.md
│   ├── auth-service-spec.md              # ← File này
│   ├── asset/
│   └── api-specs/
│       └── auth-service.yaml
│
├── frontend/                             # React app (xem Phần 7)
│   ├── Dockerfile
│   └── ...
│
├── gateway/                              # API Gateway (làm sau)
│   ├── Dockerfile
│   └── ...
│
├── services/
│   ├── auth-service/                     # ← Service đầu tiên (xem Phần 6)
│   │   ├── Dockerfile
│   │   └── ...
│   ├── patient-service/                  # (làm sau)
│   ├── doctor-service/                   # (làm sau)
│   ├── appointment-service/              # (làm sau)
│   ├── queue-service/                    # (làm sau)
│   ├── medical-record-service/           # (làm sau)
│   ├── billing-service/                  # (làm sau)
│   ├── notification-service/             # (làm sau)
│   ├── consultation-service/             # (làm sau)
│   └── audit-log-service/               # (làm sau)
│
└── scripts/
    ├── init.sh
    └── seed-admin.sql                    # Script seed Admin mặc định
```

---

## 9. Docker Compose Setup (Auth Service + DB)

Bổ sung vào `docker-compose.yml` hiện tại:

```yaml
services:
  # ─── Auth Service Database ─────────────────────
  auth-db:
    image: postgres:16-alpine
    ports:
      - "${AUTH_DB_PORT:-5433}:5432"
    environment:
      POSTGRES_DB: auth_db
      POSTGRES_USER: ${DB_USER:-admin}
      POSTGRES_PASSWORD: ${DB_PASSWORD:-changeme}
    volumes:
      - auth-db-data:/var/lib/postgresql/data
    networks:
      - app-network
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U admin -d auth_db"]
      interval: 10s
      timeout: 5s
      retries: 5

  # ─── Auth Service ──────────────────────────────
  auth-service:
    build: ./services/auth-service
    ports:
      - "${AUTH_SERVICE_PORT:-5001}:3000"
    env_file:
      - .env
    environment:
      DATABASE_URL: postgres://${DB_USER:-admin}:${DB_PASSWORD:-changeme}@auth-db:5432/auth_db
      JWT_SECRET: ${JWT_SECRET:-your-jwt-secret-change-in-production}
      JWT_EXPIRES_IN: 15m
      REFRESH_TOKEN_EXPIRES_IN: 7d
    depends_on:
      auth-db:
        condition: service_healthy
    networks:
      - app-network
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3

volumes:
  auth-db-data:
```

**Biến môi trường cần thêm vào `.env`:**

```env
# --- Auth Service ---
AUTH_SERVICE_PORT=5001
AUTH_DB_PORT=5433
JWT_SECRET=your-super-secret-jwt-key-change-this
JWT_EXPIRES_IN=15m
REFRESH_TOKEN_EXPIRES_IN=7d
```

---

## 10. Thứ tự triển khai (Step-by-step)

### Bước 1: Khởi tạo NestJS project

```bash
cd services
npx @nestjs/cli new auth-service --package-manager npm --skip-git
cd auth-service
npm install @nestjs/typeorm typeorm pg
npm install @nestjs/jwt @nestjs/passport passport passport-jwt
npm install bcrypt class-validator class-transformer
npm install uuid
npm install @nestjs/throttler        # rate-limiting
npm install @nestjs/config           # env config
npm install helmet                   # security headers
npm install --save-dev @types/bcrypt @types/passport-jwt @types/uuid
```

### Bước 2: Cấu hình database + TypeORM

Tạo `src/config/database.config.ts` → kết nối PostgreSQL qua `DATABASE_URL`.

### Bước 3: Tạo entities + migrations

- `user.entity.ts` → bảng `users`
- `refresh-token.entity.ts` → bảng `refresh_tokens`
- `audit-log.entity.ts` → bảng `audit_logs`
- Chạy migration hoặc `synchronize: true` trong dev.

### Bước 4: Implement Auth Module

1. `auth.service.ts`: register(), login(), refresh(), logout(), changePassword()
2. `jwt.strategy.ts`: Passport JWT strategy
3. Guards: `JwtAuthGuard`, `RolesGuard`
4. Decorators: `@CurrentUser()`, `@Roles()`, `@Public()`

### Bước 5: Implement Users Module (Admin)

1. `users.service.ts`: findAll(), create(), update(), findById()
2. `users.controller.ts`: Admin-only endpoints
3. Pagination, search, filter by role

### Bước 6: Implement Health + Audit

1. `GET /health` → `{ "status": "ok" }`
2. `audit.service.ts`: log() — ghi log khi login, register, change role, deactivate

### Bước 7: Docker + Test

1. Tạo `Dockerfile` (multi-stage build)
2. Cập nhật `docker-compose.yml`
3. Test: `docker compose up --build auth-service auth-db`
4. Verify: `curl http://localhost:5001/health`

---

## 11. Kiểm thử

### 11.1 Unit Test

| Module | Test case |
|--------|-----------|
| AuthService | register: tạo user thành công, email trùng → 409, password yếu → 400 |
| AuthService | login: đúng credentials → token, sai password → 401, tài khoản bị khóa → 401 |
| AuthService | refresh: token hợp lệ → token mới, token hết hạn → 401, token đã dùng → 401 |
| AuthService | changePassword: đúng password cũ → ok, sai password cũ → 401 |
| UsersService | Admin tạo user: role hợp lệ → 201, role không hợp lệ → 400 |
| UsersService | Admin khóa user: thành công + revoke token, khóa chính mình → 403 |

### 11.2 Integration Test (E2E)

```
1. POST /auth/register → 201
2. POST /auth/login → 200 + accessToken + refreshToken
3. GET /auth/me (Bearer token) → 200 + user info
4. PATCH /auth/me (đổi tên) → 200
5. PATCH /auth/me/password → 200
6. POST /auth/refresh → 200 + new tokens
7. POST /auth/logout → 200
8. GET /auth/me (token cũ vẫn valid vì chưa hết hạn) → 200 (stateless JWT)

Admin flow:
9. Login as Admin → token
10. POST /auth/admin/users (tạo DOCTOR) → 201
11. GET /auth/admin/users → 200 + paginated list
12. PATCH /auth/admin/users/:id (khóa user) → 200
13. Login as khóa user → 401
```
