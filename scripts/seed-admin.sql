-- ============================================================
-- Seed script: Tạo tài khoản Admin mặc định cho Auth Service
-- Chạy sau khi database được khởi tạo (bảng đã có sẵn)
-- Password: Admin@123  (bcrypt salt=10)
-- ============================================================

INSERT INTO users (id, email, password, full_name, phone_number, role, is_active)
VALUES (
  gen_random_uuid(),
  'admin@hospital.local',
  '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', -- Admin@123
  'System Administrator',
  '0900000000',
  'ADMIN',
  true
)
ON CONFLICT (email) DO NOTHING;
