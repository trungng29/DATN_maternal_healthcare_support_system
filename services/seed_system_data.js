/**
 * seed_system_data.js
 *
 * DỮ LIỆU DEVELOPMENT/TEST ĐÃ GÁN 36 URL ẢNH CLOUDINARY.
 * Chỉ khởi tạo trên bộ database development mới đã chạy Prisma migrations.
 * Kịch bản Seed Dữ liệu Nền tảng (Foundational / Master Data) cho Hệ thống Hỗ trợ Y tế Thai sản An Tâm
 * Chỉ lưu trữ danh mục gốc, cấu hình và dữ liệu nền cần thiết để hệ thống vận hành.
 * BỎ HOÀN TOÀN: Dữ liệu vận hành/giao dịch (lịch hẹn, hóa đơn, bệnh án, toa thuốc phát sinh,
 * phác đồ, tư vấn, thông báo, nhật ký kiểm toán, lượt khám, vé hàng đợi, tiếp đón, outbox/idempotency/audit)
 * và các tài khoản kiểm thử trạng thái đặc biệt.
 *
 * DỮ LIỆU NỀN TẢNG ĐƯỢC GIỮ LẠI:
 * 1. Auth Service: roles, accounts, credentials, account_roles (Admin, Bác sĩ, Lễ tân, Thai phụ mô phỏng)
 * 2. Doctor Service: specialties, consultation_ranks, clinic_rooms, doctors, doctor_profiles, doctor_specialties, doctor_schedules
 * 3. Receptionist Service: receptionists, receptionist_profiles
 * 4. Catalog Service: catalog_tags, doctor_rank_surcharges, medical_services (kèm content chuẩn), base_prices, links
 * 5. Patient Service: patients, emergency_contacts (với mã hóa AES-256-GCM + HMAC-SHA256 lookup hash)
 * 6. Queue Service: queue_stages (8 chặng điều phối chuẩn)
 * 7. Prescription Service: medication_catalog (13 thuốc chuẩn thai kỳ FDA)
 */

process.env.TZ = 'Asia/Ho_Chi_Minh';
const fs = require('fs');
const path = require('path');

// Tự động nạp .env từ thư mục gốc nếu biến môi trường chưa được set
const rootEnvPath = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(rootEnvPath)) {
  const envContent = fs.readFileSync(rootEnvPath, 'utf8');
  for (const line of envContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const [key, ...rest] = trimmed.split('=');
      const val = rest
        .join('=')
        .trim()
        .replace(/^["'](.*)["']$/, '$1');
      if (process.env[key.trim()] === undefined) {
        process.env[key.trim()] = val;
      }
    }
  }
}

const { Client } = require('pg');
const argon2 = require('argon2');
const crypto = require('crypto');

// Each database participates in the empty-database preflight.
const databaseNames = [
  'auth', 'doctor', 'receptionist', 'catalog', 'patient', 'queue', 'prescription',
  'appointment', 'billing', 'medical-record', 'document', 'treatment-plan',
  'notification', 'audit-log', 'reporting', 'consultation',
];
const foundationTables = {
  auth: 'accounts', doctor: 'specialties', receptionist: 'receptionists',
  catalog: 'medical_services', patient: 'patients', queue: 'queue_stages',
  prescription: 'medication_catalog',
};

function localDatabaseUrl(name) {
  const key = name.toUpperCase().replaceAll('-', '_') + '_DATABASE_URL';
  const value = process.env[key];
  if (!value) throw new Error('Missing local seed database configuration: ' + key);
  const url = new URL(value);
  if (url.protocol !== 'postgresql:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Seed requires PostgreSQL on loopback: ' + name);
  }
  const schema = url.searchParams.get('schema');
  if (schema && schema !== 'public') throw new Error('Seed requires the public schema: ' + name);
  return url.href;
}

const NATIONAL_ID_PEPPER = process.env.PATIENT_NATIONAL_ID_LOOKUP_PEPPER;
const NATIONAL_ID_KEY_BASE64 = process.env.PATIENT_NATIONAL_ID_ENCRYPTION_KEY;

function encryptNationalId(val) {
  const key = Buffer.from(NATIONAL_ID_KEY_BASE64, 'base64');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(val, 'utf8'), cipher.final()]);
  const ciphertext = [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    enc.toString('base64url'),
  ].join('.');
  const lookupHash = crypto
    .createHmac('sha256', NATIONAL_ID_PEPPER)
    .update(val)
    .digest('hex');
  return { ciphertext, lookupHash };
}

function removeAccents(str) {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toUpperCase();
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function normalizePhone(v) {
  if (!v) return v;
  let r = v.trim().replace(/[\s().-]/g, '');
  if (r.startsWith('00')) r = '+' + r.slice(2);
  if (/^0\d{9}$/.test(r)) r = '+84' + r.slice(1);
  if (/^84\d{9}$/.test(r)) r = '+' + r;
  return r;
}

function normalizeSearchName(v) {
  if (!v) return '';
  return v.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('vi-VN');
}

// Mật khẩu mặc định cho tất cả tài khoản Seed
const DEFAULT_PASSWORD = process.env.SEED_DEFAULT_PASSWORD || 'Demo@123456';

async function main() {
  console.log(
    '================================================================',
  );
  console.log(
    '🚀 BẮT ĐẦU QUÁ TRÌNH SEED DỮ LIỆU TOÀN DIỆN CHO TOÀN BỘ HỆ THỐNG',
  );
  console.log(
    '================================================================\n',
  );

  async function createConnectedClient(
    url,
    dbName,
    maxRetries = 8,
    delayMs = 2000,
  ) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const client = new Client({ connectionString: url, connectionTimeoutMillis: 3500, statement_timeout: 20000, lock_timeout: 2000 });
      try {
        await client.connect();
        return client;
      } catch (err) {
        client.end().catch(() => {});
        if (attempt === maxRetries) throw err;
        console.log(
          `⏳ Đang đợi DB ${dbName} sẵn sàng (lần thử ${attempt}/${maxRetries}): ${err.code || err.name}`,
        );
        await new Promise((res) => setTimeout(res, delayMs));
      }
    }
  }

  if (process.env.NODE_ENV === 'production') throw new Error('Không seed trên NODE_ENV=production.');
  const clients = {};
  const checkOnly = process.argv.includes('--check');
  try {
    const urls = Object.fromEntries(databaseNames.map(name => [name, localDatabaseUrl(name)]));
    const targets = new Set(Object.values(urls).map(value => {
      const url = new URL(value);
      return (url.port || '5432') + url.pathname;
    }));
    if (targets.size !== databaseNames.length) throw new Error('Seed database targets must be distinct.');
    if (!NATIONAL_ID_PEPPER || Buffer.from(NATIONAL_ID_KEY_BASE64 || '', 'base64').length !== 32) {
      throw new Error('Set development identity encryption configuration before seeding.');
    }

    for (const [key, url] of Object.entries(urls)) {
      clients[key] = await createConnectedClient(url, key);
    }
    const lock = await clients.auth.query('SELECT pg_try_advisory_lock(221128061) AS locked');
    if (!lock.rows[0].locked) throw new Error('A seed is already in progress.');

    // Migrations can create dictionary entries. Those tables cannot establish that
    // the dataset is initialized. Every other row blocks a fresh seed.
    const migrationData = new Set([
      'auth.roles', 'doctor.consultation_ranks',
      'queue.notification_relay_settings', 'appointment.notification_relay_settings',
      'billing.notification_relay_settings', 'consultation.notification_relay_settings',
      'medical-record.clinical_email_relay_settings',
    ]);
    const populated = [];
    let complete = true;
    for (const [name, client] of Object.entries(clients)) {
      await client.query('BEGIN');
      const { rows } = await client.query("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename");
      if (!rows.some(row => row.tablename === '_prisma_migrations')) {
        throw new Error('Prisma migrations missing: ' + name);
      }
      const [migrations] = (await client.query(
        'SELECT count(*)::int AS applied FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
      )).rows;
      if (!migrations.applied) throw new Error('No completed Prisma migration: ' + name);
      const tables = rows.filter(({ tablename }) =>
        tablename !== '_prisma_migrations' && !migrationData.has(name + '.' + tablename));
      if (!tables.length || (foundationTables[name] && !tables.some(row => row.tablename === foundationTables[name]))) {
        throw new Error('Expected operational schema is missing: ' + name);
      }
      if (!checkOnly) {
        const names = tables.map(({ tablename }) => 'public."' + tablename.replaceAll('"', '""') + '"');
        await client.query('LOCK TABLE ' + names.join(', ') + ' IN SHARE ROW EXCLUSIVE MODE NOWAIT');
      }
      let hasFoundation = false;
      for (const { tablename } of tables) {
        const table = '"' + tablename.replaceAll('"', '""') + '"';
        const { rows: [row] } = await client.query('SELECT EXISTS (SELECT 1 FROM public.' + table + ') AS populated');
        if (row.populated) populated.push(name + '.' + tablename);
        if (tablename === foundationTables[name]) hasFoundation = row.populated;
      }
      if (foundationTables[name] && !hasFoundation) complete = false;
    }
    if (populated.length) {
      console.log('Seed skipped: ' + (complete ? 'initialized databases' : 'operational data or incomplete previous seed') +
        ' (' + populated.join(', ') + ').');
      process.exitCode = complete ? 3 : 4;
      return;
    }
    if (checkOnly) {
      console.log('Fresh development databases ready for seed.');
      return;
    }
    console.log('Khởi tạo bộ dữ liệu demo trên database mới.');

  const passwordHash = await argon2.hash(DEFAULT_PASSWORD);
  const now = new Date();

  // Helper hàm tạo Account trong Auth
  async function createAuthAccount(
    email,
    roleCode,
    customId = null,
    status = 'ACTIVE',
    failedLoginCount = 0,
    lockedUntil = null,
  ) {
    const accRes = await clients.auth.query(
      `INSERT INTO accounts (id, email, status, created_at, updated_at)
       VALUES (COALESCE($1, gen_random_uuid()), $2, $3, NOW(), NOW())
       RETURNING id`,
      [customId, email, status],
    );
    const accountId = accRes.rows[0].id;

    await clients.auth.query(
      `INSERT INTO credentials (account_id, password_hash, password_updated_at, failed_login_count, locked_until)
       VALUES ($1, $2, NOW(), $3, $4)`,
      [accountId, passwordHash, failedLoginCount, lockedUntil],
    );

    const roleRes = await clients.auth.query(
      `SELECT id FROM roles WHERE code = $1`,
      [roleCode],
    );
    if (roleRes.rows.length > 0) {
      await clients.auth.query(
        `INSERT INTO account_roles (account_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [accountId, roleRes.rows[0].id],
      );
    }
    return accountId;
  }

  // ============================================================================
  // 1. AUTH ROLES & HỆ THỐNG VAI TRÒ
  // ============================================================================
  console.log('\n--- BƯỚC 1: KHỞI TẠO VAI TRÒ HỆ THỐNG (AUTH ROLES) ---');
  const rolesDef = [
    ['PATIENT', 'Thai phụ / Người bệnh'],
    ['DOCTOR', 'Bác sĩ chuyên khoa'],
    ['RECEPTIONIST', 'Nhân viên lễ tân / Tiếp đón'],
    ['NURSE', 'Y tá / Hộ sinh phòng khám'],
    ['CLINIC_MANAGER', 'Clinic operations manager'],
    ['ADMIN', 'Quản trị viên toàn hệ thống'],
  ];
  for (const [code, desc] of rolesDef) {
    await clients.auth.query(
      `INSERT INTO roles (id, code, description) VALUES (gen_random_uuid(), $1, $2) ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description`,
      [code, desc],
    );
  }

  // Tài khoản Admin, Quản lý & Y tá
  const adminAccountId = await createAuthAccount('admin@antam.local', 'ADMIN');
  const managerAccountId = await createAuthAccount(
    'manager@antam.local',
    'ADMIN',
  );
  await createAuthAccount('clinic.manager@antam.local', 'CLINIC_MANAGER');
  const nurseAccountId = await createAuthAccount(
    'nurse.huong@antam.local',
    'NURSE',
  );

  console.log(
    '✅ Đã tạo Roles và các tài khoản quản trị/nhân sự (admin, manager, nurse).',
  );

  // ============================================================================
  // 2. CHUYÊN KHOA BÁC SĨ & HẠNG KHÁM & PHỤ PHÍ
  // ============================================================================
  console.log('\n--- BƯỚC 2: KHỞI TẠO DANH MỤC CHUYÊN KHOA & HẠNG BÁC SĨ ---');
  const specialtiesDef = [
    {
      "code": "OBSTETRICS",
      "name": "Sản khoa",
      "slug": "san-khoa",
      "desc": "Khám và quản lý thai nghén, tư vấn chuẩn bị sinh, chăm sóc sản phụ trong hành trình mang thai và sinh nở.",
      "overview": {
        "intro": "Khoa Sản là đầu mối tiếp nhận thai phụ từ khi nghi ngờ mang thai, bắt đầu lập hồ sơ quản lý thai nghén cho đến khi chuẩn bị đón con. Mỗi lần khám là cơ hội để bác sĩ tìm hiểu tình trạng sức khỏe của mẹ, diễn biến của thai, những yếu tố nguy cơ đã biết và các mối quan tâm của gia đình. Khoa chú trọng kết nối các lần thăm khám thành một lộ trình liên tục, để thai phụ hiểu mục đích của từng cuộc hẹn, biết cần chuẩn bị gì và nhận được hướng dẫn theo dõi phù hợp.\n\nTrong quá trình quản lý thai kỳ, bác sĩ phối hợp với đơn vị siêu âm, sàng lọc trước sinh và bệnh lý thai kỳ khi cần đánh giá chuyên sâu. Việc lựa chọn hình thức sinh, phương án giảm đau và các dịch vụ đi kèm được trao đổi dựa trên tình trạng của mẹ và bé, nguyện vọng của gia đình và khả năng chuyên môn của cơ sở. Sau sinh, sản phụ được hướng dẫn tiếp tục theo dõi sức khỏe và liên hệ nhóm chăm sóc sau sinh. Danh mục phục vụ đặt lịch và tìm hiểu thông tin; các quyết định y khoa được xác nhận khi thăm khám trực tiếp.",
        "scopeOfCare": [
          "Khám thai lần đầu và xây dựng hồ sơ theo dõi thai kỳ",
          "Khám thai định kỳ theo kế hoạch cá nhân",
          "Khám chuyên gia khi cần đánh giá sâu tiền sử hoặc nguy cơ",
          "Tư vấn tiêm phòng uốn ván theo tiền sử tiêm chủng",
          "Tư vấn chuẩn bị sinh thường hoặc sinh mổ và phối hợp chăm sóc sau sinh"
        ],
        "standardTitle": "Chăm sóc liên tục, lấy thai phụ làm trung tâm",
        "standardDesc": "Tổ chức thăm khám dựa trên tiền sử, tuổi thai, kết quả đã có và nhu cầu của người bệnh; giải thích rõ lý do chỉ định, lợi ích, giới hạn và bước tiếp theo. Chú trọng quyền được thông tin, sự riêng tư và phối hợp giữa các chuyên khoa.",
        "diagnosticTitle": "Thăm khám và theo dõi thai kỳ",
        "diagnostics": [
          "Đánh giá tiền sử sản khoa, bệnh nền, thuốc và sức khỏe hiện tại",
          "Theo dõi huyết áp, cân nặng và các dấu hiệu cần lưu ý",
          "Đánh giá sự phát triển của thai theo tuổi thai và chỉ định",
          "Lập kế hoạch xét nghiệm, siêu âm, sàng lọc phù hợp",
          "Rà soát kết quả và điều chỉnh lịch theo dõi khi cần"
        ],
        "treatmentTitle": "Chăm sóc và chuẩn bị sinh",
        "treatments": [
          "Tư vấn dinh dưỡng, sinh hoạt và chuẩn bị cho cuộc sinh",
          "Phối hợp đánh giá thai kỳ có nguy cơ cao",
          "Trao đổi phương thức sinh và giảm đau theo chỉ định",
          "Hướng dẫn nhận biết dấu hiệu chuyển dạ và dấu hiệu cần khám ngay",
          "Phối hợp bàn giao chăm sóc mẹ và bé sau sinh"
        ],
        "patientNotes": "Mang sổ khám thai, kết quả siêu âm, xét nghiệm và danh sách thuốc đang dùng. Nếu ra máu nhiều, đau bụng dữ dội, khó thở, đau đầu dữ dội kèm nhìn mờ hoặc có dấu hiệu cấp cứu, không chờ lịch khám thường; hãy đến cơ sở cấp cứu hoặc gọi 115."
      }
    },
    {
      "code": "GYNECOLOGY",
      "name": "Phụ khoa",
      "slug": "phu-khoa",
      "desc": "Khám sức khỏe phụ nữ, đánh giá bệnh lý phụ khoa, siêu âm vùng chậu và sàng lọc ung thư cổ tử cung.",
      "overview": {
        "intro": "Khoa Phụ khoa tiếp nhận phụ nữ có nhu cầu kiểm tra sức khỏe sinh sản định kỳ, gặp thay đổi về kinh nguyệt hoặc có những bất thường cần bác sĩ đánh giá. Hoạt động thăm khám hướng đến tìm hiểu nguyên nhân của vấn đề, không chỉ xử lý triệu chứng. Người bệnh được giải thích trước khi thực hiện các bước khám, được trao đổi về sự riêng tư và có thể nêu những băn khoăn về phương pháp thăm khám.\n\nKhoa cung cấp khám phụ khoa tổng quát, siêu âm tử cung và buồng trứng, cùng dịch vụ tầm soát cổ tử cung bằng xét nghiệm phù hợp. Mỗi dịch vụ có mục tiêu khác nhau: khám tổng quát giúp đánh giá tình trạng hiện tại, siêu âm cung cấp hình ảnh cấu trúc, còn xét nghiệm tầm soát giúp nhận diện nguy cơ cần theo dõi thêm. Kết quả bất thường không mặc nhiên là một chẩn đoán xác định. Bác sĩ sẽ cân nhắc độ tuổi, tiền sử, tình trạng mang thai và kết quả trước đây để lựa chọn bước tiếp theo hoặc chuyển tuyến chuyên môn khi cần. Khoa cũng là nơi hỗ trợ người bệnh chuẩn bị mang thai hoặc cần kiểm tra sức khỏe phụ khoa sau sinh.",
        "scopeOfCare": [
          "Khám phụ khoa định kỳ và đánh giá triệu chứng",
          "Đánh giá rối loạn kinh nguyệt và bất thường vùng chậu",
          "Siêu âm khảo sát tử cung, nội mạc và buồng trứng",
          "Tầm soát cổ tử cung theo tuổi và tiền sử",
          "Tư vấn sức khỏe sinh sản trước mang thai và sau sinh"
        ],
        "standardTitle": "Thăm khám tôn trọng sự riêng tư",
        "standardDesc": "Thực hiện quy trình giải thích và xin đồng ý trước khi khám hoặc lấy mẫu; lựa chọn kỹ thuật theo nhu cầu lâm sàng, tôn trọng quyền từ chối và bảo mật thông tin người bệnh.",
        "diagnosticTitle": "Đánh giá và sàng lọc",
        "diagnostics": [
          "Khai thác tiền sử kinh nguyệt và triệu chứng",
          "Khám phụ khoa khi có sự đồng ý",
          "Siêu âm vùng chậu theo chỉ định",
          "Xét nghiệm tế bào học và HPV khi phù hợp",
          "Tư vấn kết quả và nhu cầu đánh giá bổ sung"
        ],
        "treatmentTitle": "Theo dõi và chăm sóc",
        "treatments": [
          "Tư vấn phương án theo dõi hoặc điều trị sau đánh giá",
          "Hẹn tái khám theo kết quả và nguy cơ",
          "Phối hợp chuyển tuyến khi cần thủ thuật hoặc điều trị chuyên sâu",
          "Giải thích cách chăm sóc sức khỏe sinh sản",
          "Tư vấn các dấu hiệu cần khám sớm"
        ],
        "patientNotes": "Ghi lại chu kỳ kinh, triệu chứng, thuốc và kết quả khám trước. Báo bác sĩ nếu đang mang thai hoặc có khả năng mang thai; hỏi trước về chuẩn bị cho xét nghiệm hoặc siêu âm."
      }
    },
    {
      "code": "PERINATOLOGY",
      "name": "Siêu âm & Sàng lọc trước sinh",
      "slug": "y-hoc-bao-thai-chan-doan-truoc-sinh",
      "desc": "Siêu âm thai và các xét nghiệm sàng lọc trước sinh, hỗ trợ đánh giá sự phát triển và nguy cơ bất thường của thai nhi.",
      "overview": {
        "intro": "Đơn vị Siêu âm và Sàng lọc trước sinh phối hợp với Khoa Sản để cung cấp thông tin về sự phát triển của thai nhi ở các giai đoạn khác nhau. Siêu âm thai 2D hỗ trợ khảo sát vị trí, sự phát triển và những thông tin phù hợp với tuổi thai; siêu âm hình thái tập trung đánh giá cấu trúc giải phẫu. Những thông tin này được sử dụng cùng với khám lâm sàng và các kết quả khác để bác sĩ lựa chọn kế hoạch theo dõi.\n\nCác xét nghiệm Double Test, Triple Test và NIPT có mục tiêu, phạm vi khảo sát và thời điểm thực hiện khác nhau. Đơn vị giải thích sự khác biệt giữa sàng lọc nguy cơ và chẩn đoán xác định, giúp thai phụ hiểu ý nghĩa của kết quả cũng như những giới hạn của phương pháp. Người bệnh có quyền lựa chọn có tham gia sàng lọc hay không sau khi được tư vấn. Nếu kết quả gợi ý nguy cơ cao, không kết luận được hoặc hình ảnh cần kiểm tra thêm, bác sĩ sẽ đề xuất bước đánh giá tiếp theo, có thể bao gồm tư vấn di truyền hoặc chuyển cơ sở chuyên sâu. Không một kết quả sàng lọc đơn lẻ nào bảo đảm loại trừ tất cả bất thường của thai.",
        "scopeOfCare": [
          "Siêu âm thai 2D theo chỉ định",
          "Siêu âm hình thái thai nhi ở giai đoạn phù hợp",
          "Sàng lọc sinh hóa quý một và quý hai",
          "Sàng lọc ADN tự do trong máu mẹ đối với phạm vi xét nghiệm đã tư vấn",
          "Giải thích kết quả, hẹn kiểm tra và phối hợp chuyên khoa"
        ],
        "standardTitle": "Sàng lọc đúng mục tiêu và thời điểm",
        "standardDesc": "Đối chiếu tuổi thai và tiền sử trước khi lựa chọn xét nghiệm; giải thích phạm vi phát hiện, giới hạn kỹ thuật và khả năng cần kiểm tra lại. Không coi hình ảnh 3D/4D là thay thế cho khảo sát giải phẫu chuẩn.",
        "diagnosticTitle": "Siêu âm và xét nghiệm trước sinh",
        "diagnostics": [
          "Khảo sát thai, nhau thai và nước ối theo tuổi thai",
          "Đánh giá hình thái giải phẫu tại mốc được chỉ định",
          "Double Test ở quý một và Triple Test ở quý hai theo quy trình phù hợp",
          "NIPT sàng lọc ba lệch bội thường gặp",
          "Rà soát kết quả cùng dữ liệu lâm sàng"
        ],
        "treatmentTitle": "Tư vấn và phối hợp theo dõi",
        "treatments": [
          "Giải thích kết quả nguy cơ thấp, cao hoặc không kết luận được",
          "Hẹn khảo sát bổ sung nếu hình ảnh chưa đầy đủ",
          "Phối hợp Khoa Sản trong kế hoạch theo dõi",
          "Chuyển tư vấn di truyền hoặc chẩn đoán chuyên sâu khi cần",
          "Hỗ trợ người bệnh hiểu lựa chọn và quyền quyết định"
        ],
        "patientNotes": "Mang kết quả xác định tuổi thai, các lần siêu âm và xét nghiệm đã có. Không tự chọn xét nghiệm chỉ dựa vào tên gói; hỏi nhân viên y tế về thời điểm phù hợp và chuẩn bị trước lấy mẫu."
      }
    },
    {
      "code": "POSTPARTUM_CARE",
      "name": "Chăm sóc mẹ và bé sau sinh",
      "slug": "cham-soc-me-va-be-sau-sinh",
      "desc": "Theo dõi phục hồi của sản phụ, tư vấn nuôi con bằng sữa mẹ và hướng dẫn gia đình chăm sóc trẻ sơ sinh.",
      "overview": {
        "intro": "Đơn vị Chăm sóc mẹ và bé sau sinh tập trung vào giai đoạn chuyển tiếp từ cuộc sinh trở về cuộc sống gia đình. Sau sinh, người mẹ có thể cần được theo dõi quá trình hồi phục thể chất, tình trạng vết khâu hoặc vết mổ, việc đi tiểu, nghỉ ngơi, sức khỏe tinh thần và những khó khăn khi nuôi con. Buổi khám là dịp để trao đổi những thay đổi đang gặp, xem lại hồ sơ ra viện và lập kế hoạch chăm sóc tiếp theo phù hợp với hoàn cảnh.\n\nBên cạnh việc theo dõi sức khỏe sản phụ, đơn vị hướng dẫn gia đình các kỹ năng chăm sóc trẻ sơ sinh hằng ngày, nhận biết dấu hiệu bé cần được đánh giá y tế và hỗ trợ việc cho bú. Nội dung tư vấn được thực hiện với sự đồng ý của gia đình, chú trọng hướng dẫn dễ hiểu và thực hành phù hợp. Trong hệ thống đặt lịch này, dịch vụ hướng dẫn chăm sóc trẻ được đăng ký dưới hồ sơ người mẹ hoặc người chăm sóc; không thay thế buổi khám nhi khoa riêng của trẻ. Nếu mẹ hoặc bé có biểu hiện cấp cứu hoặc tình trạng cần điều trị chuyên khoa, nhân viên y tế sẽ hướng dẫn tiếp cận dịch vụ phù hợp thay vì chờ lịch tư vấn thông thường.",
        "scopeOfCare": [
          "Khám theo dõi sức khỏe và phục hồi của mẹ sau sinh",
          "Tư vấn chăm sóc vết thương và sinh hoạt trong thời kỳ hậu sản",
          "Hỗ trợ nuôi con bằng sữa mẹ và giải quyết khó khăn khi cho bú",
          "Hướng dẫn thực hành giữ vệ sinh, chăm sóc và quan sát trẻ sơ sinh",
          "Nhận biết dấu hiệu cần đánh giá y tế và kết nối chuyên khoa"
        ],
        "standardTitle": "Hỗ trợ gia đình trong thời kỳ hậu sản",
        "standardDesc": "Đặt sức khỏe thể chất, tinh thần và nhu cầu của người mẹ vào trung tâm. Khuyến khích người chăm sóc tham gia học kỹ năng, trao đổi các khó khăn thực tế và thực hiện kế hoạch theo dõi đã thống nhất.",
        "diagnosticTitle": "Đánh giá sức khỏe sau sinh",
        "diagnostics": [
          "Rà soát hồ sơ sinh và ra viện",
          "Đánh giá tình trạng hồi phục, đau và vết thương khi cần",
          "Trao đổi sức khỏe tinh thần, giấc ngủ và nguồn hỗ trợ",
          "Tìm hiểu khó khăn khi cho bú và sinh hoạt",
          "Hướng dẫn nhận biết vấn đề cần khám nhi khoa"
        ],
        "treatmentTitle": "Chăm sóc, tư vấn và tái khám",
        "treatments": [
          "Hướng dẫn chăm sóc mẹ tại nhà và kế hoạch tái khám",
          "Hỗ trợ tư thế cho bú và quan sát dấu hiệu bú hiệu quả",
          "Hướng dẫn gia đình chăm sóc trẻ an toàn",
          "Tư vấn sức khỏe sinh sản sau sinh khi phù hợp",
          "Phối hợp chuyển sản khoa, nhi khoa hoặc cấp cứu khi cần"
        ],
        "patientNotes": "Mang giấy ra viện, hồ sơ sinh, danh sách thuốc và câu hỏi cần tư vấn. Nếu mẹ ra máu nhiều, khó thở, đau ngực, đau đầu dữ dội, hoặc bé khó thở, tím tái, bỏ bú hay li bì, cần đến cơ sở y tế ngay."
      }
    },
    {
      "code": "MATERNAL_MEDICINE",
      "name": "Bệnh lý thai kỳ",
      "slug": "benh-ly-noi-khoa-thai-ky",
      "desc": "Tầm soát và theo dõi nguy cơ bệnh lý trong thai kỳ, chú trọng đường huyết, huyết áp và dinh dưỡng.",
      "overview": {
        "intro": "Khoa Bệnh lý thai kỳ hỗ trợ thai phụ có yếu tố nguy cơ hoặc cần theo dõi những thay đổi về sức khỏe trong quá trình mang thai. Một số vấn đề có thể xuất hiện dù trước đó người mẹ chưa có biểu hiện rõ ràng. Việc khai thác tiền sử, kiểm tra các thông tin lâm sàng và lựa chọn xét nghiệm theo đúng mục tiêu giúp bác sĩ đánh giá tình trạng, nhận diện nhu cầu theo dõi và giải thích những bước cần thực hiện.\n\nDanh mục tập trung vào nghiệm pháp dung nạp glucose, đánh giá nguy cơ tiền sản giật và huyết áp, cùng tư vấn dinh dưỡng cá nhân hóa. Các dịch vụ này bổ sung cho khám thai định kỳ, không thay thế việc quản lý thai nghén của Khoa Sản. Tùy kết quả, bác sĩ có thể phối hợp với các chuyên khoa nội khoa hoặc chuyển cơ sở phù hợp. Khoa không khuyến khích người bệnh tự dùng thuốc, tự điều chỉnh liều hoặc áp dụng một chế độ ăn cứng nhắc dựa trên thông tin danh mục. Việc theo dõi cần dựa trên kết quả đã xác minh và đánh giá trực tiếp, đặc biệt khi có triệu chứng bất thường. Mục tiêu là giúp thai phụ hiểu nguy cơ, chủ động chuẩn bị và duy trì liên hệ với nhân viên y tế.",
        "scopeOfCare": [
          "Tầm soát đái tháo đường thai kỳ theo chỉ định",
          "Đánh giá nguy cơ tiền sản giật và theo dõi huyết áp",
          "Tư vấn dinh dưỡng phù hợp thể trạng và giai đoạn thai kỳ",
          "Rà soát tiền sử bệnh nền và kết quả xét nghiệm",
          "Phối hợp quản lý nguy cơ với Khoa Sản"
        ],
        "standardTitle": "Theo dõi nguy cơ và phối hợp chuyên khoa",
        "standardDesc": "Tổng hợp thông tin từ các lần khám, kết quả xét nghiệm và diễn biến sức khỏe. Hướng dẫn người bệnh hiểu mục đích theo dõi, kế hoạch tái khám và dấu hiệu phải được đánh giá sớm; không suy diễn chẩn đoán từ một chỉ số riêng lẻ.",
        "diagnosticTitle": "Tầm soát và đánh giá",
        "diagnostics": [
          "Nghiệm pháp dung nạp glucose khi phù hợp",
          "Đánh giá huyết áp và yếu tố nguy cơ tiền sản giật",
          "Rà soát nhật ký đường huyết hoặc huyết áp nếu có",
          "Đánh giá thói quen ăn uống và tăng cân theo bối cảnh",
          "Đối chiếu kết quả để quyết định nhu cầu khám bổ sung"
        ],
        "treatmentTitle": "Tư vấn và theo dõi",
        "treatments": [
          "Tư vấn kế hoạch theo dõi cá thể hóa",
          "Hướng dẫn ghi lại thông tin sức khỏe tại nhà nếu được chỉ định",
          "Phối hợp tư vấn dinh dưỡng với quản lý thai nghén",
          "Hẹn đánh giá lại và điều chỉnh kế hoạch bởi bác sĩ",
          "Chuyển chuyên khoa hoặc cấp cứu nếu phát hiện dấu hiệu nguy hiểm"
        ],
        "patientNotes": "Mang kết quả xét nghiệm, danh sách thuốc, sổ khám thai và nhật ký theo dõi nếu có. Riêng OGTT cần xác nhận yêu cầu nhịn ăn và thời điểm thực hiện với cơ sở. Không chờ lịch thường nếu xuất hiện dấu hiệu cấp cứu."
      }
    }
  ];

  const specialtyMap = {};
  for (const sp of specialtiesDef) {
    const res = await clients.doctor.query(
      `INSERT INTO specialties (id, code, name, slug, description, overview, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'ACTIVE', NOW(), NOW()) RETURNING id`,
      [sp.code, sp.name, sp.slug, sp.desc, JSON.stringify(sp.overview)],
    );
    specialtyMap[sp.code] = res.rows[0].id;
  }

  // Danh mục Hạng bác sĩ trong Doctor Service
  const ranksDef = [
    {
      code: 'BASIC',
      name: 'Bác sĩ Sản Phụ khoa',
      shortName: 'Bác sĩ',
      exp: 3,
      surcharge: 0,
      sortOrder: 1,
      desc: 'Bác sĩ chuyên khoa khám, tư vấn và theo dõi thai kỳ định kỳ.',
    },
    {
      code: 'SPECIALIST_I',
      name: 'Bác sĩ Chuyên khoa I (CKI)',
      shortName: 'BS. CKI',
      exp: 6,
      surcharge: 100000,
      sortOrder: 2,
      desc: 'Bác sĩ đào tạo sau đại học CKI, giàu kinh nghiệm khám và xử lý thai kỳ chuyên sâu.',
    },
    {
      code: 'SPECIALIST_II',
      name: 'Bác sĩ Chuyên khoa II (CKII)',
      shortName: 'BS. CKII',
      exp: 12,
      surcharge: 200000,
      sortOrder: 3,
      desc: 'Bác sĩ CKII, chuyên gia đầu ngành trong phẫu thuật sản phụ khoa và chẩn đoán trước sinh.',
    },
    {
      code: 'MASTER',
      name: 'Thạc sĩ Bác sĩ',
      shortName: 'ThS. BS',
      exp: 8,
      surcharge: 150000,
      sortOrder: 4,
      desc: 'Thạc sĩ Sản phụ khoa, cập nhật các phác đồ y khoa hiện đại chuẩn quốc tế.',
    },
    {
      code: 'HEAD_DOCTOR',
      name: 'Bác sĩ Trưởng khoa',
      shortName: 'Trưởng khoa',
      exp: 15,
      surcharge: 250000,
      sortOrder: 5,
      desc: 'Trưởng khoa lâm sàng, quản lý chuyên môn và trực tiếp phụ trách các ca khó.',
    },
    {
      code: 'ASSOC_PROFESSOR',
      name: 'Phó Giáo sư, Tiến sĩ Bác sĩ',
      shortName: 'PGS. TS. BS',
      exp: 18,
      surcharge: 350000,
      sortOrder: 6,
      desc: 'Phó Giáo sư đầu ngành, chuyên gia cố vấn cho các ca thai kỳ phức tạp.',
    },
    {
      code: 'EXPERT',
      name: 'Bác sĩ Chuyên gia cao cấp',
      shortName: 'Chuyên gia',
      exp: 20,
      surcharge: 400000,
      sortOrder: 7,
      desc: 'Chuyên gia cố vấn chuyên môn độc lập nhiều năm kinh nghiệm tại các bệnh viện tuyến TW.',
    },
    {
      code: 'PROFESSOR',
      name: 'Giáo sư, Tiến sĩ Bác sĩ',
      shortName: 'GS. TS. BS',
      exp: 22,
      surcharge: 500000,
      sortOrder: 8,
      desc: 'Giáo sư Sản phụ khoa, hội chẩn liên viện và điều trị bệnh lý nặng.',
    },
  ];

  const rankSurchargeMap = {};
  for (const r of ranksDef) {
    // 1. Lưu danh mục Hạng bác sĩ trong Doctor Service
    await clients.doctor.query(
      `INSERT INTO consultation_ranks (code, name, short_name, experience_years_min, sort_order, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE', NOW(), NOW())
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, short_name = EXCLUDED.short_name, experience_years_min = EXCLUDED.experience_years_min, sort_order = EXCLUDED.sort_order`,
      [r.code, r.name, r.shortName, r.exp, r.sortOrder],
    );

    // 2. Phụ phí hạng bác sĩ trong Catalog Service
    const scRes = await clients.catalog.query(
      `INSERT INTO doctor_rank_surcharges (id, rank_code, amount_minor, currency, effective_from, status, version, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'VND', NOW(), 'ACTIVE', 1, NOW(), NOW()) RETURNING id`,
      [r.code, r.surcharge],
    );
    rankSurchargeMap[r.code] = { id: scRes.rows[0].id, amount: r.surcharge };
  }

  console.log(
    '✅ Đã khởi tạo 5 Chuyên khoa và 8 Hạng Bác sĩ kèm Biểu phí phụ thu hiện hành (ACTIVE).',
  );

  // ============================================================================
  // 3. DANH MỤC DỊCH VỤ, PHÂN LOẠI & GIÁ DỊCH VỤ (CATALOG SERVICE)
  // ============================================================================
  console.log(
    '\n--- BƯỚC 3: KHỞI TẠO DANH MỤC DỊCH VỤ Y TẾ & BẢNG GIÁ (CATALOG) ---',
  );
  // Bỏ nhóm dịch vụ (ServiceCategory) theo yêu cầu - dịch vụ gắn trực tiếp vào chuyên khoa

  const tagsDef = [
    {
      code: 'TRIMESTER_1',
      slug: 'tam-ca-nguyet-1',
      name: '3 tháng đầu (0-13 tuần)',
      group: 'AUDIENCE',
      sort: 1,
    },
    {
      code: 'TRIMESTER_2',
      slug: 'tam-ca-nguyet-2',
      name: '3 tháng giữa (14-27 tuần)',
      group: 'AUDIENCE',
      sort: 2,
    },
    {
      code: 'TRIMESTER_3',
      slug: 'tam-ca-nguyet-3',
      name: '3 tháng cuối (28-40 tuần)',
      group: 'AUDIENCE',
      sort: 3,
    },
    {
      code: 'HIGH_RISK',
      slug: 'thai-ky-nguy-co-cao',
      name: 'Thai kỳ nguy cơ cao',
      group: 'FEATURE',
      sort: 4,
    },
    {
      code: 'ROUTINE',
      slug: 'kham-dinh-ky',
      name: 'Khám định kỳ',
      group: 'LABEL',
      sort: 5,
    },
    {
      code: 'POPULAR',
      slug: 'dich-vu-noi-bat',
      name: 'Dịch vụ nổi bật',
      group: 'LABEL',
      sort: 6,
    },
    {
      code: 'FEMALE_CARE',
      slug: 'cham-soc-nu-gioi',
      name: 'Chăm sóc Nữ giới & Thai phụ',
      group: 'GENDER',
      sort: 7,
    },
    {
      code: 'REPRODUCTIVE_AGE',
      slug: 'do-tuoi-sinh-san',
      name: 'Độ tuổi sinh sản 18-45',
      group: 'AGE',
      sort: 8,
    },
  ];

  const tagMap = {};
  for (const t of tagsDef) {
    const res = await clients.catalog.query(
      `INSERT INTO catalog_tags (id, code, slug, name, "group", description, status, sort_order, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $3, 'ACTIVE', $5, NOW(), NOW()) RETURNING id`,
      [t.code, t.slug, t.name, t.group, t.sort],
    );
    tagMap[t.code] = res.rows[0].id;
  }

  // Nội dung dịch vụ y tế chi tiết (Service Content) nhúng trực tiếp trong file seed
  const SERVICE_CONTENT = {
    "VAC_TETANUS": {
      "schema_version": 1,
      "review": {
        "status": "DRAFT",
        "needs_medical_review": true
      },
      "intro": "Dịch vụ tiếp nhận thai phụ cần rà soát lịch tiêm phòng uốn ván. Nhân viên y tế kiểm tra tiền sử, tình trạng hiện tại và lựa chọn vắc xin, thời điểm tiêm hoặc hẹn lại theo hướng dẫn chuyên môn. Không áp dụng cùng một số mũi cho tất cả thai phụ.\n\nTiêm chủng phòng uốn ván là một nội dung dự phòng trong chăm sóc thai kỳ. Mục tiêu là bảo vệ sức khỏe người mẹ và hỗ trợ phòng bệnh uốn ván liên quan đến sinh nở, trong đó việc xem lại lịch tiêm trước đây có ý nghĩa quan trọng. Thai phụ được giải thích về loại vắc xin dự kiến, những phản ứng có thể gặp, cách theo dõi sau tiêm và trường hợp cần liên hệ y tế. Nếu hồ sơ tiêm chưa đầy đủ, người mẹ nên trao đổi để nhân viên y tế đánh giá thay vì tự quyết định số mũi. Thời điểm cụ thể, loại chế phẩm đang có và khả năng thực hiện tại cơ sở phải được xác nhận trước khi tiêm. Việc đặt lịch chỉ là bước đăng ký khám sàng lọc.",
      "key_facts": [
        {
          "icon": "calendar-days",
          "label": "Lịch tiêm",
          "value": "Theo tiền sử và hướng dẫn"
        },
        {
          "icon": "clipboard-check",
          "label": "Trước tiêm",
          "value": "Khám sàng lọc"
        },
        {
          "icon": "info",
          "label": "Sau tiêm",
          "value": "Theo dõi theo quy định của cơ sở"
        },
        {
          "icon": "file-text",
          "label": "Hồ sơ",
          "value": "Mang sổ tiêm nếu có"
        }
      ],
      "highlights": [
        {
          "icon": "stethoscope",
          "title": "Rà soát lịch",
          "desc": "Kiểm tra hồ sơ và số mũi đã tiêm."
        },
        {
          "icon": "clipboard-check",
          "title": "Sàng lọc",
          "desc": "Đánh giá tình trạng sức khỏe và tiền sử phản ứng."
        },
        {
          "icon": "message-circle",
          "title": "Tư vấn",
          "desc": "Giải thích chế phẩm và lịch phù hợp."
        },
        {
          "icon": "shield-check",
          "title": "Theo dõi",
          "desc": "Hướng dẫn theo dõi và ghi nhận sau tiêm."
        }
      ],
      "suitable_for": [
        "Thai phụ muốn kiểm tra lịch phòng uốn ván",
        "Thai phụ chưa rõ tiền sử tiêm chủng",
        "Thai phụ được nhân viên y tế hẹn mũi tiếp theo"
      ],
      "not_suitable_for": [
        "Cần đánh giá trước nếu từng phản ứng dị ứng nặng với vắc xin",
        "Có bệnh cấp tính hoặc tình huống cần xử trí trước tiêm: trao đổi bác sĩ"
      ],
      "process_steps": [
        {
          "title": "Kiểm tra hồ sơ",
          "desc": "Đối chiếu sổ tiêm và thông tin thai kỳ.",
          "duration_minutes": null
        },
        {
          "title": "Sàng lọc",
          "desc": "Hỏi tiền sử dị ứng, bệnh và phản ứng trước đây.",
          "duration_minutes": null
        },
        {
          "title": "Tiêm khi đủ điều kiện",
          "desc": "Nhân viên y tế thực hiện theo chế phẩm và quy trình được duyệt.",
          "duration_minutes": null
        },
        {
          "title": "Theo dõi",
          "desc": "Ghi nhận và hướng dẫn phản ứng cần lưu ý.",
          "duration_minutes": null
        }
      ],
      "preparation": [
        "Mang sổ tiêm và sổ khám thai",
        "Báo tiền sử dị ứng và thuốc",
        "Trao đổi nếu đang sốt hoặc mới mắc bệnh"
      ],
      "aftercare": [
        "Theo dõi theo hướng dẫn của nhân viên y tế",
        "Giữ chứng từ hoặc sổ ghi nhận mũi tiêm",
        "Không tự dùng thuốc xử trí phản ứng khi chưa được hướng dẫn"
      ],
      "warning_signs": [
        "Khó thở, sưng môi hoặc mặt, ngất sau tiêm: cần cấp cứu ngay.",
        "Ra máu nhiều, đau bụng dữ dội, khó thở hoặc ngất: cần hỗ trợ y tế ngay, không chờ lịch khám thường."
      ],
      "accuracy_note": "Khả năng bảo vệ phụ thuộc lịch tiêm phù hợp; tiêm chủng không thay thế chăm sóc thai sản và quy trình sinh an toàn.",
      "faqs": [
        {
          "q": "Có phải ai cũng tiêm cùng số mũi không?",
          "a": "Không. Lịch phụ thuộc tiền sử, loại vắc xin và hướng dẫn chuyên môn."
        },
        {
          "q": "Không nhớ đã tiêm thì sao?",
          "a": "Mang giấy tờ có sẵn và để nhân viên y tế đánh giá."
        },
        {
          "q": "Đặt lịch có chắc chắn được tiêm không?",
          "a": "Cần khám sàng lọc và xác nhận chế phẩm trước khi thực hiện."
        }
      ],
      "performed_by": "Nhân viên y tế được phân công tiêm chủng",
      "references": [
        {
          "title": "Tetanus vaccines: WHO position paper (2017)",
          "org": "WHO"
        },
        {
          "title": "WHO recommendations on antenatal care for a positive pregnancy experience (2016)",
          "org": "WHO"
        }
      ],
      "disclaimer": "Thông tin danh mục phục vụ mô phỏng hệ thống Tâm An, chỉ mang tính tham khảo và cần được rà soát chuyên môn trước khi sử dụng thực tế. Không thay thế thăm khám, chẩn đoán hoặc điều trị. Phạm vi dịch vụ, chỉ định, chi phí và khả năng tiếp nhận phải được cơ sở xác nhận."
    },
    "POSTPARTUM_NEWBORN_CARE": {
      "schema_version": 1,
      "review": {
        "status": "DRAFT",
        "needs_medical_review": true
      },
      "intro": "Dịch vụ hướng dẫn thực hành chăm sóc trẻ trong thời kỳ sau sinh, tập trung vào các kỹ năng thường ngày và nhận biết dấu hiệu cần đi khám. Buổi hẹn đăng ký theo hồ sơ người mẹ/người chăm sóc; không thay thế khám nhi khoa, tiêm chủng hoặc điều trị cho trẻ.\n\nGiai đoạn đầu chăm sóc trẻ sơ sinh thường khiến gia đình có nhiều băn khoăn về giữ ấm, vệ sinh, thay tã, quan sát việc bú và cách tổ chức không gian ngủ. Buổi hướng dẫn giúp người chăm sóc trao đổi nhu cầu, quan sát nhân viên chuyên môn minh họa và thực hành các thao tác phù hợp trong phạm vi chăm sóc thường quy. Gia đình được giải thích vì sao cần nhận biết những dấu hiệu bất thường thay vì chỉ dựa vào kinh nghiệm truyền miệng. Nếu trẻ cần được thăm khám, thực hiện thủ thuật điều trị hoặc có dấu hiệu nguy hiểm, phải chuyển đến dịch vụ nhi khoa thích hợp và lập hồ sơ theo quy định của cơ sở. Đây là buổi thực hành giáo dục sức khỏe cho gia đình, không tự tạo đơn thuốc hoặc can thiệp điều trị cho trẻ. Chính sách hạng cơ bản bao gồm trong giá là cấu hình mô phỏng cho buổi thực hành.",
      "key_facts": [
        {
          "icon": "calendar-days",
          "label": "Đối tượng đặt lịch",
          "value": "Mẹ hoặc người chăm sóc"
        },
        {
          "icon": "clipboard-check",
          "label": "Phạm vi",
          "value": "Hướng dẫn thực hành chăm sóc thường quy"
        },
        {
          "icon": "info",
          "label": "Hạng bác sĩ",
          "value": "Hạng cơ bản theo cấu hình giá"
        },
        {
          "icon": "file-text",
          "label": "Giới hạn",
          "value": "Không phải khám hoặc điều trị nhi khoa"
        }
      ],
      "highlights": [
        {
          "icon": "stethoscope",
          "title": "Học qua thực hành",
          "desc": "Minh họa thao tác chăm sóc phù hợp."
        },
        {
          "icon": "clipboard-check",
          "title": "Hỗ trợ gia đình",
          "desc": "Trao đổi cách tổ chức chăm sóc tại nhà."
        },
        {
          "icon": "message-circle",
          "title": "An toàn",
          "desc": "Nhận biết khi trẻ cần đánh giá y tế."
        },
        {
          "icon": "shield-check",
          "title": "Phối hợp",
          "desc": "Giới thiệu dịch vụ khám phù hợp khi cần."
        }
      ],
      "suitable_for": [
        "Sản phụ mới sinh muốn học cách chăm sóc trẻ",
        "Người thân trực tiếp chăm sóc bé",
        "Gia đình muốn củng cố kỹ năng trước khi về nhà"
      ],
      "not_suitable_for": [
        "Không thay thế đánh giá nhi khoa khi trẻ có dấu hiệu bất thường",
        "Không thực hiện can thiệp, tiêm chủng hoặc thủ thuật điều trị ngoài phạm vi buổi hướng dẫn"
      ],
      "process_steps": [
        {
          "title": "Tiếp nhận",
          "desc": "Ghi nhu cầu và thông tin liên quan đến việc chăm sóc.",
          "duration_minutes": null
        },
        {
          "title": "Minh họa",
          "desc": "Nhân viên hướng dẫn các kỹ năng phù hợp.",
          "duration_minutes": null
        },
        {
          "title": "Thực hành",
          "desc": "Người chăm sóc thực hành dưới hướng dẫn khi thích hợp.",
          "duration_minutes": null
        },
        {
          "title": "Tổng kết",
          "desc": "Giải thích dấu hiệu cần đi khám và cách tiếp tục học.",
          "duration_minutes": null
        }
      ],
      "preparation": [
        "Mang hướng dẫn ra viện nếu có",
        "Ghi các câu hỏi về vệ sinh, giữ ấm, ngủ hoặc bú",
        "Xác nhận trước nếu muốn mang trẻ đến buổi hướng dẫn"
      ],
      "aftercare": [
        "Thực hiện các kỹ năng đã được nhân viên hướng dẫn",
        "Trao đổi nếu còn khó khăn",
        "Đưa trẻ đi đánh giá nếu có dấu hiệu nguy hiểm"
      ],
      "warning_signs": [
        "Trẻ khó thở, tím tái, li bì, bỏ bú hoặc có bất thường nhiệt độ: đưa trẻ đi đánh giá y tế ngay."
      ],
      "accuracy_note": "Không thay thế đánh giá, theo dõi và điều trị nhi khoa. Nội dung cụ thể cần được cơ sở xác nhận trước khi thực hiện.",
      "faqs": [
        {
          "q": "Dịch vụ có khám bệnh cho bé không?",
          "a": "Không. Đây là buổi hướng dẫn người chăm sóc; trẻ cần khám theo quy trình nhi khoa riêng."
        },
        {
          "q": "Có được thực hành không?",
          "a": "Có thể thực hành với phương tiện phù hợp dưới hướng dẫn."
        },
        {
          "q": "Bé đang bỏ bú thì đặt dịch vụ này được không?",
          "a": "Không chờ buổi hướng dẫn; đưa bé đi đánh giá y tế ngay."
        }
      ],
      "performed_by": "Nhân viên hộ sinh hoặc điều dưỡng được phân công; bác sĩ phối hợp khi cần",
      "references": [
        {
          "title": "WHO recommendations on maternal and newborn care for a positive postnatal experience (2022)",
          "org": "WHO"
        }
      ],
      "disclaimer": "Thông tin danh mục phục vụ mô phỏng hệ thống Tâm An, chỉ mang tính tham khảo và cần được rà soát chuyên môn trước khi sử dụng thực tế. Không thay thế thăm khám, chẩn đoán hoặc điều trị. Phạm vi dịch vụ, chỉ định, chi phí và khả năng tiếp nhận phải được cơ sở xác nhận."
    },
    "PRENATAL_VIP": {
      "schema_version": 1,
      "review": {
        "status": "DRAFT",
        "needs_medical_review": true
      },
      "intro": "Dịch vụ dành cho thai phụ muốn trao đổi kỹ với bác sĩ về tiền sử sản khoa, bệnh nền hoặc các kết quả cần đánh giá thêm. Bác sĩ tổng hợp hồ sơ và tư vấn lộ trình theo dõi; hạng bác sĩ thực tế phụ thuộc lựa chọn và lịch trống. Không bao gồm mặc định các xét nghiệm chuyên sâu.\n\nKhám chuyên gia có trọng tâm là đánh giá tổng hợp các thông tin đã có và hỗ trợ thai phụ hiểu những lựa chọn trong quá trình theo dõi. Người mẹ có thể mang kết quả từ nhiều cơ sở, trình bày những vấn đề từng gặp ở lần mang thai trước và trao đổi những điều chưa rõ. Buổi tư vấn không tự động có nghĩa thai kỳ đang gặp biến chứng hoặc cần một gói điều trị đắt hơn. Khi cần đánh giá dinh dưỡng chuyên biệt, xét nghiệm hoặc siêu âm, bác sĩ sẽ giải thích mục tiêu và lựa chọn dịch vụ riêng. Phần quan trọng của buổi khám là thống nhất kế hoạch tiếp theo và phân biệt việc theo dõi thường quy với vấn đề cần xử lý sớm.",
      "key_facts": [
        {
          "icon": "calendar-days",
          "label": "Mục tiêu",
          "value": "Đánh giá tổng hợp"
        },
        {
          "icon": "clipboard-check",
          "label": "Hồ sơ",
          "value": "Kết quả cũ và tiền sử"
        },
        {
          "icon": "info",
          "label": "Hạng bác sĩ",
          "value": "Theo lịch và lựa chọn hợp lệ"
        },
        {
          "icon": "file-text",
          "label": "Kết quả",
          "value": "Kế hoạch theo dõi"
        }
      ],
      "highlights": [
        {
          "icon": "stethoscope",
          "title": "Rà soát hồ sơ",
          "desc": "Tổng hợp kết quả, diễn biến và câu hỏi của thai phụ."
        },
        {
          "icon": "clipboard-check",
          "title": "Đánh giá nguy cơ",
          "desc": "Xem xét bệnh nền và tiền sử trong bối cảnh hiện tại."
        },
        {
          "icon": "message-circle",
          "title": "Tư vấn lựa chọn",
          "desc": "Giải thích lý do cần hoặc không cần kiểm tra thêm."
        },
        {
          "icon": "shield-check",
          "title": "Phối hợp chuyên khoa",
          "desc": "Đề xuất chuyên khoa phù hợp nếu phát hiện nhu cầu."
        }
      ],
      "suitable_for": [
        "Thai phụ có tiền sử hoặc kết quả cần xem xét kỹ",
        "Thai phụ cần ý kiến chuyên môn bổ sung",
        "Thai phụ muốn xây dựng kế hoạch quản lý rõ ràng"
      ],
      "not_suitable_for": [
        "Không thay thế cấp cứu",
        "Không bảo đảm khám với một chức danh cụ thể nếu chưa xác nhận lịch"
      ],
      "parameters": [
        {
          "name": "Tiền sử",
          "desc": "Đánh giá các yếu tố nguy cơ",
          "reference": "Theo đánh giá và quy trình của cơ sở"
        },
        {
          "name": "Kết quả trước",
          "desc": "Rà soát thông tin có liên quan",
          "reference": "Theo đánh giá và quy trình của cơ sở"
        },
        {
          "name": "Kế hoạch",
          "desc": "Lựa chọn theo tình trạng cá nhân",
          "reference": "Theo đánh giá và quy trình của cơ sở"
        }
      ],
      "process_steps": [
        {
          "title": "Tiếp nhận",
          "desc": "Thu thập hồ sơ và mục tiêu tư vấn.",
          "duration_minutes": null
        },
        {
          "title": "Rà soát",
          "desc": "Bác sĩ đọc kết quả và đánh giá tình trạng.",
          "duration_minutes": null
        },
        {
          "title": "Trao đổi",
          "desc": "Giải thích các lựa chọn và giới hạn.",
          "duration_minutes": null
        },
        {
          "title": "Kế hoạch",
          "desc": "Thống nhất nội dung cần theo dõi và lần hẹn.",
          "duration_minutes": null
        }
      ],
      "preparation": [
        "Mang hồ sơ trước đây và danh sách thuốc",
        "Ghi câu hỏi ưu tiên",
        "Mang nhật ký huyết áp hoặc đường huyết nếu có"
      ],
      "aftercare": [
        "Giữ bản tóm tắt tư vấn",
        "Không tự thay đổi thuốc",
        "Hẹn kiểm tra theo kế hoạch đã thống nhất"
      ],
      "warning_signs": [
        "Ra máu nhiều, đau bụng dữ dội, khó thở hoặc ngất: cần hỗ trợ y tế ngay, không chờ lịch khám thường.",
        "Đau đầu dữ dội, nhìn mờ, khó thở hoặc đau vùng thượng vị dữ dội: cần đến cơ sở y tế ngay."
      ],
      "faqs": [
        {
          "q": "Khác khám định kỳ thế nào?",
          "a": "Buổi khám dành trọng tâm cho đánh giá chuyên sâu và rà soát kế hoạch; không phải mọi thai phụ cần dịch vụ này."
        },
        {
          "q": "Có bao gồm xét nghiệm không?",
          "a": "Các xét nghiệm được chỉ định và báo giá riêng."
        },
        {
          "q": "Có thể chọn hạng bác sĩ không?",
          "a": "Có, theo chính sách và lịch khả dụng."
        }
      ],
      "performed_by": "Bác sĩ Sản khoa theo hạng đã xác nhận",
      "references": [
        {
          "title": "WHO recommendations on antenatal care for a positive pregnancy experience (2016)",
          "org": "WHO"
        }
      ],
      "disclaimer": "Thông tin danh mục phục vụ mô phỏng hệ thống Tâm An, chỉ mang tính tham khảo và cần được rà soát chuyên môn trước khi sử dụng thực tế. Không thay thế thăm khám, chẩn đoán hoặc điều trị. Phạm vi dịch vụ, chỉ định, chi phí và khả năng tiếp nhận phải được cơ sở xác nhận."
    },
    "GYN_TRANSVAGINAL_US": {
      "schema_version": 1,
      "review": {
        "status": "DRAFT",
        "needs_medical_review": true
      },
      "intro": "Siêu âm vùng chậu bằng đầu dò âm đạo hỗ trợ quan sát các cấu trúc cần đánh giá. Bác sĩ trao đổi về mục đích, kỹ thuật, sự đồng ý và lựa chọn phương pháp khác khi không phù hợp. Kết quả được xem xét cùng triệu chứng và tiền sử.\n\nDịch vụ giúp bác sĩ thu thập thông tin hình ảnh về tử cung, nội mạc, buồng trứng và các cấu trúc vùng chậu có thể quan sát được. Đây là kỹ thuật hỗ trợ đánh giá những vấn đề như thay đổi kinh nguyệt, nghi ngờ u xơ hoặc u nang và các tình trạng cần theo dõi. Cách thực hiện được giải thích trước, người bệnh có quyền nêu lo lắng và không tiếp tục nếu không đồng ý. Tùy tình trạng và mục đích, bác sĩ có thể lựa chọn đường khảo sát khác. Không phải mọi hình ảnh bất thường đều phản ánh bệnh lý nghiêm trọng, và siêu âm không thể tự xác định bản chất của mọi tổn thương. Người bệnh nên mang kết quả trước đây để hỗ trợ so sánh và được tư vấn về những kiểm tra tiếp theo nếu cần.",
      "key_facts": [
        {
          "icon": "calendar-days",
          "label": "Kỹ thuật",
          "value": "Siêu âm đầu dò âm đạo khi phù hợp"
        },
        {
          "icon": "clipboard-check",
          "label": "Khảo sát",
          "value": "Tử cung, nội mạc, buồng trứng"
        },
        {
          "icon": "info",
          "label": "Đồng ý",
          "value": "Giải thích trước thực hiện"
        },
        {
          "icon": "file-text",
          "label": "Chuẩn bị",
          "value": "Theo hướng dẫn nhân viên y tế"
        }
      ],
      "highlights": [
        {
          "icon": "stethoscope",
          "title": "Khảo sát vùng chậu",
          "desc": "Hỗ trợ quan sát cấu trúc phù hợp mục tiêu."
        },
        {
          "icon": "clipboard-check",
          "title": "Phương pháp phù hợp",
          "desc": "Có thể lựa chọn cách khảo sát khác."
        },
        {
          "icon": "message-circle",
          "title": "Quyền riêng tư",
          "desc": "Tôn trọng sự đồng ý và thoải mái của người bệnh."
        },
        {
          "icon": "shield-check",
          "title": "So sánh",
          "desc": "Đối chiếu kết quả với khám và hình ảnh trước."
        }
      ],
      "suitable_for": [
        "Người được chỉ định siêu âm vùng chậu",
        "Người cần đánh giá tử cung hoặc buồng trứng",
        "Người cần theo dõi một phát hiện trên siêu âm trước"
      ],
      "not_suitable_for": [
        "Không thực hiện nếu người bệnh không đồng ý",
        "Cần đánh giá khẩn nếu chảy máu nhiều, đau dữ dội hoặc choáng"
      ],
      "parameters": [
        {
          "name": "Tử cung",
          "desc": "Kích thước và cấu trúc quan sát được",
          "reference": "Theo đánh giá và quy trình của cơ sở"
        },
        {
          "name": "Nội mạc",
          "desc": "Thông tin cần đối chiếu giai đoạn và tiền sử",
          "reference": "Theo đánh giá và quy trình của cơ sở"
        },
        {
          "name": "Buồng trứng",
          "desc": "Cấu trúc và phát hiện cần đánh giá",
          "reference": "Theo đánh giá và quy trình của cơ sở"
        },
        {
          "name": "Vùng chậu",
          "desc": "Thông tin bổ sung khi có chỉ định",
          "reference": "Theo đánh giá và quy trình của cơ sở"
        }
      ],
      "process_steps": [
        {
          "title": "Rà soát",
          "desc": "Xác nhận lý do và hồ sơ.",
          "duration_minutes": null
        },
        {
          "title": "Giải thích",
          "desc": "Trao đổi phương pháp và sự đồng ý.",
          "duration_minutes": null
        },
        {
          "title": "Khảo sát",
          "desc": "Thực hiện theo điều kiện và chỉ định.",
          "duration_minutes": null
        },
        {
          "title": "Trả báo cáo",
          "desc": "Giải thích thông tin và hướng theo dõi.",
          "duration_minutes": null
        }
      ],
      "preparation": [
        "Mang báo cáo siêu âm trước",
        "Hỏi yêu cầu chuẩn bị bàng quang",
        "Báo bác sĩ về khả năng mang thai và bất kỳ lo ngại nào"
      ],
      "aftercare": [
        "Giữ báo cáo để đối chiếu",
        "Trao đổi kết quả tại buổi khám",
        "Hẹn kiểm tra lại nếu được chỉ định"
      ],
      "warning_signs": [
        "Đau vùng chậu tăng, ra máu nhiều hoặc sốt: liên hệ cơ sở y tế."
      ],
      "accuracy_note": "Siêu âm có giới hạn về khả năng quan sát và kết luận. Bác sĩ đối chiếu với thông tin lâm sàng trước khi quyết định.",
      "faqs": [
        {
          "q": "Có bắt buộc dùng đầu dò âm đạo không?",
          "a": "Không. Bác sĩ giải thích và cân nhắc phương pháp khác khi phù hợp."
        },
        {
          "q": "Có thay thế khám phụ khoa không?",
          "a": "Không. Siêu âm hỗ trợ đánh giá hình ảnh."
        },
        {
          "q": "Siêu âm có xác định lành hay ác tính chắc chắn không?",
          "a": "Không phải mọi trường hợp; có thể cần phương pháp bổ sung."
        }
      ],
      "performed_by": "Bác sĩ hoặc nhân viên siêu âm được phân công",
      "references": [
        {
          "title": "Transvaginal ultrasound - Medical Encyclopedia",
          "org": "MedlinePlus"
        }
      ],
      "disclaimer": "Thông tin danh mục phục vụ mô phỏng hệ thống Tâm An, chỉ mang tính tham khảo và cần được rà soát chuyên môn trước khi sử dụng thực tế. Không thay thế thăm khám, chẩn đoán hoặc điều trị. Phạm vi dịch vụ, chỉ định, chi phí và khả năng tiếp nhận phải được cơ sở xác nhận."
    },
    "POSTPARTUM_LACTATION": {
      "schema_version": 1,
      "review": {
        "status": "DRAFT",
        "needs_medical_review": true
      },
      "intro": "Buổi tư vấn tìm hiểu tình trạng cho bú, những khó chịu của mẹ và các vấn đề quan sát được khi chăm sóc bé. Nhân viên chuyên môn hướng dẫn kỹ năng phù hợp, giải thích nhu cầu theo dõi và chuyển đánh giá y tế nếu có dấu hiệu bất thường.\n\nNuôi con bằng sữa mẹ có thể đặt ra nhiều câu hỏi trong những ngày đầu và các giai đoạn sau sinh. Người mẹ có thể gặp khó khăn về tư thế, đau khi cho bú, lo lắng về việc trẻ bú đủ hoặc chưa biết tổ chức sinh hoạt để tiếp tục cho bú. Buổi tư vấn hướng đến lắng nghe và hỗ trợ các kỹ năng thực tế, không áp đặt cách nuôi trẻ hoặc tạo áp lực cho gia đình. Khi phù hợp và có sự đồng ý, nhân viên chuyên môn có thể quan sát cách mẹ bế bé và cho bú, sau đó trao đổi cách điều chỉnh. Nếu mẹ có triệu chứng cần khám hoặc trẻ có biểu hiện bú kém, không tăng trưởng phù hợp hoặc bất thường khác, cần đánh giá y tế riêng. Dịch vụ được đặt dưới hồ sơ người mẹ và không thay thế hồ sơ, chẩn đoán hay điều trị nhi khoa của trẻ.",
      "key_facts": [
        {
          "icon": "calendar-days",
          "label": "Đối tượng",
          "value": "Người mẹ đang hoặc chuẩn bị cho con bú"
        },
        {
          "icon": "clipboard-check",
          "label": "Trọng tâm",
          "value": "Hướng dẫn kỹ năng và trao đổi khó khăn"
        },
        {
          "icon": "info",
          "label": "Người tham gia",
          "value": "Mẹ, có thể cùng người chăm sóc"
        },
        {
          "icon": "file-text",
          "label": "Giới hạn",
          "value": "Không thay khám cấp cứu hoặc nhi khoa"
        }
      ],
      "highlights": [
        {
          "icon": "stethoscope",
          "title": "Tôn trọng lựa chọn",
          "desc": "Hỗ trợ mục tiêu phù hợp hoàn cảnh."
        },
        {
          "icon": "clipboard-check",
          "title": "Thực hành",
          "desc": "Trao đổi tư thế và cách quan sát việc bú."
        },
        {
          "icon": "message-circle",
          "title": "Nhận biết vấn đề",
          "desc": "Hướng dẫn khi nào cần đánh giá thêm."
        },
        {
          "icon": "shield-check",
          "title": "Kế hoạch hỗ trợ",
          "desc": "Thống nhất bước thực hiện tại nhà."
        }
      ],
      "suitable_for": [
        "Người mẹ gặp khó khăn khi cho bú",
        "Sản phụ muốn học kỹ năng trước hoặc sau khi ra viện",
        "Gia đình muốn tìm hiểu hỗ trợ mẹ cho bú"
      ],
      "not_suitable_for": [
        "Không dùng tư vấn để trì hoãn khám khi bé bỏ bú hoặc li bì",
        "Mẹ có sốt, đau nhiều hoặc triệu chứng bất thường cần được đánh giá trực tiếp",
        "Trẻ khó thở, tím tái, li bì, bỏ bú hoặc có bất thường nhiệt độ: đưa trẻ đi đánh giá y tế ngay.",
        "Mẹ sốt kèm đau vú tăng hoặc tình trạng toàn thân xấu đi: liên hệ cơ sở y tế."
      ],
      "parameters": [
        {
          "name": "Tư thế",
          "desc": "Quan sát và hướng dẫn khi phù hợp",
          "reference": "Theo đánh giá và quy trình của cơ sở"
        },
        {
          "name": "Khó khăn của mẹ",
          "desc": "Trao đổi cảm giác đau và tình trạng thực tế",
          "reference": "Theo đánh giá và quy trình của cơ sở"
        },
        {
          "name": "Dấu hiệu cần hỗ trợ",
          "desc": "Nhận diện nhu cầu khám mẹ hoặc trẻ",
          "reference": "Theo đánh giá và quy trình của cơ sở"
        }
      ],
      "process_steps": [
        {
          "title": "Lắng nghe",
          "desc": "Ghi lại mục tiêu và khó khăn.",
          "duration_minutes": null
        },
        {
          "title": "Đánh giá nhu cầu",
          "desc": "Trao đổi tình trạng của mẹ và những thông tin liên quan đến việc bú.",
          "duration_minutes": null
        },
        {
          "title": "Hướng dẫn",
          "desc": "Minh họa kỹ năng phù hợp nếu có sự đồng ý.",
          "duration_minutes": null
        },
        {
          "title": "Theo dõi",
          "desc": "Trao đổi cách liên hệ hoặc hẹn đánh giá tiếp.",
          "duration_minutes": null
        }
      ],
      "preparation": [
        "Mang thông tin sau sinh và các hướng dẫn đã nhận",
        "Ghi lại các khó khăn khi cho bú",
        "Nếu muốn đưa bé đi cùng, xác nhận trước điều kiện tiếp nhận"
      ],
      "aftercare": [
        "Thử áp dụng kỹ năng đã được hướng dẫn",
        "Theo dõi mẹ và bé theo kế hoạch",
        "Liên hệ cơ sở nếu khó khăn kéo dài hoặc sức khỏe thay đổi"
      ],
      "accuracy_note": "Hướng dẫn kỹ năng không thay thế khám mẹ hoặc khám nhi khoa; không cam kết lượng sữa hoặc kết quả cụ thể.",
      "faqs": [
        {
          "q": "Có cần đưa bé đến không?",
          "a": "Tùy mục đích tư vấn, hỏi cơ sở trước khi đến."
        },
        {
          "q": "Có bảo đảm tăng lượng sữa không?",
          "a": "Không. Buổi tư vấn hỗ trợ kỹ năng và nhận diện vấn đề; kết quả tùy tình trạng."
        },
        {
          "q": "Nếu bé bỏ bú có nên đặt lịch tư vấn không?",
          "a": "Cần đưa bé đi đánh giá y tế ngay, không chờ lịch tư vấn."
        }
      ],
      "performed_by": "Nhân viên tư vấn nuôi con bằng sữa mẹ và bác sĩ phối hợp khi cần",
      "references": [
        {
          "title": "WHO recommendations on maternal and newborn care for a positive postnatal experience (2022)",
          "org": "WHO"
        }
      ],
      "disclaimer": "Thông tin danh mục phục vụ mô phỏng hệ thống Tâm An, chỉ mang tính tham khảo và cần được rà soát chuyên môn trước khi sử dụng thực tế. Không thay thế thăm khám, chẩn đoán hoặc điều trị. Phạm vi dịch vụ, chỉ định, chi phí và khả năng tiếp nhận phải được cơ sở xác nhận."
    },
    "PRENATAL_ROUTINE": {
      "schema_version": 1,
      "review": {
        "status": "DRAFT",
        "needs_medical_review": true
      },
      "intro": "Buổi khám tập trung rà soát diễn biến thai kỳ, sinh hiệu, kết quả đã có và các vấn đề người mẹ quan tâm. Bác sĩ đánh giá thông tin theo tuổi thai, giải thích những mốc cần theo dõi và trao đổi kế hoạch tái khám. Siêu âm, xét nghiệm hoặc dịch vụ chuyên sâu được lựa chọn riêng khi có chỉ định.\n\nKhám thai định kỳ khác với buổi lập hồ sơ lần đầu: mục tiêu chính là đánh giá sự thay đổi từ lần khám trước, duy trì liên tục quá trình theo dõi và nhận diện nhu cầu kiểm tra bổ sung. Thai phụ được tạo điều kiện hỏi về sinh hoạt, thuốc đang dùng, kết quả xét nghiệm và những thay đổi của cơ thể. Tùy tuổi thai, bác sĩ có thể đánh giá tim thai, sự phát triển của thai và các dấu hiệu nguy cơ phù hợp. Một lần khám không thể thay thế toàn bộ chương trình theo dõi thai kỳ. Lịch các lần tiếp theo được điều chỉnh theo tình trạng thực tế, không áp dụng một lịch cố định cho mọi người.",
      "key_facts": [
        {
          "icon": "calendar-days",
          "label": "Thời điểm",
          "value": "Theo lịch quản lý thai nghén"
        },
        {
          "icon": "clipboard-check",
          "label": "Phạm vi",
          "value": "Khám, đánh giá và tư vấn"
        },
        {
          "icon": "info",
          "label": "Chọn bác sĩ",
          "value": "Có thể chọn hạng theo bảng giá"
        },
        {
          "icon": "file-text",
          "label": "Dịch vụ bổ sung",
          "value": "Siêu âm/xét nghiệm theo chỉ định"
        }
      ],
      "highlights": [
        {
          "icon": "stethoscope",
          "title": "Theo dõi liên tục",
          "desc": "Đối chiếu kết quả giữa những lần khám và cập nhật hồ sơ."
        },
        {
          "icon": "clipboard-check",
          "title": "Đánh giá sức khỏe mẹ",
          "desc": "Ghi nhận sinh hiệu và các mối lo cần được bác sĩ đánh giá."
        },
        {
          "icon": "message-circle",
          "title": "Theo dõi thai",
          "desc": "Đánh giá phù hợp tuổi thai và kế hoạch chăm sóc."
        },
        {
          "icon": "shield-check",
          "title": "Kế hoạch rõ ràng",
          "desc": "Trao đổi lần khám tiếp theo và việc cần chuẩn bị."
        }
      ],
      "suitable_for": [
        "Thai phụ đã lập hồ sơ quản lý thai nghén hoặc có lịch theo dõi",
        "Thai phụ muốn tiếp tục theo dõi sự phát triển của thai",
        "Thai phụ cần bác sĩ xem lại kết quả lần khám trước"
      ],
      "not_suitable_for": [
        "Không thay thế xử trí cấp cứu sản khoa",
        "Không phải gói bao gồm mọi xét nghiệm hoặc siêu âm"
      ],
      "parameters": [
        {
          "name": "Huyết áp",
          "desc": "Đánh giá sinh hiệu và nguy cơ cần theo dõi",
          "reference": "Theo đánh giá và quy trình của cơ sở"
        },
        {
          "name": "Cân nặng",
          "desc": "Theo dõi thay đổi trong bối cảnh thai kỳ",
          "reference": "Theo đánh giá và quy trình của cơ sở"
        },
        {
          "name": "Sự phát triển thai",
          "desc": "Khảo sát phù hợp tuổi thai",
          "reference": "Theo đánh giá và quy trình của cơ sở"
        }
      ],
      "process_steps": [
        {
          "title": "Tiếp nhận",
          "desc": "Đối chiếu lịch, hồ sơ và lý do khám.",
          "duration_minutes": null
        },
        {
          "title": "Đánh giá",
          "desc": "Bác sĩ rà soát triệu chứng, tiền sử cập nhật và chỉ số cần thiết.",
          "duration_minutes": null
        },
        {
          "title": "Giải thích",
          "desc": "Trao đổi kết quả, các dấu hiệu cần theo dõi và chỉ định nếu có.",
          "duration_minutes": null
        },
        {
          "title": "Lập kế hoạch",
          "desc": "Thống nhất lần khám tiếp theo và hướng dẫn chuẩn bị.",
          "duration_minutes": null
        }
      ],
      "preparation": [
        "Mang sổ khám thai và kết quả cũ",
        "Ghi lại thuốc đang dùng và câu hỏi muốn trao đổi",
        "Không tự nhịn ăn trừ khi được yêu cầu"
      ],
      "aftercare": [
        "Lưu kết quả và kế hoạch tái khám",
        "Làm xét nghiệm hoặc siêu âm theo chỉ định đã thống nhất",
        "Liên hệ cơ sở khi sức khỏe thay đổi"
      ],
      "warning_signs": [
        "Ra máu nhiều, đau bụng dữ dội, khó thở hoặc ngất: cần hỗ trợ y tế ngay, không chờ lịch khám thường.",
        "Đau đầu dữ dội, nhìn mờ, khó thở hoặc đau vùng thượng vị dữ dội: cần đến cơ sở y tế ngay.",
        "Giảm rõ rệt cử động thai theo giai đoạn cần theo dõi: liên hệ cơ sở y tế ngay."
      ],
      "faqs": [
        {
          "q": "Có cần làm lại toàn bộ xét nghiệm mỗi lần không?",
          "a": "Không. Bác sĩ dựa trên tuổi thai, kết quả đã có và tình trạng hiện tại."
        },
        {
          "q": "Giá khám đã bao gồm siêu âm chưa?",
          "a": "Không mặc định. Kiểm tra bảng giá và nội dung từng dịch vụ."
        },
        {
          "q": "Có thể chọn lại bác sĩ cũ không?",
          "a": "Có thể tra lịch còn trống và chọn bác sĩ theo chính sách hệ thống."
        }
      ],
      "performed_by": "Bác sĩ Sản khoa",
      "references": [
        {
          "title": "WHO recommendations on antenatal care for a positive pregnancy experience (2016)",
          "org": "WHO"
        }
      ],
      "disclaimer": "Thông tin danh mục phục vụ mô phỏng hệ thống Tâm An, chỉ mang tính tham khảo và cần được rà soát chuyên môn trước khi sử dụng thực tế. Không thay thế thăm khám, chẩn đoán hoặc điều trị. Phạm vi dịch vụ, chỉ định, chi phí và khả năng tiếp nhận phải được cơ sở xác nhận."
    },
    "OGTT_DIABETES": {
      "schema_version": 1,
      "review": {
        "status": "DRAFT",
        "needs_medical_review": true
      },
      "intro": "OGTT là nghiệm pháp uống dung dịch glucose và lấy mẫu máu theo các mốc quy định của quy trình xét nghiệm. Mốc thường gặp trong chăm sóc thai kỳ là 24–28 tuần; một số người cần đánh giá sớm hơn theo chỉ định. Bác sĩ xác nhận yêu cầu nhịn ăn, thời điểm và điều kiện thực hiện.\n\nĐái tháo đường thai kỳ có thể được phát hiện khi thai phụ chưa nhận thấy triệu chứng rõ. Nghiệm pháp dung nạp glucose giúp bác sĩ đánh giá đáp ứng đường huyết trong một quy trình được kiểm soát, khác với một lần tự đo bằng máy tại nhà. Người thực hiện cần đối chiếu tuần thai, tình trạng sức khỏe, thuốc đang dùng và hướng dẫn chuẩn bị trước khi làm xét nghiệm. Quy trình lấy mẫu và cách đọc kết quả có thể khác nhau giữa các chương trình; vì vậy cơ sở phải xác nhận phác đồ đang áp dụng, không tự suy ra từ thông tin quảng bá. Nếu kết quả cần theo dõi hoặc điều trị, bác sĩ sẽ giải thích và phối hợp quản lý thai kỳ. Không tự thay đổi chế độ ăn, nhịn ăn kéo dài hoặc ngừng thuốc để làm xét nghiệm khi chưa được hướng dẫn.",
      "key_facts": [
        {
          "icon": "calendar-days",
          "label": "Mốc thường gặp",
          "value": "24–28 tuần; bác sĩ có thể chỉ định khác"
        },
        {
          "icon": "clipboard-check",
          "label": "Phương pháp",
          "value": "Uống glucose và lấy mẫu máu theo phác đồ"
        },
        {
          "icon": "info",
          "label": "Chuẩn bị",
          "value": "Xác nhận nhịn ăn trước xét nghiệm"
        },
        {
          "icon": "file-text",
          "label": "Kết quả",
          "value": "Bác sĩ diễn giải theo quy trình"
        }
      ],
      "highlights": [
        {
          "icon": "stethoscope",
          "title": "Đúng loại xét nghiệm",
          "desc": "Khác đo đường huyết mao mạch đơn lẻ."
        },
        {
          "icon": "clipboard-check",
          "title": "Kiểm tra điều kiện",
          "desc": "Rà soát tuần thai, thuốc và tình trạng hiện tại."
        },
        {
          "icon": "message-circle",
          "title": "Theo dõi trong buổi",
          "desc": "Báo ngay nhân viên y tế nếu khó chịu."
        },
        {
          "icon": "shield-check",
          "title": "Tư vấn sau kết quả",
          "desc": "Phối hợp bác sĩ quản lý thai nghén."
        }
      ],
      "suitable_for": [
        "Thai phụ được chỉ định OGTT",
        "Thai phụ đến mốc kiểm tra đường huyết theo lịch",
        "Thai phụ có tiền sử hoặc nguy cơ cần được bác sĩ tư vấn"
      ],
      "not_suitable_for": [
        "Người đã được chẩn đoán đái tháo đường cần trao đổi kế hoạch riêng",
        "Không tự thực hiện nếu đang bệnh cấp, nôn nhiều hoặc không thể chuẩn bị an toàn"
      ],
      "parameters": [
        {
          "name": "Mẫu lúc đói",
          "desc": "Đường huyết ban đầu nếu quy trình yêu cầu",
          "reference": "Theo đánh giá và quy trình của cơ sở"
        },
        {
          "name": "Mẫu sau uống",
          "desc": "Đường huyết tại các mốc quy định",
          "reference": "Theo đánh giá và quy trình của cơ sở"
        },
        {
          "name": "Tuổi thai và điều kiện",
          "desc": "Thông tin cần để lựa chọn và diễn giải quy trình",
          "reference": "Theo đánh giá và quy trình của cơ sở"
        }
      ],
      "process_steps": [
        {
          "title": "Xác nhận",
          "desc": "Kiểm tra tuổi thai và yêu cầu chuẩn bị.",
          "duration_minutes": null
        },
        {
          "title": "Lấy mẫu ban đầu",
          "desc": "Thực hiện theo quy trình được áp dụng.",
          "duration_minutes": null
        },
        {
          "title": "Uống dung dịch và theo dõi",
          "desc": "Lấy các mẫu tiếp theo đúng mốc, báo khó chịu cho nhân viên y tế.",
          "duration_minutes": null
        },
        {
          "title": "Trả kết quả",
          "desc": "Bác sĩ giải thích và tư vấn theo dõi.",
          "duration_minutes": null
        }
      ],
      "preparation": [
        "Liên hệ cơ sở để xác nhận thời gian nhịn ăn và thức uống được phép",
        "Mang hồ sơ và danh sách thuốc",
        "Bố trí thời gian cho toàn bộ buổi xét nghiệm"
      ],
      "aftercare": [
        "Ăn uống lại theo hướng dẫn sau khi hoàn tất",
        "Giữ kết quả và trao đổi với bác sĩ",
        "Nếu có kết quả bất thường, thực hiện kế hoạch theo dõi được chỉ định"
      ],
      "warning_signs": [
        "Chóng mặt, ngất, nôn nhiều hoặc khó chịu rõ trong buổi xét nghiệm: báo nhân viên y tế ngay.",
        "Ra máu nhiều, đau bụng dữ dội, khó thở hoặc ngất: cần hỗ trợ y tế ngay, không chờ lịch khám thường."
      ],
      "accuracy_note": "Kết quả được diễn giải theo quy trình xét nghiệm cụ thể. Việc chuẩn bị không đúng, bệnh cấp hoặc thuốc có thể ảnh hưởng việc thực hiện và diễn giải.",
      "faqs": [
        {
          "q": "OGTT khác đo đường huyết tại nhà không?",
          "a": "Có. OGTT là nghiệm pháp xét nghiệm theo quy trình, không thay bằng máy đo cá nhân."
        },
        {
          "q": "Tôi từng bị đái tháo đường thai kỳ thì sao?",
          "a": "Thông báo bác sĩ để được tư vấn thời điểm kiểm tra phù hợp."
        },
        {
          "q": "Có được uống nước trước và trong xét nghiệm không?",
          "a": "Xác nhận trực tiếp với cơ sở vì cần tuân thủ quy trình cụ thể."
        }
      ],
      "performed_by": "Nhân viên xét nghiệm và bác sĩ quản lý thai kỳ",
      "references": [
        {
          "title": "Gestational diabetes",
          "org": "NHS"
        },
        {
          "title": "WHO recommendations on antenatal care for a positive pregnancy experience (2016)",
          "org": "WHO"
        }
      ],
      "disclaimer": "Thông tin danh mục phục vụ mô phỏng hệ thống Tâm An, chỉ mang tính tham khảo và cần được rà soát chuyên môn trước khi sử dụng thực tế. Không thay thế thăm khám, chẩn đoán hoặc điều trị. Phạm vi dịch vụ, chỉ định, chi phí và khả năng tiếp nhận phải được cơ sở xác nhận."
    },
    "PRENATAL_FIRST": {
      "schema_version": 1,
      "review": {
        "status": "DRAFT",
        "needs_medical_review": true
      },
      "intro": "Buổi khám dành cho người mới biết hoặc nghi ngờ mang thai và cần được đánh giá ban đầu. Bác sĩ khai thác tiền sử, xem xét thông tin xác định tuổi thai, tư vấn các bước theo dõi và lựa chọn kiểm tra khi phù hợp. Không mặc định bao gồm siêu âm hoặc xét nghiệm.\n\nKhi bắt đầu một thai kỳ, nhiều người chưa biết cần khám khi nào, cần mang theo giấy tờ gì hoặc những kết quả nào có ý nghĩa. Khám thai lần đầu giúp thiết lập thông tin ban đầu để các lần khám sau có căn cứ đối chiếu. Bác sĩ tìm hiểu ngày kinh cuối nếu biết, tiền sử mang thai, bệnh nền, thuốc và các vấn đề sức khỏe hiện tại. Nếu cần xác định vị trí thai, tuổi thai hoặc đánh giá vấn đề bất thường, bác sĩ lựa chọn phương pháp kiểm tra phù hợp. Người mẹ được tư vấn cách liên hệ cơ sở khi có dấu hiệu bất thường và các mốc chăm sóc cần trao đổi. Đây là dịch vụ thăm khám ban đầu chứ không phải một gói sàng lọc di truyền hoặc một lời bảo đảm thai kỳ bình thường.",
      "key_facts": [
        {
          "icon": "calendar-days",
          "label": "Đối tượng",
          "value": "Người mới biết hoặc nghi ngờ mang thai"
        },
        {
          "icon": "clipboard-check",
          "label": "Phạm vi",
          "value": "Khám và lập kế hoạch ban đầu"
        },
        {
          "icon": "info",
          "label": "Chuẩn bị",
          "value": "Thông tin kỳ kinh, thuốc và kết quả có sẵn"
        },
        {
          "icon": "file-text",
          "label": "Xét nghiệm",
          "value": "Theo chỉ định riêng"
        }
      ],
      "highlights": [
        {
          "icon": "stethoscope",
          "title": "Lập hồ sơ",
          "desc": "Ghi nhận tiền sử và các thông tin nền tảng."
        },
        {
          "icon": "clipboard-check",
          "title": "Đánh giá ban đầu",
          "desc": "Bác sĩ xem xét sức khỏe và nhu cầu kiểm tra."
        },
        {
          "icon": "message-circle",
          "title": "Giải thích mốc thai kỳ",
          "desc": "Trao đổi các lần khám và sàng lọc cần cân nhắc."
        },
        {
          "icon": "shield-check",
          "title": "Hướng dẫn theo dõi",
          "desc": "Giải thích cách nhận biết tình huống cần hỗ trợ."
        }
      ],
      "suitable_for": [
        "Người vừa có kết quả thử thai dương tính",
        "Người nghi ngờ mang thai và cần tư vấn đánh giá",
        "Thai phụ chưa lập hồ sơ quản lý thai nghén"
      ],
      "not_suitable_for": [
        "Không thay thế khám cấp cứu khi có dấu hiệu bất thường nghiêm trọng",
        "Không thay thế siêu âm hoặc xét nghiệm khi bác sĩ chỉ định"
      ],
      "process_steps": [
        {
          "title": "Tiếp nhận",
          "desc": "Ghi nhận thông tin ban đầu và mục tiêu khám.",
          "duration_minutes": null
        },
        {
          "title": "Hỏi bệnh",
          "desc": "Rà soát tiền sử, thuốc và triệu chứng.",
          "duration_minutes": null
        },
        {
          "title": "Khám và đánh giá",
          "desc": "Bác sĩ chọn các đánh giá phù hợp, giải thích xét nghiệm nếu cần.",
          "duration_minutes": null
        },
        {
          "title": "Hẹn theo dõi",
          "desc": "Lập kế hoạch khám và hướng dẫn liên hệ khi có vấn đề.",
          "duration_minutes": null
        }
      ],
      "preparation": [
        "Mang kết quả thử thai hoặc siêu âm nếu có",
        "Ghi ngày kinh cuối nếu nhớ và tiền sử liên quan",
        "Mang danh sách thuốc đang dùng, không tự ngừng thuốc"
      ],
      "aftercare": [
        "Giữ hồ sơ mới và lịch theo dõi",
        "Thực hiện kiểm tra theo hướng dẫn",
        "Trao đổi bác sĩ trước khi thay đổi thuốc hoặc vi chất"
      ],
      "warning_signs": [
        "Ra máu nhiều, đau bụng dữ dội, khó thở hoặc ngất: cần hỗ trợ y tế ngay, không chờ lịch khám thường.",
        "Đau đầu dữ dội, nhìn mờ, khó thở hoặc đau vùng thượng vị dữ dội: cần đến cơ sở y tế ngay."
      ],
      "accuracy_note": "Thông tin ban đầu có thể chưa đủ để kết luận; cần kiểm tra lại theo chỉ định nếu tuổi thai hoặc vị trí thai chưa xác định.",
      "faqs": [
        {
          "q": "Chưa biết chính xác tuổi thai có khám được không?",
          "a": "Có. Bác sĩ sẽ đánh giá thông tin và chọn cách xác định phù hợp."
        },
        {
          "q": "Có cần nhịn ăn trước không?",
          "a": "Hỏi cơ sở nếu được chỉ định xét nghiệm; không tự nhịn ăn chỉ vì đặt lịch khám."
        },
        {
          "q": "Khám lần đầu khác định kỳ thế nào?",
          "a": "Khám lần đầu thiết lập hồ sơ và kế hoạch ban đầu; khám định kỳ theo dõi diễn biến sau đó."
        }
      ],
      "performed_by": "Bác sĩ Sản khoa",
      "references": [
        {
          "title": "WHO recommendations on antenatal care for a positive pregnancy experience (2016)",
          "org": "WHO"
        }
      ],
      "disclaimer": "Thông tin danh mục phục vụ mô phỏng hệ thống Tâm An, chỉ mang tính tham khảo và cần được rà soát chuyên môn trước khi sử dụng thực tế. Không thay thế thăm khám, chẩn đoán hoặc điều trị. Phạm vi dịch vụ, chỉ định, chi phí và khả năng tiếp nhận phải được cơ sở xác nhận."
    },
    "NIPT_BASIC": {
      "schema_version": 1,
      "review": {
        "status": "DRAFT",
        "needs_medical_review": true
      },
      "intro": "NIPT phân tích ADN tự do có nguồn gốc chủ yếu từ nhau thai lưu hành trong máu mẹ, nhằm đánh giá nguy cơ các lệch bội nhiễm sắc thể trong phạm vi xét nghiệm. Đây là xét nghiệm sàng lọc, không phải chẩn đoán xác định. Bác sĩ tư vấn thời điểm, phạm vi và cách diễn giải kết quả.\n\nDịch vụ NIPT trong danh mục này tập trung vào ba lệch bội nhiễm sắc thể thường gặp liên quan đến hội chứng Down, Edwards và Patau. Mẫu được lấy từ máu tĩnh mạch của người mẹ, không phải lấy mẫu trực tiếp từ thai. Trước xét nghiệm, bác sĩ trao đổi về tuổi thai, số thai, tiền sử và mục tiêu sàng lọc. Kết quả nguy cơ thấp không loại trừ tất cả bệnh lý di truyền hoặc dị tật cấu trúc; kết quả nguy cơ cao cần được tư vấn về phương pháp chẩn đoán xác định phù hợp. Đôi khi mẫu không đủ điều kiện để đưa ra kết luận. Không sử dụng thông tin xét nghiệm để lựa chọn giới tính thai nhi. Phạm vi xét nghiệm và thời gian trả kết quả được xác nhận với đơn vị thực hiện, không có cam kết bảo hiểm hay tỷ lệ chính xác tuyệt đối trong dữ liệu này.",
      "key_facts": [
        {
          "icon": "calendar-days",
          "label": "Phạm vi",
          "value": "Trisomy 21, 18, 13"
        },
        {
          "icon": "clipboard-check",
          "label": "Mẫu",
          "value": "Máu tĩnh mạch mẹ"
        },
        {
          "icon": "info",
          "label": "Thời điểm",
          "value": "Thường từ khoảng 10 tuần, xác nhận với cơ sở"
        },
        {
          "icon": "file-text",
          "label": "Loại kết quả",
          "value": "Đánh giá nguy cơ"
        }
      ],
      "highlights": [
        {
          "icon": "stethoscope",
          "title": "Sàng lọc không xâm lấn thai",
          "desc": "Sử dụng mẫu máu của mẹ."
        },
        {
          "icon": "clipboard-check",
          "title": "Phạm vi rõ",
          "desc": "Không mặc định khảo sát mọi nhiễm sắc thể hoặc vi mất đoạn."
        },
        {
          "icon": "message-circle",
          "title": "Tư vấn lựa chọn",
          "desc": "Giải thích sự khác nhau giữa các phương pháp."
        },
        {
          "icon": "shield-check",
          "title": "Đọc kết quả",
          "desc": "Hỗ trợ lựa chọn bước đánh giá tiếp theo."
        }
      ],
      "suitable_for": [
        "Thai phụ muốn được tư vấn sàng lọc lệch bội thường gặp",
        "Thai phụ được bác sĩ đánh giá phù hợp với NIPT",
        "Thai phụ có kết quả sàng lọc cần trao đổi thêm về lựa chọn"
      ],
      "not_suitable_for": [
        "Không phù hợp khi mục tiêu là chẩn đoán xác định",
        "Cần tư vấn riêng nếu đa thai, từng có thai biến mất hoặc có yếu tố ảnh hưởng đến mẫu"
      ],
      "process_steps": [
        {
          "title": "Tư vấn",
          "desc": "Xác định mục tiêu và giới hạn xét nghiệm.",
          "duration_minutes": null
        },
        {
          "title": "Đối chiếu tuổi thai",
          "desc": "Rà soát hồ sơ và điều kiện nhận mẫu.",
          "duration_minutes": null
        },
        {
          "title": "Lấy mẫu",
          "desc": "Nhân viên y tế lấy và chuyển mẫu theo quy trình.",
          "duration_minutes": null
        },
        {
          "title": "Trả kết quả",
          "desc": "Bác sĩ giải thích ý nghĩa và hướng tiếp theo.",
          "duration_minutes": null
        }
      ],
      "preparation": [
        "Mang kết quả xác định tuổi thai và sàng lọc đã có",
        "Trao đổi tiền sử liên quan có thể ảnh hưởng xét nghiệm",
        "Hỏi trước về yêu cầu lấy mẫu và thời gian trả kết quả"
      ],
      "aftercare": [
        "Giữ báo cáo và tiếp tục khám thai",
        "Trao đổi bác sĩ nếu nguy cơ cao hoặc không kết luận được",
        "Không tự quyết định điều trị dựa vào báo cáo sàng lọc"
      ],
      "warning_signs": [
        "Ra máu nhiều, đau bụng dữ dội, khó thở hoặc ngất: cần hỗ trợ y tế ngay, không chờ lịch khám thường.",
        "Nếu nhận kết quả nguy cơ cao, liên hệ bác sĩ để được tư vấn xác nhận; không tự kết luận."
      ],
      "accuracy_note": "Đây là sàng lọc, có thể có kết quả dương tính hoặc âm tính giả, cũng có thể không kết luận được. Không coi là chẩn đoán xác định.",
      "faqs": [
        {
          "q": "NIPT có phải xét nghiệm chẩn đoán không?",
          "a": "Không. NIPT đánh giá nguy cơ; có thể cần xét nghiệm chẩn đoán sau tư vấn."
        },
        {
          "q": "NIPT có thay thế siêu âm hình thái không?",
          "a": "Không. Siêu âm và xét nghiệm cung cấp các loại thông tin khác nhau."
        },
        {
          "q": "Kết quả nguy cơ thấp có loại trừ mọi dị tật không?",
          "a": "Không, chỉ liên quan phạm vi sàng lọc và vẫn có giới hạn."
        }
      ],
      "performed_by": "Bác sĩ tư vấn và nhân viên xét nghiệm được phân công",
      "references": [
        {
          "title": "Consult Series #74: Cell-free DNA screening for aneuploidies: Updated guidance (2025)",
          "org": "SMFM"
        },
        {
          "title": "Screening tests in pregnancy",
          "org": "NHS"
        }
      ],
      "disclaimer": "Thông tin danh mục phục vụ mô phỏng hệ thống Tâm An, chỉ mang tính tham khảo và cần được rà soát chuyên môn trước khi sử dụng thực tế. Không thay thế thăm khám, chẩn đoán hoặc điều trị. Phạm vi dịch vụ, chỉ định, chi phí và khả năng tiếp nhận phải được cơ sở xác nhận."
    },
    "GYN_THINPREP_HPV": {
      "schema_version": 1,
      "review": {
        "status": "DRAFT",
        "needs_medical_review": true
      },
      "intro": "Dịch vụ dành cho người có nhu cầu đánh giá nguy cơ tổn thương tiền ung thư cổ tử cung. Xét nghiệm tế bào học nhúng dịch và xét nghiệm HPV cung cấp các thông tin khác nhau. Bác sĩ lựa chọn phương án phù hợp dựa trên tuổi, tiền sử, kết quả trước và tình trạng hiện tại.\n\nTầm soát cổ tử cung nhằm phát hiện nguy cơ hoặc những thay đổi có thể cần đánh giá trước khi phát triển thành bệnh lý nghiêm trọng. Phương pháp tế bào học nhúng dịch giúp phòng xét nghiệm quan sát mẫu tế bào, còn xét nghiệm HPV tìm dấu hiệu nhiễm các nhóm HPV liên quan nguy cơ ung thư cổ tử cung theo phạm vi kỹ thuật. Kết quả HPV dương tính không có nghĩa người bệnh bị ung thư. Một kết quả tế bào học bất thường cũng cần được bác sĩ diễn giải và lựa chọn bước tiếp theo. Người bệnh không cần tự quyết định phải làm cả hai xét nghiệm nếu chưa được tư vấn, vì chương trình tầm soát có thể khác nhau theo tuổi và tiền sử. Quy trình lấy mẫu, trả kết quả và hẹn theo dõi cần được xác nhận tại cơ sở.",
      "key_facts": [
        {
          "icon": "calendar-days",
          "label": "Mẫu",
          "value": "Mẫu từ cổ tử cung"
        },
        {
          "icon": "clipboard-check",
          "label": "Phương pháp",
          "value": "Tế bào học nhúng dịch và HPV theo chỉ định"
        },
        {
          "icon": "info",
          "label": "Đối tượng",
          "value": "Theo tuổi và tiền sử"
        },
        {
          "icon": "file-text",
          "label": "Kết quả",
          "value": "Đánh giá nguy cơ cần theo dõi"
        }
      ],
      "highlights": [
        {
          "icon": "stethoscope",
          "title": "Đúng mục tiêu",
          "desc": "Tập trung vào sàng lọc cổ tử cung."
        },
        {
          "icon": "clipboard-check",
          "title": "Hai nguồn thông tin",
          "desc": "Tế bào học và HPV có vai trò khác nhau."
        },
        {
          "icon": "message-circle",
          "title": "Giải thích kết quả",
          "desc": "Không quy kết HPV dương tính thành ung thư."
        },
        {
          "icon": "shield-check",
          "title": "Theo dõi",
          "desc": "Bác sĩ tư vấn khoảng cách và bước bổ sung."
        }
      ],
      "suitable_for": [
        "Người đến mốc tầm soát theo tư vấn",
        "Người có tiền sử xét nghiệm cần theo dõi",
        "Người muốn trao đổi phương án tầm soát trước mang thai"
      ],
      "not_suitable_for": [
        "Có chảy máu hoặc triệu chứng cần bác sĩ đánh giá trước",
        "Đang mang thai hoặc có tiền sử phẫu thuật cổ tử cung cần tư vấn riêng"
      ],
      "process_steps": [
        {
          "title": "Tư vấn",
          "desc": "Đối chiếu tuổi, tiền sử và lựa chọn xét nghiệm.",
          "duration_minutes": null
        },
        {
          "title": "Chuẩn bị",
          "desc": "Giải thích kỹ thuật lấy mẫu và xin đồng ý.",
          "duration_minutes": null
        },
        {
          "title": "Lấy và phân tích mẫu",
          "desc": "Thực hiện theo quy trình phù hợp.",
          "duration_minutes": null
        },
        {
          "title": "Đọc kết quả",
          "desc": "Giải thích báo cáo và kế hoạch theo dõi.",
          "duration_minutes": null
        }
      ],
      "preparation": [
        "Mang kết quả Pap/HPV trước đây nếu có",
        "Hỏi về chuẩn bị trước lấy mẫu và thời điểm phù hợp",
        "Báo bác sĩ nếu có thai, dùng thuốc hoặc đang có triệu chứng"
      ],
      "aftercare": [
        "Giữ báo cáo",
        "Trao đổi lịch tầm soát hoặc khám bổ sung",
        "Không tự điều trị chỉ từ kết quả HPV"
      ],
      "warning_signs": [
        "Ra máu nhiều, đau tăng hoặc sốt sau lấy mẫu: liên hệ y tế."
      ],
      "accuracy_note": "Tầm soát không phải chẩn đoán ung thư. Kết quả có thể cần soi cổ tử cung, sinh thiết hoặc theo dõi theo chỉ định.",
      "faqs": [
        {
          "q": "HPV dương tính có phải ung thư không?",
          "a": "Không. Cần đánh giá theo loại kết quả, tiền sử và hướng dẫn."
        },
        {
          "q": "Tiêm HPV rồi có cần tầm soát không?",
          "a": "Vẫn cần trao đổi lịch tầm soát theo khuyến cáo áp dụng cho cá nhân."
        },
        {
          "q": "Khám tổng quát thay xét nghiệm tầm soát được không?",
          "a": "Không mặc định. Mỗi dịch vụ có mục tiêu và phương pháp khác nhau."
        }
      ],
      "performed_by": "Bác sĩ Phụ khoa và nhân viên xét nghiệm",
      "references": [
        {
          "title": "WHO guideline for screening and treatment of cervical pre-cancer lesions for cervical cancer prevention, second edition (2021)",
          "org": "WHO"
        }
      ],
      "disclaimer": "Thông tin danh mục phục vụ mô phỏng hệ thống Tâm An, chỉ mang tính tham khảo và cần được rà soát chuyên môn trước khi sử dụng thực tế. Không thay thế thăm khám, chẩn đoán hoặc điều trị. Phạm vi dịch vụ, chỉ định, chi phí và khả năng tiếp nhận phải được cơ sở xác nhận."
    },
    "GYN_STANDARD": {
      "schema_version": 1,
      "review": {
        "status": "DRAFT",
        "needs_medical_review": true
      },
      "intro": "Dịch vụ tập trung khai thác tiền sử, đánh giá tình trạng sức khỏe phụ khoa và tư vấn bước thăm khám phù hợp. Khi cần, bác sĩ có thể chỉ định soi cổ tử cung hoặc các kỹ thuật bổ sung với sự đồng ý của người bệnh. Không đồng nhất với gói lấy mẫu tế bào học và HPV.\n\nKhám phụ khoa tổng quát giúp người bệnh trao đổi về những thay đổi của chu kỳ kinh, khó chịu vùng kín, bất thường vùng chậu hoặc nhu cầu chăm sóc sức khỏe sinh sản. Bác sĩ tìm hiểu tiền sử và mục tiêu của buổi khám trước khi đề xuất phương pháp thăm khám. Người bệnh được giải thích về mỗi bước, có quyền đặt câu hỏi và từ chối kỹ thuật chưa đồng ý. Soi cổ tử cung có thể hỗ trợ bác sĩ quan sát vùng cổ tử cung khi phù hợp, nhưng không mặc nhiên thay thế xét nghiệm tế bào học hoặc HPV để sàng lọc ung thư cổ tử cung. Nếu mục tiêu chính là tầm soát, cần lựa chọn phương pháp theo độ tuổi, tiền sử và hướng dẫn chuyên môn. Dịch vụ cũng có thể hỗ trợ đánh giá sức khỏe trước mang thai hoặc sau sinh.",
      "key_facts": [
        {
          "icon": "calendar-days",
          "label": "Phạm vi",
          "value": "Khám và tư vấn phụ khoa"
        },
        {
          "icon": "clipboard-check",
          "label": "Kỹ thuật",
          "value": "Soi cổ tử cung nếu phù hợp"
        },
        {
          "icon": "info",
          "label": "Riêng tư",
          "value": "Giải thích và xin đồng ý"
        },
        {
          "icon": "file-text",
          "label": "Xét nghiệm",
          "value": "Chỉ định riêng khi cần"
        }
      ],
      "highlights": [
        {
          "icon": "stethoscope",
          "title": "Đánh giá cá nhân",
          "desc": "Tìm hiểu mục tiêu và triệu chứng."
        },
        {
          "icon": "clipboard-check",
          "title": "Tôn trọng người bệnh",
          "desc": "Trao đổi trước khi thực hiện khám."
        },
        {
          "icon": "message-circle",
          "title": "Phân biệt dịch vụ",
          "desc": "Khám tổng quát không thay cho sàng lọc tế bào/HPV."
        },
        {
          "icon": "shield-check",
          "title": "Kế hoạch",
          "desc": "Giải thích kết quả và hẹn theo dõi."
        }
      ],
      "suitable_for": [
        "Phụ nữ cần kiểm tra sức khỏe phụ khoa định kỳ",
        "Người có thay đổi kinh nguyệt hoặc khó chịu cần đánh giá",
        "Người muốn tư vấn sức khỏe sinh sản trước mang thai hoặc sau sinh"
      ],
      "not_suitable_for": [
        "Không thay thế xử trí cấp cứu",
        "Không phải mặc định là gói xét nghiệm tầm soát ung thư cổ tử cung"
      ],
      "process_steps": [
        {
          "title": "Tiếp nhận",
          "desc": "Ghi lý do khám và thông tin liên quan.",
          "duration_minutes": null
        },
        {
          "title": "Hỏi bệnh",
          "desc": "Trao đổi tiền sử, triệu chứng và kết quả đã có.",
          "duration_minutes": null
        },
        {
          "title": "Thăm khám",
          "desc": "Bác sĩ giải thích và thực hiện kỹ thuật phù hợp sau khi người bệnh đồng ý.",
          "duration_minutes": null
        },
        {
          "title": "Tư vấn",
          "desc": "Trao đổi kết quả và kế hoạch theo dõi.",
          "duration_minutes": null
        }
      ],
      "preparation": [
        "Ghi lại chu kỳ và triệu chứng",
        "Mang kết quả khám, thuốc đang dùng",
        "Báo bác sĩ nếu đang hoặc có thể mang thai"
      ],
      "aftercare": [
        "Thực hiện hướng dẫn cá nhân",
        "Lưu kết quả và hẹn kiểm tra nếu cần",
        "Liên hệ cơ sở nếu xuất hiện dấu hiệu bất thường"
      ],
      "warning_signs": [
        "Chảy máu nhiều, đau dữ dội, choáng hoặc sốt kèm tình trạng xấu đi: đi khám ngay."
      ],
      "accuracy_note": "Kết quả khám không loại trừ mọi bệnh lý. Bác sĩ có thể cần chỉ định thêm xét nghiệm hoặc phương pháp đánh giá.",
      "faqs": [
        {
          "q": "Khám phụ khoa có bao gồm HPV không?",
          "a": "Không mặc định; tầm soát tế bào học và HPV là dịch vụ riêng."
        },
        {
          "q": "Có bắt buộc thực hiện mọi bước khám không?",
          "a": "Không. Bác sĩ giải thích lựa chọn và cần sự đồng ý của người bệnh."
        },
        {
          "q": "Đang mang thai có cần báo trước không?",
          "a": "Có, để lựa chọn phương pháp phù hợp."
        }
      ],
      "performed_by": "Bác sĩ Phụ khoa",
      "references": [
        {
          "title": "WHO guideline for screening and treatment of cervical pre-cancer lesions for cervical cancer prevention, second edition (2021)",
          "org": "WHO"
        }
      ],
      "disclaimer": "Thông tin danh mục phục vụ mô phỏng hệ thống Tâm An, chỉ mang tính tham khảo và cần được rà soát chuyên môn trước khi sử dụng thực tế. Không thay thế thăm khám, chẩn đoán hoặc điều trị. Phạm vi dịch vụ, chỉ định, chi phí và khả năng tiếp nhận phải được cơ sở xác nhận."
    },
    "US_4D_5D": {
      "schema_version": 1,
      "review": {
        "status": "DRAFT",
        "needs_medical_review": true
      },
      "intro": "Dịch vụ tập trung khảo sát giải phẫu thai nhi, đánh giá các cấu trúc cần quan sát, nhau thai và nước ối. Khảo sát hình thái chuẩn dựa trên kỹ thuật siêu âm phù hợp; hình ảnh 4D/5D không thay thế việc đánh giá chuyên môn hoặc bảo đảm phát hiện tất cả dị tật.\n\nSiêu âm hình thái giúp bác sĩ kiểm tra có hệ thống những cấu trúc thai nhi phù hợp với tuổi thai và mục tiêu khảo sát. Người mẹ được giải thích sự khác nhau giữa hình ảnh minh họa bề mặt và việc đánh giá các mặt cắt giải phẫu cần thiết. Việc lựa chọn kỹ thuật 2D, Doppler hoặc hình ảnh tái tạo phụ thuộc câu hỏi lâm sàng và điều kiện thực hiện; không phải cứ hình ảnh nhiều chiều hơn là có kết quả tốt hơn. Nếu tư thế thai hoặc điều kiện khảo sát chưa cho phép quan sát đủ, có thể cần hẹn lại. Khi có nghi ngờ bất thường, bác sĩ sẽ giải thích và tư vấn đánh giá bổ sung. Mục tiêu là hỗ trợ quản lý thai kỳ, không phải tạo ảnh lưu niệm bằng mọi giá.",
      "key_facts": [
        {
          "icon": "calendar-days",
          "label": "Mốc thường gặp",
          "value": "Khoảng 18–24 tuần, theo chỉ định"
        },
        {
          "icon": "clipboard-check",
          "label": "Mục tiêu",
          "value": "Khảo sát giải phẫu"
        },
        {
          "icon": "info",
          "label": "Hình ảnh",
          "value": "Theo điều kiện và kỹ thuật phù hợp"
        },
        {
          "icon": "file-text",
          "label": "Kết quả",
          "value": "Báo cáo và hướng dẫn tiếp theo"
        }
      ],
      "highlights": [
        {
          "icon": "stethoscope",
          "title": "Khảo sát có hệ thống",
          "desc": "Quan sát cấu trúc cần thiết theo quy trình chuyên môn."
        },
        {
          "icon": "clipboard-check",
          "title": "Đánh giá bổ sung",
          "desc": "Lựa chọn kỹ thuật phù hợp khi cần."
        },
        {
          "icon": "message-circle",
          "title": "Thông tin rõ ràng",
          "desc": "Giải thích giới hạn và nhu cầu kiểm tra lại."
        },
        {
          "icon": "shield-check",
          "title": "Liên kết theo dõi",
          "desc": "Phối hợp với bác sĩ quản lý thai."
        }
      ],
      "suitable_for": [
        "Thai phụ có lịch siêu âm hình thái",
        "Thai phụ được chỉ định khảo sát bổ sung cấu trúc",
        "Thai phụ cần đánh giá tiếp khi kết quả trước chưa đầy đủ"
      ],
      "not_suitable_for": [
        "Không dùng hình ảnh 4D/5D thay cho khảo sát giải phẫu",
        "Không thay thế đánh giá khẩn khi có dấu hiệu cấp cứu"
      ],
      "parameters": [
        {
          "name": "Giải phẫu",
          "desc": "Đánh giá cấu trúc theo mốc tuổi thai",
          "reference": "Theo đánh giá và quy trình của cơ sở"
        },
        {
          "name": "Nhau thai và nước ối",
          "desc": "Khảo sát phù hợp mục tiêu",
          "reference": "Theo đánh giá và quy trình của cơ sở"
        },
        {
          "name": "Tăng trưởng",
          "desc": "Đối chiếu phép đo khi cần",
          "reference": "Theo đánh giá và quy trình của cơ sở"
        }
      ],
      "process_steps": [
        {
          "title": "Xác nhận",
          "desc": "Kiểm tra tuổi thai, chỉ định và hồ sơ.",
          "duration_minutes": null
        },
        {
          "title": "Giải thích",
          "desc": "Trao đổi mục tiêu và giới hạn.",
          "duration_minutes": null
        },
        {
          "title": "Khảo sát",
          "desc": "Quan sát các cấu trúc theo quy trình phù hợp.",
          "duration_minutes": null
        },
        {
          "title": "Kết luận",
          "desc": "Trả báo cáo và hướng dẫn đánh giá lại nếu cần.",
          "duration_minutes": null
        }
      ],
      "preparation": [
        "Mang siêu âm và kết quả sàng lọc trước",
        "Hỏi cơ sở về chuẩn bị",
        "Bố trí thời gian để khảo sát đủ nếu điều kiện cho phép"
      ],
      "aftercare": [
        "Giữ báo cáo và trao đổi với bác sĩ quản lý thai",
        "Hẹn kiểm tra nếu chưa khảo sát đầy đủ",
        "Không tự diễn giải hình ảnh minh họa thành kết luận"
      ],
      "warning_signs": [
        "Ra máu nhiều, đau bụng dữ dội, khó thở hoặc ngất: cần hỗ trợ y tế ngay, không chờ lịch khám thường."
      ],
      "technology": {
        "title": "Kỹ thuật siêu âm theo chỉ định",
        "desc": "Kỹ thuật 2D, Doppler và tái tạo hình ảnh được lựa chọn theo mục tiêu chuyên môn và khả năng thiết bị thực tế của cơ sở.",
        "items": [
          "Hình ảnh 2D dùng trong khảo sát giải phẫu",
          "Doppler khi phù hợp",
          "Hình ảnh tái tạo khi phù hợp"
        ]
      },
      "accuracy_note": "Siêu âm hình thái có giới hạn; kết quả bình thường không loại trừ mọi bất thường.",
      "faqs": [
        {
          "q": "4D/5D có phát hiện tất cả dị tật không?",
          "a": "Không. Khảo sát có giới hạn; một số bất thường chỉ xuất hiện hoặc nhận diện được sau đó."
        },
        {
          "q": "Nếu bé nằm khó quan sát thì sao?",
          "a": "Nhân viên y tế có thể thay đổi cách khảo sát hoặc hẹn lại."
        },
        {
          "q": "Có thay thế NIPT không?",
          "a": "Không. Hai phương pháp đánh giá những khía cạnh khác nhau."
        }
      ],
      "performed_by": "Nhân viên siêu âm sản khoa đủ năng lực chuyên môn",
      "references": [
        {
          "title": "Practice Guidelines: performance of the routine mid-trimester fetal ultrasound scan (2022)",
          "org": "ISUOG"
        }
      ],
      "disclaimer": "Thông tin danh mục phục vụ mô phỏng hệ thống Tâm An, chỉ mang tính tham khảo và cần được rà soát chuyên môn trước khi sử dụng thực tế. Không thay thế thăm khám, chẩn đoán hoặc điều trị. Phạm vi dịch vụ, chỉ định, chi phí và khả năng tiếp nhận phải được cơ sở xác nhận."
    },
    "POSTPARTUM_MATERNAL_CHECK": {
      "schema_version": 1,
      "review": {
        "status": "DRAFT",
        "needs_medical_review": true
      },
      "intro": "Buổi khám rà soát hồ sơ sinh và ra viện, trao đổi tình trạng hồi phục, đau, vết khâu hoặc vết mổ, sinh hoạt, sức khỏe tinh thần và các vấn đề liên quan. Bác sĩ lựa chọn thăm khám phù hợp và hướng dẫn tái khám hoặc chuyển chuyên khoa nếu cần.\n\nSau khi sinh, việc chăm sóc người mẹ cần được tiếp tục ngay cả khi gia đình đang tập trung cho trẻ. Dịch vụ giúp sản phụ trao đổi những thay đổi trong cơ thể, các khó khăn khi sinh hoạt và những lo lắng về sức khỏe. Bác sĩ có thể rà soát tình trạng vết thương, sản dịch, triệu chứng, tiền sử và thuốc theo hồ sơ, đồng thời hỏi về nghỉ ngơi, nguồn hỗ trợ và sức khỏe tinh thần. Nội dung khám tùy thuộc thời điểm sau sinh, phương thức sinh và tình trạng cá nhân. Khi có nhu cầu, bác sĩ phối hợp tư vấn nuôi con bằng sữa mẹ hoặc sức khỏe sinh sản sau sinh. Buổi khám không thay thế tiếp nhận cấp cứu; các dấu hiệu như ra máu nhiều, khó thở hoặc đau ngực cần được đánh giá ngay. Sản phụ được hướng dẫn theo dõi và liên hệ cơ sở khi sức khỏe thay đổi.",
      "key_facts": [
        {
          "icon": "calendar-days",
          "label": "Đối tượng",
          "value": "Sản phụ sau sinh"
        },
        {
          "icon": "clipboard-check",
          "label": "Hồ sơ",
          "value": "Giấy ra viện và thông tin cuộc sinh"
        },
        {
          "icon": "info",
          "label": "Phạm vi",
          "value": "Khám, đánh giá và tư vấn"
        },
        {
          "icon": "file-text",
          "label": "Lịch",
          "value": "Theo tình trạng và hẹn theo dõi"
        }
      ],
      "highlights": [
        {
          "icon": "stethoscope",
          "title": "Phục hồi thể chất",
          "desc": "Đánh giá các vấn đề sau sinh theo nhu cầu."
        },
        {
          "icon": "clipboard-check",
          "title": "Sức khỏe tinh thần",
          "desc": "Trao đổi khó khăn, lo âu và nguồn hỗ trợ."
        },
        {
          "icon": "message-circle",
          "title": "Chăm sóc tại nhà",
          "desc": "Giải thích theo dõi và thời điểm liên hệ."
        },
        {
          "icon": "shield-check",
          "title": "Phối hợp",
          "desc": "Kết nối dịch vụ phù hợp khi cần."
        }
      ],
      "suitable_for": [
        "Sản phụ có lịch khám sau sinh",
        "Người mẹ cần đánh giá hồi phục sau sinh thường hoặc sinh mổ",
        "Sản phụ muốn trao đổi các khó khăn trong thời kỳ hậu sản"
      ],
      "not_suitable_for": [
        "Không thay thế cấp cứu khi có dấu hiệu nguy hiểm",
        "Không mặc định bao gồm mọi thủ thuật hoặc xét nghiệm",
        "Ra máu nhiều, đau ngực, khó thở, ngất hoặc đau đầu dữ dội sau sinh: cần cấp cứu ngay.",
        "Sốt, đau tăng hoặc vết thương có dấu hiệu nhiễm trùng: liên hệ cơ sở y tế sớm.",
        "Có ý nghĩ làm hại bản thân hoặc em bé: cần hỗ trợ khẩn cấp từ người thân và nhân viên y tế."
      ],
      "parameters": [
        {
          "name": "Tình trạng hồi phục",
          "desc": "Đánh giá theo thời gian và phương thức sinh",
          "reference": "Theo đánh giá và quy trình của cơ sở"
        },
        {
          "name": "Vết thương",
          "desc": "Xem xét khi phù hợp",
          "reference": "Theo đánh giá và quy trình của cơ sở"
        },
        {
          "name": "Sức khỏe tinh thần",
          "desc": "Trao đổi về cảm xúc và nhu cầu hỗ trợ",
          "reference": "Theo đánh giá và quy trình của cơ sở"
        }
      ],
      "process_steps": [
        {
          "title": "Tiếp nhận",
          "desc": "Xem thông tin cuộc sinh và giấy ra viện.",
          "duration_minutes": null
        },
        {
          "title": "Hỏi bệnh",
          "desc": "Trao đổi về hồi phục, triệu chứng, nghỉ ngơi và tinh thần.",
          "duration_minutes": null
        },
        {
          "title": "Thăm khám",
          "desc": "Bác sĩ đánh giá phù hợp với tình trạng và sự đồng ý.",
          "duration_minutes": null
        },
        {
          "title": "Tư vấn",
          "desc": "Lập kế hoạch chăm sóc và tái khám.",
          "duration_minutes": null
        }
      ],
      "preparation": [
        "Mang giấy ra viện, hồ sơ sinh và thuốc",
        "Ghi lại khó khăn, triệu chứng và câu hỏi",
        "Có thể đi cùng người hỗ trợ nếu muốn"
      ],
      "aftercare": [
        "Theo dõi sức khỏe theo hướng dẫn",
        "Giữ liên hệ với cơ sở và hẹn tái khám",
        "Tìm hỗ trợ sớm khi gặp khó khăn về thể chất hoặc tinh thần"
      ],
      "accuracy_note": "Buổi khám đánh giá theo tình trạng tại thời điểm thăm khám; không thay thế đánh giá khẩn hoặc chăm sóc chuyên sâu khi cần.",
      "faqs": [
        {
          "q": "Sinh mổ và sinh thường đều khám được không?",
          "a": "Có. Nội dung sẽ được điều chỉnh theo hồ sơ và tình trạng."
        },
        {
          "q": "Có cần đợi đến một mốc cố định mới khám không?",
          "a": "Không nên trì hoãn khi có vấn đề; lịch tùy kế hoạch theo dõi và tình trạng."
        },
        {
          "q": "Tư vấn cho bú có nằm trong buổi khám không?",
          "a": "Có thể trao đổi vấn đề liên quan, nếu cần hỗ trợ chuyên biệt sẽ được tư vấn dịch vụ tương ứng."
        }
      ],
      "performed_by": "Bác sĩ phụ trách chăm sóc sau sinh",
      "references": [
        {
          "title": "WHO recommendations on maternal and newborn care for a positive postnatal experience (2022)",
          "org": "WHO"
        }
      ],
      "disclaimer": "Thông tin danh mục phục vụ mô phỏng hệ thống Tâm An, chỉ mang tính tham khảo và cần được rà soát chuyên môn trước khi sử dụng thực tế. Không thay thế thăm khám, chẩn đoán hoặc điều trị. Phạm vi dịch vụ, chỉ định, chi phí và khả năng tiếp nhận phải được cơ sở xác nhận."
    },
    "TRIPLE_TEST": {
      "schema_version": 1,
      "review": {
        "status": "DRAFT",
        "needs_medical_review": true
      },
      "intro": "Triple Test sử dụng ba dấu ấn sinh hóa trong máu mẹ ở quý hai. Bác sĩ đối chiếu tuổi thai và kết quả trước đó để đánh giá sự phù hợp, tư vấn ý nghĩa của nguy cơ bất thường nhiễm sắc thể và khuyết tật ống thần kinh theo quy trình xét nghiệm. Không thay thế xét nghiệm chẩn đoán.\n\nTriple Test thuộc nhóm xét nghiệm sàng lọc huyết thanh ở giai đoạn giữa thai kỳ. Phương pháp khác Double Test ở số lượng và loại dấu ấn sinh hóa, cũng như thời điểm thực hiện. Kết quả được diễn giải dựa trên các thông tin cần thiết, không chỉ nhìn riêng một chỉ số. Việc lựa chọn Triple Test còn phụ thuộc những sàng lọc đã thực hiện, khả năng áp dụng của chương trình và chỉ định chuyên môn. Nếu người dùng đang ở quý một, cần được tư vấn phương pháp phù hợp với quý một, không tự chuyển sang Triple Test. Nếu kết quả nguy cơ cao, bác sĩ có thể đề xuất siêu âm, tư vấn chuyên sâu hoặc các kiểm tra khác. Báo cáo sàng lọc không tự xác định thai có hoặc không có bệnh.",
      "key_facts": [
        {
          "icon": "calendar-days",
          "label": "Giai đoạn",
          "value": "Quý hai; cơ sở xác nhận tuổi thai phù hợp"
        },
        {
          "icon": "clipboard-check",
          "label": "Mẫu",
          "value": "Máu mẹ"
        },
        {
          "icon": "info",
          "label": "Dấu ấn",
          "value": "AFP, hCG, uE3"
        },
        {
          "icon": "file-text",
          "label": "Kết quả",
          "value": "Ước lượng nguy cơ"
        }
      ],
      "highlights": [
        {
          "icon": "stethoscope",
          "title": "Phân biệt mốc thai",
          "desc": "Không lẫn với sàng lọc sinh hóa quý một."
        },
        {
          "icon": "clipboard-check",
          "title": "Đánh giá kết hợp",
          "desc": "Xem dữ liệu tuổi thai và tiền sử phù hợp."
        },
        {
          "icon": "message-circle",
          "title": "Giải thích giới hạn",
          "desc": "Không dùng kết quả như chẩn đoán."
        },
        {
          "icon": "shield-check",
          "title": "Phối hợp",
          "desc": "Tư vấn bước tiếp theo nếu cần."
        }
      ],
      "suitable_for": [
        "Thai phụ quý hai được bác sĩ tư vấn Triple Test",
        "Thai phụ cần trao đổi lựa chọn sàng lọc giữa thai kỳ",
        "Thai phụ có hồ sơ tuổi thai và dữ liệu cần thiết"
      ],
      "not_suitable_for": [
        "Không dùng thay Double Test cho nhu cầu xét nghiệm quý một",
        "Không phải phương pháp chẩn đoán xác định"
      ],
      "parameters": [
        {
          "name": "AFP",
          "desc": "Dấu ấn được sử dụng trong sàng lọc huyết thanh",
          "reference": "Theo đánh giá và quy trình của cơ sở"
        },
        {
          "name": "hCG",
          "desc": "Dấu ấn liên quan thai kỳ",
          "reference": "Theo đánh giá và quy trình của cơ sở"
        },
        {
          "name": "uE3",
          "desc": "Một thành phần của Triple Test",
          "reference": "Theo đánh giá và quy trình của cơ sở"
        }
      ],
      "process_steps": [
        {
          "title": "Rà soát",
          "desc": "Đối chiếu tuổi thai và xét nghiệm đã thực hiện.",
          "duration_minutes": null
        },
        {
          "title": "Giải thích",
          "desc": "Trao đổi mục đích, các dấu ấn và giới hạn.",
          "duration_minutes": null
        },
        {
          "title": "Lấy mẫu",
          "desc": "Thực hiện theo quy trình của phòng xét nghiệm.",
          "duration_minutes": null
        },
        {
          "title": "Đọc kết quả",
          "desc": "Bác sĩ đánh giá nguy cơ và hướng tiếp theo.",
          "duration_minutes": null
        }
      ],
      "preparation": [
        "Mang hồ sơ tuổi thai và siêu âm trước",
        "Báo các sàng lọc đã làm",
        "Hỏi về thời điểm lấy mẫu và chuẩn bị"
      ],
      "aftercare": [
        "Lưu báo cáo và trao đổi tại lần khám",
        "Hẹn đánh giá nếu được tư vấn",
        "Không tự kết luận từ một chỉ số"
      ],
      "warning_signs": [
        "Ra máu nhiều, đau bụng dữ dội, khó thở hoặc ngất: cần hỗ trợ y tế ngay, không chờ lịch khám thường."
      ],
      "accuracy_note": "Không phải xét nghiệm chẩn đoán. Khoảng thời gian nhận mẫu và phương thức tính nguy cơ phải theo quy trình đã được cơ sở xác nhận.",
      "faqs": [
        {
          "q": "Có làm Triple Test ở ba tháng đầu không?",
          "a": "Triple Test là xét nghiệm quý hai. Hỏi bác sĩ về phương pháp quý một phù hợp."
        },
        {
          "q": "Có phải ai cũng cần Triple Test không?",
          "a": "Không mặc định; lựa chọn dựa trên tuổi thai, xét nghiệm đã làm và chương trình sàng lọc."
        },
        {
          "q": "Có cần xét nghiệm thêm nếu nguy cơ cao?",
          "a": "Bác sĩ sẽ tư vấn các phương pháp đánh giá hoặc xác nhận thích hợp."
        }
      ],
      "performed_by": "Nhân viên xét nghiệm và bác sĩ tư vấn",
      "references": [
        {
          "title": "Quadruple screen test (includes triple screen test definition)",
          "org": "MedlinePlus"
        }
      ],
      "disclaimer": "Thông tin danh mục phục vụ mô phỏng hệ thống Tâm An, chỉ mang tính tham khảo và cần được rà soát chuyên môn trước khi sử dụng thực tế. Không thay thế thăm khám, chẩn đoán hoặc điều trị. Phạm vi dịch vụ, chỉ định, chi phí và khả năng tiếp nhận phải được cơ sở xác nhận."
    },
    "US_2D": {
      "schema_version": 1,
      "review": {
        "status": "DRAFT",
        "needs_medical_review": true
      },
      "intro": "Siêu âm sử dụng hình ảnh hai chiều để bác sĩ khảo sát các thông tin cần thiết phù hợp giai đoạn mang thai. Có thể hỗ trợ đánh giá vị trí, tuổi thai, hoạt động tim thai, kích thước, nhau thai hoặc nước ối theo chỉ định. Không thay thế siêu âm hình thái chuyên sâu.\n\nSiêu âm thai 2D là phương pháp khảo sát hình ảnh phổ biến trong quá trình quản lý thai nghén. Ở mỗi giai đoạn, câu hỏi lâm sàng cần trả lời có thể khác nhau: khi thai còn sớm, bác sĩ cần đánh giá thông tin ban đầu; ở những lần theo dõi sau, các dữ liệu về tăng trưởng, vị trí và những cấu trúc quan sát được có thể được xem xét. Người thực hiện sẽ lựa chọn đường khảo sát và các phép đo phù hợp. Khi hình ảnh chưa rõ, không đủ thông tin hoặc phát hiện vấn đề cần đánh giá thêm, bác sĩ có thể hẹn kiểm tra hoặc giới thiệu siêu âm chuyên sâu. Kết quả cần được đọc cùng tuổi thai, tiền sử và khám lâm sàng, không tự suy diễn một kết quả đơn lẻ thành chẩn đoán.",
      "key_facts": [
        {
          "icon": "calendar-days",
          "label": "Phương pháp",
          "value": "Hình ảnh 2D"
        },
        {
          "icon": "clipboard-check",
          "label": "Thời điểm",
          "value": "Theo tuổi thai và chỉ định"
        },
        {
          "icon": "info",
          "label": "Chuẩn bị",
          "value": "Hỏi trước về bàng quang"
        },
        {
          "icon": "file-text",
          "label": "Kết quả",
          "value": "Báo cáo khảo sát"
        }
      ],
      "highlights": [
        {
          "icon": "stethoscope",
          "title": "Khảo sát theo mục tiêu",
          "desc": "Chọn phép đo phù hợp với giai đoạn."
        },
        {
          "icon": "clipboard-check",
          "title": "Theo dõi tăng trưởng",
          "desc": "Hỗ trợ đối chiếu thông tin qua các lần khảo sát."
        },
        {
          "icon": "message-circle",
          "title": "Giải thích giới hạn",
          "desc": "Hình ảnh phụ thuộc điều kiện khảo sát."
        },
        {
          "icon": "shield-check",
          "title": "Phối hợp",
          "desc": "Chuyển đánh giá sâu khi cần."
        }
      ],
      "suitable_for": [
        "Thai phụ được bác sĩ hẹn siêu âm cơ bản",
        "Thai phụ cần đánh giá thông tin thai ở thời điểm phù hợp",
        "Thai phụ cần đối chiếu kết quả theo dõi"
      ],
      "not_suitable_for": [
        "Không dùng để trì hoãn đánh giá cấp cứu",
        "Không mặc định thay thế siêu âm hình thái hoặc xét nghiệm sàng lọc"
      ],
      "parameters": [
        {
          "name": "Tuổi thai",
          "desc": "Đối chiếu thông tin phù hợp giai đoạn",
          "reference": "Theo đánh giá và quy trình của cơ sở"
        },
        {
          "name": "Hoạt động tim thai",
          "desc": "Đánh giá khi có thể khảo sát",
          "reference": "Theo đánh giá và quy trình của cơ sở"
        },
        {
          "name": "Tăng trưởng",
          "desc": "Phép đo theo chỉ định",
          "reference": "Theo đánh giá và quy trình của cơ sở"
        },
        {
          "name": "Nhau thai và nước ối",
          "desc": "Khảo sát khi phù hợp",
          "reference": "Theo đánh giá và quy trình của cơ sở"
        }
      ],
      "process_steps": [
        {
          "title": "Đối chiếu",
          "desc": "Xem tuổi thai và chỉ định.",
          "duration_minutes": null
        },
        {
          "title": "Chuẩn bị",
          "desc": "Giải thích phương pháp và tư thế phù hợp.",
          "duration_minutes": null
        },
        {
          "title": "Khảo sát",
          "desc": "Thực hiện siêu âm theo mục tiêu.",
          "duration_minutes": null
        },
        {
          "title": "Trả kết quả",
          "desc": "Giải thích nội dung và giới hạn, hẹn thêm nếu cần.",
          "duration_minutes": null
        }
      ],
      "preparation": [
        "Mang kết quả siêu âm trước",
        "Hỏi yêu cầu chuẩn bị bàng quang",
        "Báo các triệu chứng trước khi thực hiện"
      ],
      "aftercare": [
        "Lưu kết quả khảo sát",
        "Mang kết quả tới bác sĩ theo dõi thai",
        "Thực hiện hẹn kiểm tra lại nếu được chỉ định"
      ],
      "warning_signs": [
        "Ra máu nhiều, đau bụng dữ dội, khó thở hoặc ngất: cần hỗ trợ y tế ngay, không chờ lịch khám thường."
      ],
      "accuracy_note": "Một lần siêu âm không phát hiện được mọi bất thường; kết quả phụ thuộc tuổi thai, tư thế thai và điều kiện khảo sát.",
      "faqs": [
        {
          "q": "2D có khác hình thái không?",
          "a": "Có. Siêu âm hình thái có mục tiêu khảo sát giải phẫu chi tiết hơn."
        },
        {
          "q": "Chưa nhìn rõ thai có nghĩa bất thường không?",
          "a": "Chưa thể kết luận; cần bác sĩ giải thích hoặc hẹn kiểm tra."
        },
        {
          "q": "Có cần nhịn ăn không?",
          "a": "Hỏi nhân viên y tế về chuẩn bị cho phương pháp khảo sát."
        }
      ],
      "performed_by": "Bác sĩ hoặc nhân viên siêu âm đủ năng lực chuyên môn",
      "references": [
        {
          "title": "WHO recommendations on antenatal care for a positive pregnancy experience (2016)",
          "org": "WHO"
        },
        {
          "title": "Practice Guidelines: performance of the routine mid-trimester fetal ultrasound scan (2022)",
          "org": "ISUOG"
        }
      ],
      "disclaimer": "Thông tin danh mục phục vụ mô phỏng hệ thống Tâm An, chỉ mang tính tham khảo và cần được rà soát chuyên môn trước khi sử dụng thực tế. Không thay thế thăm khám, chẩn đoán hoặc điều trị. Phạm vi dịch vụ, chỉ định, chi phí và khả năng tiếp nhận phải được cơ sở xác nhận."
    },
    "PACKAGE_BIRTH_SURGERY": {
      "schema_version": 1,
      "review": {
        "status": "DRAFT",
        "needs_medical_review": true
      },
      "intro": "Gói mô tả quy trình dự kiến khi bác sĩ xác định sinh mổ là lựa chọn phù hợp, gồm đánh giá trước phẫu thuật, phối hợp gây mê hồi sức và chăm sóc sau mổ. Thời điểm, phương thức sinh và phạm vi chi phí cần được xác nhận bởi nhân viên chuyên môn và bộ phận dịch vụ.\n\nSinh mổ là một phương thức sinh bằng phẫu thuật, có những lợi ích và nguy cơ cần được trao đổi riêng với từng người. Gói Bình An dành cho gia đình muốn tìm hiểu kế hoạch chăm sóc khi có nhu cầu hoặc chỉ định mổ lấy thai. Bác sĩ sẽ xem xét tuổi thai, tiền sử phẫu thuật, tình trạng mẹ và thai, rồi giải thích các lựa chọn và việc chuẩn bị. Nhân viên dịch vụ xác nhận phạm vi dự kiến của gói và những khoản không bao gồm. Sau mổ, người mẹ được theo dõi tình trạng hồi phục, được hướng dẫn chăm sóc vết thương và kế hoạch tái khám. Đăng ký trên website không xác lập chỉ định mổ, không giữ lịch phẫu thuật và không cam kết một kỹ thuật, thời gian lưu viện hay kết quả cụ thể khi chưa được đánh giá.",
      "key_facts": [
        {
          "icon": "calendar-days",
          "label": "Phương thức",
          "value": "Mổ lấy thai khi được bác sĩ đánh giá"
        },
        {
          "icon": "clipboard-check",
          "label": "Chuẩn bị",
          "value": "Đánh giá trước mổ"
        },
        {
          "icon": "info",
          "label": "Sau mổ",
          "value": "Theo dõi phục hồi và chăm sóc vết thương"
        },
        {
          "icon": "file-text",
          "label": "Xác nhận",
          "value": "Cần bộ phận dịch vụ xác nhận"
        }
      ],
      "highlights": [
        {
          "icon": "stethoscope",
          "title": "Đánh giá chỉ định",
          "desc": "Trao đổi lợi ích, nguy cơ và lựa chọn."
        },
        {
          "icon": "clipboard-check",
          "title": "Phối hợp chuyên môn",
          "desc": "Chuẩn bị chăm sóc phẫu thuật và gây mê theo chỉ định."
        },
        {
          "icon": "message-circle",
          "title": "Theo dõi hồi phục",
          "desc": "Hướng dẫn chăm sóc mẹ và phối hợp chăm sóc bé."
        },
        {
          "icon": "shield-check",
          "title": "Minh bạch",
          "desc": "Xác nhận phạm vi và chi phí phát sinh."
        }
      ],
      "suitable_for": [
        "Thai phụ đã được tư vấn hoặc có nhu cầu tìm hiểu sinh mổ",
        "Gia đình cần biết quy trình chuẩn bị và chăm sóc sau mổ",
        "Thai phụ có tiền sử cần bác sĩ đánh giá phương thức sinh"
      ],
      "not_suitable_for": [
        "Không tự quyết định ngày mổ hoặc chỉ định qua website",
        "Trường hợp cấp cứu cần được tiếp nhận ngay"
      ],
      "package": {
        "included_groups": [
          {
            "group": "Nhóm phẫu thuật dự kiến",
            "items": [
              {
                "name": "Bác sĩ phụ trách phẫu thuật"
              },
              {
                "name": "Bác sĩ gây mê hồi sức"
              },
              {
                "name": "Nhân viên phụ trách chăm sóc sơ sinh"
              },
              {
                "name": "Điều dưỡng và hộ sinh theo phân công"
              }
            ]
          },
          {
            "group": "Chuẩn bị phẫu thuật",
            "items": [
              {
                "name": "Phòng phẫu thuật theo quy trình cơ sở"
              },
              {
                "name": "Phương án phẫu thuật do bác sĩ xác nhận"
              },
              {
                "name": "Phương án gây mê hoặc gây tê theo đánh giá"
              }
            ]
          },
          {
            "group": "Hỗ trợ sau mổ",
            "items": [
              {
                "name": "Hỗ trợ giảm đau theo chỉ định"
              }
            ]
          },
          {
            "group": "Theo dõi phục hồi",
            "items": [
              {
                "name": "Phòng lưu viện theo phạm vi đã xác nhận",
                "qty": "Theo xác nhận gói"
              },
              {
                "name": "Chăm sóc sau mổ và hướng dẫn gia đình"
              }
            ]
          }
        ],
        "excluded": [
          "Các can thiệp hoặc chăm sóc phát sinh ngoài phạm vi gói đã xác nhận",
          "Chi phí điều trị biến chứng hoặc chăm sóc chuyên sâu nếu phát sinh ngoài điều khoản",
          "Các ngày lưu viện bổ sung và dịch vụ tùy chọn ngoài gói",
          "Thuốc, vật tư hoặc xét nghiệm ngoài danh mục đã xác nhận"
        ],
        "conditions": [
          "Được bác sĩ đánh giá tình trạng và phương thức sinh phù hợp",
          "Thống nhất phạm vi gói, chi phí và điều khoản trước khi đăng ký",
          "Kế hoạch có thể thay đổi khi có chỉ định y khoa",
          "Thông tin gói cần bộ phận dịch vụ xác nhận; không xác nhận qua chatbot"
        ],
        "needs_confirmation": true
      },
      "process_steps": [
        {
          "title": "Khám đánh giá",
          "desc": "Rà soát hồ sơ và trao đổi phương thức sinh.",
          "duration_minutes": null
        },
        {
          "title": "Xác nhận kế hoạch",
          "desc": "Nhân viên chuyên môn và dịch vụ xác nhận các nội dung liên quan.",
          "duration_minutes": null
        },
        {
          "title": "Thực hiện khi phù hợp",
          "desc": "Phẫu thuật chỉ tiến hành theo chỉ định và quy trình được duyệt.",
          "duration_minutes": null
        },
        {
          "title": "Sau mổ",
          "desc": "Theo dõi phục hồi, hướng dẫn ra viện và tái khám.",
          "duration_minutes": null
        }
      ],
      "preparation": [
        "Mang hồ sơ thai và phẫu thuật cũ nếu có",
        "Báo dị ứng, thuốc và bệnh nền",
        "Tuân thủ hướng dẫn chuẩn bị trước mổ của cơ sở"
      ],
      "aftercare": [
        "Theo dõi vết mổ và tình trạng phục hồi theo hướng dẫn",
        "Không tự thay đổi thuốc đã kê",
        "Tái khám theo lịch và liên hệ khi có bất thường"
      ],
      "warning_signs": [
        "Ra máu nhiều, đau ngực, khó thở, ngất hoặc đau đầu dữ dội sau sinh: cần cấp cứu ngay.",
        "Trẻ khó thở, tím tái, li bì, bỏ bú hoặc có bất thường nhiệt độ: đưa trẻ đi đánh giá y tế ngay.",
        "Vết mổ đỏ lan, chảy dịch, đau tăng hoặc sốt: liên hệ cơ sở y tế sớm."
      ],
      "accuracy_note": "Gói không bảo đảm phương thức sinh, kỹ thuật hoặc kết quả; kế hoạch có thể thay đổi theo đánh giá y khoa.",
      "faqs": [
        {
          "q": "Có thể tự chọn ngày mổ qua ứng dụng không?",
          "a": "Không. Bác sĩ cần đánh giá và xác nhận thời điểm."
        },
        {
          "q": "Gói có bao gồm tất cả chi phí không?",
          "a": "Phạm vi, ngày lưu viện và khoản phát sinh cần được xác nhận."
        },
        {
          "q": "Sinh mổ có thay thế được sinh thường nếu tôi muốn không?",
          "a": "Cần trao đổi lợi ích, nguy cơ và tình trạng cụ thể với bác sĩ."
        }
      ],
      "performed_by": "Bác sĩ Sản khoa, gây mê hồi sức và nhóm chăm sóc được phân công",
      "references": [
        {
          "title": "WHO recommendations on antenatal care for a positive pregnancy experience (2016)",
          "org": "WHO"
        },
        {
          "title": "WHO recommendations on maternal and newborn care for a positive postnatal experience (2022)",
          "org": "WHO"
        }
      ],
      "disclaimer": "Thông tin danh mục phục vụ mô phỏng hệ thống Tâm An, chỉ mang tính tham khảo và cần được rà soát chuyên môn trước khi sử dụng thực tế. Không thay thế thăm khám, chẩn đoán hoặc điều trị. Phạm vi dịch vụ, chỉ định, chi phí và khả năng tiếp nhận phải được cơ sở xác nhận."
    },
    "DOUBLE_TEST": {
      "schema_version": 1,
      "review": {
        "status": "DRAFT",
        "needs_medical_review": true
      },
      "intro": "Double Test đánh giá nguy cơ một số bất thường nhiễm sắc thể ở giai đoạn đầu thai kỳ. Bác sĩ xác nhận tuổi thai, xem các phép đo siêu âm và các dữ liệu cần thiết để lựa chọn quy trình sàng lọc. Kết quả chỉ là ước lượng nguy cơ, không kết luận thai mắc bệnh.\n\nDouble Test là một phần của lựa chọn sàng lọc trước sinh ở quý một. Khi thực hiện chương trình sàng lọc kết hợp, dữ liệu xét nghiệm máu được xem xét cùng thông tin tuổi thai và kết quả siêu âm phù hợp, chẳng hạn đo độ mờ da gáy theo quy trình. Mục đích của buổi hẹn là lấy mẫu đúng thời điểm và giúp thai phụ hiểu báo cáo nguy cơ. Cửa sổ thực hiện của từng thành phần xét nghiệm có thể khác nhau theo chương trình và đơn vị xét nghiệm; không đặt Triple Test quý hai thay cho Double Test chỉ vì cùng là xét nghiệm máu. Nếu đã qua mốc phù hợp hoặc đã thực hiện một phương pháp sàng lọc khác, bác sĩ sẽ tư vấn lựa chọn tiếp theo dựa trên thông tin cá nhân. Không mặc định chỉ định nhiều xét nghiệm đồng thời.",
      "key_facts": [
        {
          "icon": "calendar-days",
          "label": "Giai đoạn",
          "value": "Quý một, xác nhận cửa sổ thực hiện"
        },
        {
          "icon": "clipboard-check",
          "label": "Mẫu",
          "value": "Máu mẹ"
        },
        {
          "icon": "info",
          "label": "Thông tin kết hợp",
          "value": "Tuổi thai, siêu âm và dữ liệu cần thiết"
        },
        {
          "icon": "file-text",
          "label": "Kết quả",
          "value": "Ước lượng nguy cơ"
        }
      ],
      "highlights": [
        {
          "icon": "stethoscope",
          "title": "Đúng giai đoạn",
          "desc": "Đối chiếu tuổi thai trước khi lấy mẫu."
        },
        {
          "icon": "clipboard-check",
          "title": "Phối hợp dữ liệu",
          "desc": "Sử dụng kết quả siêu âm phù hợp khi cần."
        },
        {
          "icon": "message-circle",
          "title": "Giải thích báo cáo",
          "desc": "Phân biệt sàng lọc và chẩn đoán."
        },
        {
          "icon": "shield-check",
          "title": "Lựa chọn tiếp",
          "desc": "Tư vấn nếu đã qua mốc hoặc có kết quả cần đánh giá."
        }
      ],
      "suitable_for": [
        "Thai phụ ở quý một cần tư vấn sàng lọc",
        "Thai phụ đã được chỉ định Double Test",
        "Thai phụ có thông tin tuổi thai và hồ sơ phù hợp"
      ],
      "not_suitable_for": [
        "Không áp dụng mặc định cho quý hai hoặc quý ba",
        "Không dùng để xác định chắc chắn bất thường nhiễm sắc thể"
      ],
      "parameters": [
        {
          "name": "PAPP-A",
          "desc": "Một dấu ấn sinh hóa dùng trong sàng lọc",
          "reference": "Theo đánh giá và quy trình của cơ sở"
        },
        {
          "name": "Free β-hCG",
          "desc": "Một dấu ấn sinh hóa dùng trong sàng lọc",
          "reference": "Theo đánh giá và quy trình của cơ sở"
        },
        {
          "name": "Tuổi thai và siêu âm",
          "desc": "Thông tin cần để diễn giải theo quy trình",
          "reference": "Theo đánh giá và quy trình của cơ sở"
        }
      ],
      "process_steps": [
        {
          "title": "Kiểm tra hồ sơ",
          "desc": "Xác nhận tuổi thai và dữ liệu cần thiết.",
          "duration_minutes": null
        },
        {
          "title": "Tư vấn",
          "desc": "Giải thích phạm vi và giới hạn.",
          "duration_minutes": null
        },
        {
          "title": "Lấy mẫu",
          "desc": "Thực hiện theo quy trình xét nghiệm.",
          "duration_minutes": null
        },
        {
          "title": "Đọc báo cáo",
          "desc": "Trao đổi nguy cơ và các bước tiếp theo.",
          "duration_minutes": null
        }
      ],
      "preparation": [
        "Mang kết quả siêu âm và sàng lọc đã có",
        "Xác nhận mốc thai và yêu cầu chuẩn bị",
        "Báo tiền sử liên quan trước xét nghiệm"
      ],
      "aftercare": [
        "Lưu báo cáo",
        "Tiếp tục khám thai và các mốc được tư vấn",
        "Nếu kết quả bất thường, trao đổi với bác sĩ"
      ],
      "warning_signs": [
        "Ra máu nhiều, đau bụng dữ dội, khó thở hoặc ngất: cần hỗ trợ y tế ngay, không chờ lịch khám thường."
      ],
      "accuracy_note": "Kết quả phụ thuộc độ chính xác của dữ liệu đầu vào và quy trình; chỉ phản ánh nguy cơ, không phải kết luận bệnh.",
      "faqs": [
        {
          "q": "Double Test khác Triple Test ra sao?",
          "a": "Double Test thuộc sàng lọc quý một; Triple Test thuộc quý hai, có các dấu ấn khác."
        },
        {
          "q": "Có cần làm cả NIPT không?",
          "a": "Không mặc định. Bác sĩ tư vấn lựa chọn phù hợp."
        },
        {
          "q": "Kết quả nguy cơ cao là chẩn đoán chưa?",
          "a": "Chưa; cần tư vấn và đánh giá thêm."
        }
      ],
      "performed_by": "Nhân viên xét nghiệm và bác sĩ tư vấn sàng lọc",
      "references": [
        {
          "title": "Screening for Down’s syndrome, Edwards’ syndrome and Patau’s syndrome",
          "org": "NHS"
        }
      ],
      "disclaimer": "Thông tin danh mục phục vụ mô phỏng hệ thống Tâm An, chỉ mang tính tham khảo và cần được rà soát chuyên môn trước khi sử dụng thực tế. Không thay thế thăm khám, chẩn đoán hoặc điều trị. Phạm vi dịch vụ, chỉ định, chi phí và khả năng tiếp nhận phải được cơ sở xác nhận."
    },
    "PACKAGE_BIRTH_STANDARD": {
      "schema_version": 1,
      "review": {
        "status": "DRAFT",
        "needs_medical_review": true
      },
      "intro": "Gói dành cho gia đình tìm hiểu kế hoạch sinh thường. Bác sĩ đánh giá điều kiện sản khoa, trao đổi phương án theo dõi, hỗ trợ giảm đau khi phù hợp và chăm sóc sau sinh. Danh mục và chi phí gói phải được bộ phận dịch vụ xác nhận; đăng ký không bảo đảm phương thức sinh cuối cùng.\n\nGói sinh thường Hạnh Phúc mô tả một lộ trình chăm sóc dự kiến từ khâu tiếp nhận sản phụ, theo dõi chuyển dạ, hỗ trợ sinh qua đường âm đạo đến giai đoạn theo dõi ban đầu sau sinh. Người mẹ và gia đình được trao đổi về những nội dung dự kiến, các lựa chọn giảm đau, sự hỗ trợ của người chăm sóc và những tình huống có thể làm thay đổi kế hoạch. Việc sinh thường phụ thuộc đánh giá của bác sĩ tại thời điểm phù hợp; nếu tình trạng mẹ hoặc thai thay đổi, phương án chăm sóc có thể cần điều chỉnh. Gói không phải cam kết sinh thường bằng mọi giá. Mức giá trong hệ thống là dữ liệu mô phỏng và không thay thế báo giá đã được xác nhận về phạm vi, ngày lưu viện, dịch vụ ngoài gói hay chi phí phát sinh.",
      "key_facts": [
        {
          "icon": "calendar-days",
          "label": "Phương thức",
          "value": "Sinh qua đường âm đạo nếu phù hợp"
        },
        {
          "icon": "clipboard-check",
          "label": "Giảm đau",
          "value": "Theo chỉ định và nguyện vọng"
        },
        {
          "icon": "info",
          "label": "Chăm sóc",
          "value": "Theo dõi mẹ và bé sau sinh"
        },
        {
          "icon": "file-text",
          "label": "Xác nhận",
          "value": "Cần bộ phận dịch vụ xác nhận"
        }
      ],
      "highlights": [
        {
          "icon": "stethoscope",
          "title": "Kế hoạch sinh",
          "desc": "Trao đổi nguyện vọng và điều kiện sản khoa."
        },
        {
          "icon": "clipboard-check",
          "title": "Theo dõi chuyển dạ",
          "desc": "Đánh giá tình trạng mẹ và thai theo chỉ định."
        },
        {
          "icon": "message-circle",
          "title": "Chăm sóc sau sinh",
          "desc": "Hướng dẫn phục hồi và phối hợp hỗ trợ trẻ."
        },
        {
          "icon": "shield-check",
          "title": "Minh bạch phạm vi",
          "desc": "Xác nhận chi phí và điều khoản trước khi đăng ký."
        }
      ],
      "suitable_for": [
        "Thai phụ muốn tìm hiểu phương án sinh thường",
        "Gia đình chuẩn bị kế hoạch đón bé",
        "Thai phụ đã được bác sĩ tư vấn khả năng sinh qua đường âm đạo"
      ],
      "not_suitable_for": [
        "Không bảo đảm sinh thường nếu có chỉ định khác",
        "Không sử dụng lịch tư vấn thay cho cấp cứu hoặc tiếp nhận chuyển dạ"
      ],
      "package": {
        "included_groups": [
          {
            "group": "Tiếp nhận và hỗ trợ sinh",
            "items": [
              {
                "name": "Bác sĩ Sản khoa tham gia chăm sóc"
              },
              {
                "name": "Hộ sinh hỗ trợ sản phụ"
              }
            ]
          },
          {
            "group": "Theo dõi và hỗ trợ giảm đau",
            "items": [
              {
                "name": "Theo dõi mẹ và thai khi chuyển dạ"
              },
              {
                "name": "Hỗ trợ giảm đau theo phương án phù hợp",
                "note": "Theo chỉ định và sự đồng ý"
              }
            ]
          },
          {
            "group": "Chăm sóc trẻ",
            "items": [
              {
                "name": "Chăm sóc sơ sinh theo quy trình được xác nhận"
              },
              {
                "name": "Hỗ trợ tiếp xúc mẹ bé và hướng dẫn cho bú khi phù hợp"
              }
            ]
          },
          {
            "group": "Theo dõi sau sinh",
            "items": [
              {
                "name": "Phòng lưu viện theo phạm vi đã xác nhận",
                "qty": "Theo xác nhận gói"
              },
              {
                "name": "Hướng dẫn chăm sóc và tái khám"
              }
            ]
          }
        ],
        "excluded": [
          "Các can thiệp hoặc chăm sóc phát sinh ngoài phạm vi gói đã xác nhận",
          "Chi phí điều trị biến chứng hoặc chăm sóc chuyên sâu nếu phát sinh ngoài điều khoản",
          "Các ngày lưu viện bổ sung và dịch vụ tùy chọn ngoài gói",
          "Thuốc, vật tư hoặc xét nghiệm ngoài danh mục đã xác nhận"
        ],
        "conditions": [
          "Được bác sĩ đánh giá tình trạng và phương thức sinh phù hợp",
          "Thống nhất phạm vi gói, chi phí và điều khoản trước khi đăng ký",
          "Kế hoạch có thể thay đổi khi có chỉ định y khoa",
          "Thông tin gói cần bộ phận dịch vụ xác nhận; không xác nhận qua chatbot"
        ],
        "needs_confirmation": true
      },
      "process_steps": [
        {
          "title": "Tư vấn trước sinh",
          "desc": "Rà soát hồ sơ và nguyện vọng.",
          "duration_minutes": null
        },
        {
          "title": "Xác nhận gói",
          "desc": "Bộ phận phụ trách giải thích phạm vi và chi phí.",
          "duration_minutes": null
        },
        {
          "title": "Tiếp nhận khi sinh",
          "desc": "Nhân viên y tế đánh giá tình trạng và chọn phương thức xử trí.",
          "duration_minutes": null
        },
        {
          "title": "Sau sinh",
          "desc": "Theo dõi, bàn giao và hướng dẫn chăm sóc.",
          "duration_minutes": null
        }
      ],
      "preparation": [
        "Mang sổ khám và giấy tờ cần thiết",
        "Chuẩn bị kế hoạch liên hệ cơ sở khi có dấu hiệu chuyển dạ",
        "Xác nhận điều khoản và phạm vi gói"
      ],
      "aftercare": [
        "Thực hiện theo hướng dẫn ra viện",
        "Hẹn theo dõi sau sinh",
        "Liên hệ cơ sở nếu có dấu hiệu bất thường"
      ],
      "warning_signs": [
        "Ra máu nhiều, đau bụng dữ dội, khó thở hoặc ngất: cần hỗ trợ y tế ngay, không chờ lịch khám thường.",
        "Ra máu nhiều, đau ngực, khó thở, ngất hoặc đau đầu dữ dội sau sinh: cần cấp cứu ngay.",
        "Trẻ khó thở, tím tái, li bì, bỏ bú hoặc có bất thường nhiệt độ: đưa trẻ đi đánh giá y tế ngay."
      ],
      "technology": {
        "title": "Theo dõi mẹ và thai trong chuyển dạ",
        "desc": "Phương pháp theo dõi được lựa chọn theo tình trạng lâm sàng và quy trình đã xác nhận của cơ sở.",
        "items": [
          "Đánh giá mẹ",
          "Theo dõi tim thai phù hợp",
          "Phối hợp xử trí khi có chỉ định"
        ]
      },
      "accuracy_note": "Không thể dự đoán chắc chắn diễn biến chuyển dạ. Phạm vi gói và khả năng thực hiện phải được xác nhận.",
      "faqs": [
        {
          "q": "Đặt gói có chắc sinh thường không?",
          "a": "Không. Phương thức sinh do bác sĩ đánh giá theo diễn biến."
        },
        {
          "q": "Chi phí có cố định không?",
          "a": "Cần xác nhận phạm vi, điều khoản và các khoản ngoài gói."
        },
        {
          "q": "Có thể đăng ký qua chatbot ngay không?",
          "a": "Chatbot chỉ hỗ trợ tìm thông tin và tra lịch tư vấn; gói cần nhân viên xác nhận."
        }
      ],
      "performed_by": "Bác sĩ Sản khoa, hộ sinh và nhân viên được phân công",
      "references": [
        {
          "title": "WHO recommendations on antenatal care for a positive pregnancy experience (2016)",
          "org": "WHO"
        },
        {
          "title": "WHO recommendations on maternal and newborn care for a positive postnatal experience (2022)",
          "org": "WHO"
        }
      ],
      "disclaimer": "Thông tin danh mục phục vụ mô phỏng hệ thống Tâm An, chỉ mang tính tham khảo và cần được rà soát chuyên môn trước khi sử dụng thực tế. Không thay thế thăm khám, chẩn đoán hoặc điều trị. Phạm vi dịch vụ, chỉ định, chi phí và khả năng tiếp nhận phải được cơ sở xác nhận."
    },
    "MATERNAL_NUTRITION": {
      "schema_version": 1,
      "review": {
        "status": "DRAFT",
        "needs_medical_review": true
      },
      "intro": "Buổi tư vấn tập trung vào dinh dưỡng, cách tổ chức bữa ăn, khả năng dung nạp và các khó khăn khi ăn uống. Nhân viên chuyên môn xem xét thể trạng, tuần thai và thông tin bệnh lý để trao đổi kế hoạch phù hợp; không tự kê đơn vi chất hoặc áp dụng chế độ ăn chung cho mọi người.\n\nDinh dưỡng trong thai kỳ cần đáp ứng nhu cầu của người mẹ trong bối cảnh sức khỏe, sinh hoạt và giai đoạn mang thai. Thay vì chỉ đưa một danh sách thực phẩm hoặc một mức tăng cân áp dụng cho tất cả, buổi tư vấn tìm hiểu bữa ăn thực tế, tình trạng nghén, khẩu vị, khả năng tiếp cận thực phẩm và những chỉ định đã có. Người mẹ được hỗ trợ lựa chọn cách ăn uống có thể duy trì trong cuộc sống hằng ngày. Khi có bệnh lý liên quan như đái tháo đường thai kỳ hoặc tăng huyết áp, việc điều chỉnh cần phối hợp với bác sĩ đang theo dõi. Dịch vụ không thay thế khám sản khoa, không đưa thực đơn điều trị cứng nhắc và không khuyến khích tự dùng thuốc hoặc sản phẩm bổ sung không rõ nguồn gốc.",
      "key_facts": [
        {
          "icon": "calendar-days",
          "label": "Trọng tâm",
          "value": "Ăn uống và dinh dưỡng cá nhân"
        },
        {
          "icon": "clipboard-check",
          "label": "Thông tin cần có",
          "value": "Tuổi thai, cân nặng, thói quen ăn uống"
        },
        {
          "icon": "info",
          "label": "Kết quả",
          "value": "Kế hoạch tư vấn có thể thực hiện"
        },
        {
          "icon": "file-text",
          "label": "Điều chỉnh",
          "value": "Theo bệnh lý và chỉ định"
        }
      ],
      "highlights": [
        {
          "icon": "stethoscope",
          "title": "Đánh giá bữa ăn",
          "desc": "Tìm hiểu thực phẩm và sinh hoạt thực tế."
        },
        {
          "icon": "clipboard-check",
          "title": "Phù hợp cá nhân",
          "desc": "Xem xét giai đoạn thai kỳ và thể trạng."
        },
        {
          "icon": "message-circle",
          "title": "An toàn",
          "desc": "Trao đổi lưu ý khi có bệnh nền và thuốc."
        },
        {
          "icon": "shield-check",
          "title": "Theo dõi",
          "desc": "Thống nhất cách đánh giá lại kế hoạch."
        }
      ],
      "suitable_for": [
        "Thai phụ muốn cải thiện thói quen ăn uống",
        "Thai phụ cần tư vấn tăng cân hoặc khó khăn ăn uống",
        "Thai phụ có chỉ định tư vấn dinh dưỡng phối hợp điều trị"
      ],
      "not_suitable_for": [
        "Không thay thế đánh giá y tế khi nôn nhiều, mất nước hoặc có dấu hiệu cấp cứu",
        "Không phải dịch vụ tự kê đơn thuốc hay vi chất",
        "Ra máu nhiều, đau bụng dữ dội, khó thở hoặc ngất: cần hỗ trợ y tế ngay, không chờ lịch khám thường."
      ],
      "parameters": [
        {
          "name": "Thói quen ăn uống",
          "desc": "Đánh giá bữa ăn và khả năng thực hiện",
          "reference": "Theo đánh giá và quy trình của cơ sở"
        },
        {
          "name": "Thể trạng",
          "desc": "Xem xét cân nặng theo bối cảnh",
          "reference": "Theo đánh giá và quy trình của cơ sở"
        },
        {
          "name": "Bệnh lý",
          "desc": "Đối chiếu chỉ định dinh dưỡng đang có",
          "reference": "Theo đánh giá và quy trình của cơ sở"
        }
      ],
      "process_steps": [
        {
          "title": "Tiếp nhận",
          "desc": "Ghi nhu cầu, hồ sơ và thói quen ăn uống.",
          "duration_minutes": null
        },
        {
          "title": "Đánh giá",
          "desc": "Trao đổi khó khăn, thể trạng và yếu tố ảnh hưởng.",
          "duration_minutes": null
        },
        {
          "title": "Tư vấn",
          "desc": "Đề xuất kế hoạch phù hợp khả năng thực hiện.",
          "duration_minutes": null
        },
        {
          "title": "Theo dõi",
          "desc": "Thống nhất mục tiêu và thời điểm đánh giá lại.",
          "duration_minutes": null
        }
      ],
      "preparation": [
        "Ghi lại bữa ăn điển hình và thực phẩm khó dung nạp",
        "Mang kết quả khám và chỉ định hiện có",
        "Mang danh sách sản phẩm bổ sung đang dùng"
      ],
      "aftercare": [
        "Thực hiện thay đổi từng bước theo kế hoạch",
        "Ghi lại khó khăn hoặc thay đổi sức khỏe",
        "Trao đổi trước khi thay đổi thuốc hoặc chế độ điều trị"
      ],
      "accuracy_note": "Nội dung tư vấn không thay thế phác đồ điều trị; không có một chế độ ăn hoặc mức bổ sung áp dụng chung cho tất cả.",
      "faqs": [
        {
          "q": "Có thực đơn chung cho mọi thai phụ không?",
          "a": "Không. Kế hoạch cần phù hợp tuổi thai, thể trạng và điều kiện thực tế."
        },
        {
          "q": "Có tự bổ sung vi chất theo buổi tư vấn không?",
          "a": "Chỉ dùng theo hướng dẫn của người có chuyên môn."
        },
        {
          "q": "Đã khám thai chuyên gia có cần dịch vụ này không?",
          "a": "Không mặc định. Đây là buổi chuyên biệt về dinh dưỡng, có thể bổ sung khi cần."
        }
      ],
      "performed_by": "Bác sĩ hoặc nhân viên tư vấn dinh dưỡng được phân công",
      "references": [
        {
          "title": "WHO recommendations on antenatal care for a positive pregnancy experience (2016)",
          "org": "WHO"
        }
      ],
      "disclaimer": "Thông tin danh mục phục vụ mô phỏng hệ thống Tâm An, chỉ mang tính tham khảo và cần được rà soát chuyên môn trước khi sử dụng thực tế. Không thay thế thăm khám, chẩn đoán hoặc điều trị. Phạm vi dịch vụ, chỉ định, chi phí và khả năng tiếp nhận phải được cơ sở xác nhận."
    },
    "MM_PREECLAMPSIA_SCREEN": {
      "schema_version": 1,
      "review": {
        "status": "DRAFT",
        "needs_medical_review": true
      },
      "intro": "Dịch vụ rà soát tiền sử sản khoa, bệnh nền và thông tin huyết áp, kết hợp các kiểm tra theo chỉ định phù hợp tuổi thai. Không tự gộp mọi dấu ấn xét nghiệm vào một quy trình cố định. Nếu có dấu hiệu nghiêm trọng, người bệnh cần được đánh giá khẩn thay vì đặt lịch sàng lọc thường quy.\n\nTiền sản giật là vấn đề liên quan thai kỳ cần được nhân viên y tế đánh giá, không thể kết luận chỉ bằng một triệu chứng hoặc một số đo huyết áp. Dịch vụ giúp bác sĩ tìm hiểu yếu tố nguy cơ, hồ sơ các lần mang thai trước và diễn biến hiện tại, từ đó tư vấn nhu cầu sàng lọc và kế hoạch theo dõi. Việc lựa chọn siêu âm Doppler, xét nghiệm hoặc phương pháp đánh giá khác phụ thuộc tuổi thai, mục tiêu và hướng dẫn chuyên môn; cơ sở cần xác nhận danh mục xét nghiệm thực tế. Sàng lọc nguy cơ ở thai phụ chưa có biểu hiện không đồng nhất với chẩn đoán hoặc đánh giá một người đang có triệu chứng. Người bệnh được giải thích khi nào cần tái khám, khi nào phải liên hệ y tế ngay và không tự bắt đầu thuốc dự phòng chỉ vì thuộc nhóm nguy cơ.",
      "key_facts": [
        {
          "icon": "calendar-days",
          "label": "Phạm vi",
          "value": "Đánh giá nguy cơ và huyết áp"
        },
        {
          "icon": "clipboard-check",
          "label": "Thời điểm",
          "value": "Bác sĩ xác định theo tuổi thai"
        },
        {
          "icon": "info",
          "label": "Kiểm tra",
          "value": "Theo mục đích và chỉ định"
        },
        {
          "icon": "file-text",
          "label": "Kết quả",
          "value": "Kế hoạch theo dõi và tư vấn"
        }
      ],
      "highlights": [
        {
          "icon": "stethoscope",
          "title": "Tiền sử có ý nghĩa",
          "desc": "Rà soát biến chứng và bệnh nền trước đây."
        },
        {
          "icon": "clipboard-check",
          "title": "Phân biệt mục tiêu",
          "desc": "Sàng lọc khác đánh giá triệu chứng hiện tại."
        },
        {
          "icon": "message-circle",
          "title": "Đối chiếu dữ liệu",
          "desc": "Kết hợp các thông tin thích hợp thay vì một chỉ số."
        },
        {
          "icon": "shield-check",
          "title": "An toàn",
          "desc": "Hướng dẫn nhận biết tình huống cần đánh giá khẩn."
        }
      ],
      "suitable_for": [
        "Thai phụ có tiền sử tăng huyết áp hoặc biến chứng sản khoa cần tư vấn",
        "Thai phụ được bác sĩ chỉ định đánh giá nguy cơ",
        "Thai phụ cần theo dõi huyết áp theo kế hoạch"
      ],
      "not_suitable_for": [
        "Đau đầu dữ dội, nhìn mờ hoặc dấu hiệu cấp cứu: cần đánh giá ngay, không đặt lịch thường",
        "Không tự dùng thuốc dự phòng dựa trên danh mục"
      ],
      "parameters": [
        {
          "name": "Huyết áp",
          "desc": "Đánh giá trong bối cảnh thai kỳ",
          "reference": "Theo đánh giá và quy trình của cơ sở"
        },
        {
          "name": "Yếu tố nguy cơ",
          "desc": "Tiền sử, bệnh nền và thông tin liên quan",
          "reference": "Theo đánh giá và quy trình của cơ sở"
        },
        {
          "name": "Kiểm tra chuyên sâu",
          "desc": "Theo chỉ định và mục tiêu đánh giá",
          "reference": "Theo đánh giá và quy trình của cơ sở"
        }
      ],
      "process_steps": [
        {
          "title": "Tiếp nhận",
          "desc": "Xem tiền sử và mục tiêu đánh giá.",
          "duration_minutes": null
        },
        {
          "title": "Đánh giá",
          "desc": "Đo huyết áp và rà soát thông tin phù hợp.",
          "duration_minutes": null
        },
        {
          "title": "Kiểm tra bổ sung",
          "desc": "Bác sĩ xác định xét nghiệm hoặc khảo sát cần thiết nếu có.",
          "duration_minutes": null
        },
        {
          "title": "Tư vấn",
          "desc": "Thống nhất kế hoạch theo dõi, tái khám và dấu hiệu nguy hiểm.",
          "duration_minutes": null
        }
      ],
      "preparation": [
        "Mang sổ khám thai, kết quả trước và nhật ký huyết áp nếu có",
        "Ghi danh sách thuốc đang dùng",
        "Báo triệu chứng hiện tại để được phân luồng đúng"
      ],
      "aftercare": [
        "Thực hiện theo dõi theo kế hoạch bác sĩ",
        "Không tự điều chỉnh thuốc",
        "Đi khám ngay nếu có dấu hiệu nguy hiểm"
      ],
      "warning_signs": [
        "Đau đầu dữ dội, nhìn mờ, khó thở hoặc đau vùng thượng vị dữ dội: cần đến cơ sở y tế ngay.",
        "Ra máu nhiều, đau bụng dữ dội, khó thở hoặc ngất: cần hỗ trợ y tế ngay, không chờ lịch khám thường."
      ],
      "accuracy_note": "Không dùng kết quả sàng lọc như chẩn đoán xác định. Không cam kết một bộ xét nghiệm hay thuốc dự phòng cụ thể khi chưa được chỉ định.",
      "faqs": [
        {
          "q": "Sàng lọc có chẩn đoán chắc chắn tiền sản giật không?",
          "a": "Không. Đánh giá lâm sàng và kiểm tra phù hợp mới là căn cứ."
        },
        {
          "q": "Tôi đau đầu dữ dội kèm nhìn mờ có chờ lịch được không?",
          "a": "Không nên chờ lịch thường; cần đánh giá y tế khẩn."
        },
        {
          "q": "Có tự uống thuốc dự phòng không?",
          "a": "Không. Bác sĩ cần đánh giá chỉ định và nguy cơ riêng."
        }
      ],
      "performed_by": "Bác sĩ phụ trách bệnh lý thai kỳ và nhân viên xét nghiệm khi có chỉ định",
      "references": [
        {
          "title": "Preeclampsia and High Blood Pressure During Pregnancy",
          "org": "ACOG"
        },
        {
          "title": "WHO recommendations on antenatal care for a positive pregnancy experience (2016)",
          "org": "WHO"
        }
      ],
      "disclaimer": "Thông tin danh mục phục vụ mô phỏng hệ thống Tâm An, chỉ mang tính tham khảo và cần được rà soát chuyên môn trước khi sử dụng thực tế. Không thay thế thăm khám, chẩn đoán hoặc điều trị. Phạm vi dịch vụ, chỉ định, chi phí và khả năng tiếp nhận phải được cơ sở xác nhận."
    }
  };
  const rawServiceContent = SERVICE_CONTENT;
  const serviceContentMap = {};
  for (const [key, val] of Object.entries(rawServiceContent)) {
    if (val.schema_version !== 1) {
      throw new Error(
        `[Seed Error] Service ${key} has invalid schema_version: expected 1, got ${val.schema_version}`,
      );
    }
    if (typeof val.intro !== 'string' || !val.intro.trim()) {
      throw new Error(
        `[Seed Error] Service ${key} missing or invalid intro string`,
      );
    }
    if (typeof val.disclaimer !== 'string' || !val.disclaimer.trim()) {
      throw new Error(
        `[Seed Error] Service ${key} missing or invalid disclaimer string`,
      );
    }
    const mappedKey =
      key === 'MM_PREECLAMPSIA_SCREENING' ? 'MM_PREECLAMPSIA_SCREEN' : key;
    serviceContentMap[mappedKey] = val;
  }

  // Danh mục 20 dịch vụ y tế mô phỏng
  const servicesDef = [
    {
      "code": "PRENATAL_ROUTINE",
      "slug": "kham-thai-dinh-ky-chuan-y-khoa",
      "name": "Khám thai định kỳ",
      "summary": "Theo dõi sức khỏe mẹ và sự phát triển của thai qua các lần khám theo kế hoạch.",
      "description": "Buổi khám tập trung rà soát diễn biến thai kỳ, sinh hiệu, kết quả đã có và các vấn đề người mẹ quan tâm. Bác sĩ đánh giá thông tin theo tuổi thai, giải thích những mốc cần theo dõi và trao đổi kế hoạch tái khám. Siêu âm, xét nghiệm hoặc dịch vụ chuyên sâu được lựa chọn riêng khi có chỉ định.",
      "kind": "CONSULTATION",
      "specialtyCode": "OBSTETRICS",
      "thumbnailUrl": "https://res.cloudinary.com/dpxzyc9wu/image/upload/v1795840436/tam-an/catalog-v2/services/prenatal-routine-87013f6bb00d6e36.webp",
      "duration": null,
      "policy": "RANK_UPGRADE_ALLOWED",
      "price": 300000,
      "tagCodes": [
        "ROUTINE",
        "POPULAR",
        "TRIMESTER_1",
        "TRIMESTER_2",
        "TRIMESTER_3"
      ]
    },
    {
      "code": "PRENATAL_VIP",
      "slug": "kham-thai-chuyen-gia-tu-van-dinh-duong",
      "name": "Khám thai chuyên gia",
      "summary": "Khám chuyên sâu để rà soát tiền sử, kết quả và kế hoạch quản lý thai kỳ.",
      "description": "Dịch vụ dành cho thai phụ muốn trao đổi kỹ với bác sĩ về tiền sử sản khoa, bệnh nền hoặc các kết quả cần đánh giá thêm. Bác sĩ tổng hợp hồ sơ và tư vấn lộ trình theo dõi; hạng bác sĩ thực tế phụ thuộc lựa chọn và lịch trống. Không bao gồm mặc định các xét nghiệm chuyên sâu.",
      "kind": "CONSULTATION",
      "specialtyCode": "OBSTETRICS",
      "thumbnailUrl": "https://res.cloudinary.com/dpxzyc9wu/image/upload/v1795840437/tam-an/catalog-v2/services/prenatal-vip-9daf7a85a2993026.webp",
      "duration": null,
      "policy": "RANK_UPGRADE_ALLOWED",
      "price": 500000,
      "tagCodes": [
        "HIGH_RISK",
        "POPULAR"
      ]
    },
    {
      "code": "US_2D",
      "slug": "sieu-am-thai-2d-tieu-chuan",
      "name": "Siêu âm thai 2D",
      "summary": "Siêu âm cơ bản hỗ trợ xác định thông tin thai và theo dõi sự phát triển theo tuổi thai.",
      "description": "Siêu âm sử dụng hình ảnh hai chiều để bác sĩ khảo sát các thông tin cần thiết phù hợp giai đoạn mang thai. Có thể hỗ trợ đánh giá vị trí, tuổi thai, hoạt động tim thai, kích thước, nhau thai hoặc nước ối theo chỉ định. Không thay thế siêu âm hình thái chuyên sâu.",
      "kind": "DIAGNOSTIC",
      "specialtyCode": "PERINATOLOGY",
      "thumbnailUrl": "https://res.cloudinary.com/dpxzyc9wu/image/upload/v1795840438/tam-an/catalog-v2/services/us-2d-0948da29b00846b1.webp",
      "duration": null,
      "policy": "NOT_REQUIRED",
      "price": 200000,
      "tagCodes": [
        "ROUTINE",
        "TRIMESTER_1",
        "TRIMESTER_2",
        "TRIMESTER_3"
      ]
    },
    {
      "code": "US_4D_5D",
      "slug": "sieu-am-hinh-thai-thai-nhi-4d-5d-hd-live",
      "name": "Siêu âm hình thái thai nhi 4D/5D",
      "summary": "Khảo sát cấu trúc thai nhi theo mốc được chỉ định; hình ảnh 3D/4D/5D có thể hỗ trợ minh họa.",
      "description": "Dịch vụ tập trung khảo sát giải phẫu thai nhi, đánh giá các cấu trúc cần quan sát, nhau thai và nước ối. Khảo sát hình thái chuẩn dựa trên kỹ thuật siêu âm phù hợp; hình ảnh 4D/5D không thay thế việc đánh giá chuyên môn hoặc bảo đảm phát hiện tất cả dị tật.",
      "kind": "DIAGNOSTIC",
      "specialtyCode": "PERINATOLOGY",
      "thumbnailUrl": "https://res.cloudinary.com/dpxzyc9wu/image/upload/v1795840439/tam-an/catalog-v2/services/us-4d-5d-9bbc45e557237369.webp",
      "duration": null,
      "policy": "NOT_REQUIRED",
      "price": 450000,
      "tagCodes": [
        "TRIMESTER_2",
        "POPULAR"
      ]
    },
    {
      "code": "NIPT_BASIC",
      "slug": "sang-loc-di-tat-truoc-sinh-nipt-basic",
      "name": "Xét nghiệm NIPT sàng lọc 3 lệch bội thường gặp",
      "summary": "Sàng lọc nguy cơ trisomy 21, 18 và 13 từ ADN tự do trong máu mẹ.",
      "description": "NIPT phân tích ADN tự do có nguồn gốc chủ yếu từ nhau thai lưu hành trong máu mẹ, nhằm đánh giá nguy cơ các lệch bội nhiễm sắc thể trong phạm vi xét nghiệm. Đây là xét nghiệm sàng lọc, không phải chẩn đoán xác định. Bác sĩ tư vấn thời điểm, phạm vi và cách diễn giải kết quả.",
      "kind": "DIAGNOSTIC",
      "specialtyCode": "PERINATOLOGY",
      "thumbnailUrl": "https://res.cloudinary.com/dpxzyc9wu/image/upload/v1795840440/tam-an/catalog-v2/services/nipt-basic-d024d74bcc6134f2.webp",
      "duration": null,
      "policy": "NOT_REQUIRED",
      "price": 2500000,
      "tagCodes": [
        "TRIMESTER_1",
        "POPULAR"
      ]
    },
    {
      "code": "PRENATAL_FIRST",
      "slug": "kham-thai-lan-dau",
      "name": "Khám thai lần đầu",
      "summary": "Khởi tạo hồ sơ thai kỳ, đánh giá sức khỏe ban đầu và lập kế hoạch theo dõi.",
      "description": "Buổi khám dành cho người mới biết hoặc nghi ngờ mang thai và cần được đánh giá ban đầu. Bác sĩ khai thác tiền sử, xem xét thông tin xác định tuổi thai, tư vấn các bước theo dõi và lựa chọn kiểm tra khi phù hợp. Không mặc định bao gồm siêu âm hoặc xét nghiệm.",
      "kind": "CONSULTATION",
      "specialtyCode": "OBSTETRICS",
      "thumbnailUrl": "https://res.cloudinary.com/dpxzyc9wu/image/upload/v1795840442/tam-an/catalog-v2/services/prenatal-first-9f216e75edfe10cd.webp",
      "duration": null,
      "policy": "RANK_UPGRADE_ALLOWED",
      "price": 300000,
      "tagCodes": [
        "ROUTINE",
        "TRIMESTER_1"
      ]
    },
    {
      "code": "DOUBLE_TEST",
      "slug": "xet-nghiem-double-test-sang-loc-quy-1",
      "name": "Xét nghiệm Double Test quý 1",
      "summary": "Sàng lọc sinh hóa quý một bằng PAPP-A và free β-hCG, kết hợp thông tin lâm sàng và siêu âm khi phù hợp.",
      "description": "Double Test đánh giá nguy cơ một số bất thường nhiễm sắc thể ở giai đoạn đầu thai kỳ. Bác sĩ xác nhận tuổi thai, xem các phép đo siêu âm và các dữ liệu cần thiết để lựa chọn quy trình sàng lọc. Kết quả chỉ là ước lượng nguy cơ, không kết luận thai mắc bệnh.",
      "kind": "DIAGNOSTIC",
      "specialtyCode": "PERINATOLOGY",
      "thumbnailUrl": "https://res.cloudinary.com/dpxzyc9wu/image/upload/v1795840443/tam-an/catalog-v2/services/double-test-bac2eeca681b6ceb.webp",
      "duration": null,
      "policy": "NOT_REQUIRED",
      "price": 450000,
      "tagCodes": [
        "TRIMESTER_1",
        "ROUTINE"
      ]
    },
    {
      "code": "TRIPLE_TEST",
      "slug": "xet-nghiem-triple-test-sang-loc-quy-2",
      "name": "Xét nghiệm Triple Test quý 2",
      "summary": "Sàng lọc sinh hóa quý hai bằng AFP, hCG và uE3 để đánh giá một số nguy cơ theo phạm vi xét nghiệm.",
      "description": "Triple Test sử dụng ba dấu ấn sinh hóa trong máu mẹ ở quý hai. Bác sĩ đối chiếu tuổi thai và kết quả trước đó để đánh giá sự phù hợp, tư vấn ý nghĩa của nguy cơ bất thường nhiễm sắc thể và khuyết tật ống thần kinh theo quy trình xét nghiệm. Không thay thế xét nghiệm chẩn đoán.",
      "kind": "DIAGNOSTIC",
      "specialtyCode": "PERINATOLOGY",
      "thumbnailUrl": "https://res.cloudinary.com/dpxzyc9wu/image/upload/v1795840445/tam-an/catalog-v2/services/triple-test-97ca6b4fb678d561.webp",
      "duration": null,
      "policy": "NOT_REQUIRED",
      "price": 500000,
      "tagCodes": [
        "TRIMESTER_2"
      ]
    },
    {
      "code": "OGTT_DIABETES",
      "slug": "nghiem-phap-dung-nap-glucose-tam-soat-tieu-duong",
      "name": "Nghiệm pháp dung nạp glucose (OGTT) thai kỳ",
      "summary": "Xét nghiệm khả năng dung nạp glucose để đánh giá đái tháo đường thai kỳ theo chỉ định.",
      "description": "OGTT là nghiệm pháp uống dung dịch glucose và lấy mẫu máu theo các mốc quy định của quy trình xét nghiệm. Mốc thường gặp trong chăm sóc thai kỳ là 24–28 tuần; một số người cần đánh giá sớm hơn theo chỉ định. Bác sĩ xác nhận yêu cầu nhịn ăn, thời điểm và điều kiện thực hiện.",
      "kind": "DIAGNOSTIC",
      "specialtyCode": "MATERNAL_MEDICINE",
      "thumbnailUrl": "https://res.cloudinary.com/dpxzyc9wu/image/upload/v1795840446/tam-an/catalog-v2/services/ogtt-diabetes-39f64b0974ec2424.webp",
      "duration": null,
      "policy": "NOT_REQUIRED",
      "price": 350000,
      "tagCodes": [
        "TRIMESTER_2",
        "TRIMESTER_3",
        "ROUTINE"
      ]
    },
    {
      "code": "GYN_STANDARD",
      "slug": "kham-phu-khoa-tong-quat-soi-co-tu-cung",
      "name": "Khám phụ khoa tổng quát & soi cổ tử cung",
      "summary": "Đánh giá sức khỏe phụ khoa, triệu chứng và nhu cầu khám định kỳ; soi cổ tử cung khi có chỉ định.",
      "description": "Dịch vụ tập trung khai thác tiền sử, đánh giá tình trạng sức khỏe phụ khoa và tư vấn bước thăm khám phù hợp. Khi cần, bác sĩ có thể chỉ định soi cổ tử cung hoặc các kỹ thuật bổ sung với sự đồng ý của người bệnh. Không đồng nhất với gói lấy mẫu tế bào học và HPV.",
      "kind": "CONSULTATION",
      "specialtyCode": "GYNECOLOGY",
      "thumbnailUrl": "https://res.cloudinary.com/dpxzyc9wu/image/upload/v1795840447/tam-an/catalog-v2/services/gyn-standard-19c94b5e97486ffe.webp",
      "duration": null,
      "policy": "RANK_UPGRADE_ALLOWED",
      "price": 350000,
      "tagCodes": [
        "ROUTINE"
      ]
    },
    {
      "code": "PACKAGE_BIRTH_STANDARD",
      "slug": "goi-sinh-con-thuong-tron-goi-hanh-phuc",
      "name": "Gói sinh thường Hạnh Phúc",
      "summary": "Tư vấn và đăng ký nhu cầu sinh qua đường âm đạo, theo dõi chuyển dạ và chăm sóc sau sinh.",
      "description": "Gói dành cho gia đình tìm hiểu kế hoạch sinh thường. Bác sĩ đánh giá điều kiện sản khoa, trao đổi phương án theo dõi, hỗ trợ giảm đau khi phù hợp và chăm sóc sau sinh. Danh mục và chi phí gói phải được bộ phận dịch vụ xác nhận; đăng ký không bảo đảm phương thức sinh cuối cùng.",
      "kind": "PACKAGE",
      "specialtyCode": "OBSTETRICS",
      "thumbnailUrl": "https://res.cloudinary.com/dpxzyc9wu/image/upload/v1795840449/tam-an/catalog-v2/services/package-birth-standard-af70611d7008e1ac.webp",
      "duration": null,
      "policy": "NOT_REQUIRED",
      "price": 18000000,
      "tagCodes": [
        "POPULAR"
      ]
    },
    {
      "code": "PACKAGE_BIRTH_SURGERY",
      "slug": "goi-sinh-mo-chu-dong-tron-goi-binh-an",
      "name": "Gói sinh mổ Bình An",
      "summary": "Tư vấn nhu cầu sinh mổ, đánh giá chỉ định và kế hoạch chăm sóc mẹ sau phẫu thuật.",
      "description": "Gói mô tả quy trình dự kiến khi bác sĩ xác định sinh mổ là lựa chọn phù hợp, gồm đánh giá trước phẫu thuật, phối hợp gây mê hồi sức và chăm sóc sau mổ. Thời điểm, phương thức sinh và phạm vi chi phí cần được xác nhận bởi nhân viên chuyên môn và bộ phận dịch vụ.",
      "kind": "PACKAGE",
      "specialtyCode": "OBSTETRICS",
      "thumbnailUrl": "https://res.cloudinary.com/dpxzyc9wu/image/upload/v1795840450/tam-an/catalog-v2/services/package-birth-surgery-3368f2aefa1f4869.webp",
      "duration": null,
      "policy": "NOT_REQUIRED",
      "price": 28000000,
      "tagCodes": [
        "POPULAR"
      ]
    },
    {
      "code": "POSTPARTUM_NEWBORN_CARE",
      "slug": "cham-soc-tre-so-sinh-huong-dan-thuc-hanh",
      "name": "Chăm sóc trẻ sơ sinh & hướng dẫn thực hành",
      "summary": "Hướng dẫn người mẹ và gia đình thực hành kỹ năng chăm sóc trẻ sơ sinh hằng ngày.",
      "description": "Dịch vụ hướng dẫn thực hành chăm sóc trẻ trong thời kỳ sau sinh, tập trung vào các kỹ năng thường ngày và nhận biết dấu hiệu cần đi khám. Buổi hẹn đăng ký theo hồ sơ người mẹ/người chăm sóc; không thay thế khám nhi khoa, tiêm chủng hoặc điều trị cho trẻ.",
      "kind": "PROCEDURE",
      "specialtyCode": "POSTPARTUM_CARE",
      "thumbnailUrl": "https://res.cloudinary.com/dpxzyc9wu/image/upload/v1795840452/tam-an/catalog-v2/services/postpartum-newborn-care-5ed14bdf5aa80f0b.webp",
      "duration": null,
      "policy": "BASIC_INCLUDED",
      "price": 250000,
      "tagCodes": [
        "ROUTINE",
        "FEMALE_CARE"
      ],
      "status": "ACTIVE"
    },
    {
      "code": "VAC_TETANUS",
      "slug": "tiem-phong-uon-van-thai-ky-vat",
      "name": "Tiêm phòng uốn ván thai kỳ",
      "summary": "Khám sàng lọc và tư vấn tiêm vắc xin có thành phần uốn ván dựa trên tiền sử tiêm chủng.",
      "description": "Dịch vụ tiếp nhận thai phụ cần rà soát lịch tiêm phòng uốn ván. Nhân viên y tế kiểm tra tiền sử, tình trạng hiện tại và lựa chọn vắc xin, thời điểm tiêm hoặc hẹn lại theo hướng dẫn chuyên môn. Không áp dụng cùng một số mũi cho tất cả thai phụ.",
      "kind": "VACCINATION",
      "specialtyCode": "OBSTETRICS",
      "thumbnailUrl": "https://res.cloudinary.com/dpxzyc9wu/image/upload/v1795840453/tam-an/catalog-v2/services/vac-tetanus-8e99aacce07b31f5.webp",
      "duration": null,
      "policy": "NOT_REQUIRED",
      "price": 150000,
      "tagCodes": [
        "ROUTINE"
      ],
      "status": "ACTIVE"
    },
    {
      "code": "MATERNAL_NUTRITION",
      "slug": "tu-van-dinh-duong-thai-ky",
      "name": "Tư vấn dinh dưỡng thai kỳ",
      "summary": "Đánh giá thói quen ăn uống, tăng cân và nhu cầu dinh dưỡng trong từng giai đoạn mang thai.",
      "description": "Buổi tư vấn tập trung vào dinh dưỡng, cách tổ chức bữa ăn, khả năng dung nạp và các khó khăn khi ăn uống. Nhân viên chuyên môn xem xét thể trạng, tuần thai và thông tin bệnh lý để trao đổi kế hoạch phù hợp; không tự kê đơn vi chất hoặc áp dụng chế độ ăn chung cho mọi người.",
      "kind": "OTHER",
      "specialtyCode": "MATERNAL_MEDICINE",
      "thumbnailUrl": "https://res.cloudinary.com/dpxzyc9wu/image/upload/v1795840454/tam-an/catalog-v2/services/maternal-nutrition-f2627c76b8c3937e.webp",
      "duration": null,
      "policy": "RANK_UPGRADE_ALLOWED",
      "price": 300000,
      "tagCodes": [
        "ROUTINE",
        "HIGH_RISK"
      ],
      "status": "ACTIVE"
    },
    {
      "code": "GYN_THINPREP_HPV",
      "slug": "tam-soat-ung-thu-co-tu-cung-thinprep-hpv",
      "name": "Tầm soát ung thư cổ tử cung (ThinPrep & HPV)",
      "summary": "Lấy mẫu tế bào cổ tử cung và xét nghiệm HPV nguy cơ cao theo phương án tầm soát được tư vấn.",
      "description": "Dịch vụ dành cho người có nhu cầu đánh giá nguy cơ tổn thương tiền ung thư cổ tử cung. Xét nghiệm tế bào học nhúng dịch và xét nghiệm HPV cung cấp các thông tin khác nhau. Bác sĩ lựa chọn phương án phù hợp dựa trên tuổi, tiền sử, kết quả trước và tình trạng hiện tại.",
      "kind": "DIAGNOSTIC",
      "specialtyCode": "GYNECOLOGY",
      "thumbnailUrl": "https://res.cloudinary.com/dpxzyc9wu/image/upload/v1795840456/tam-an/catalog-v2/services/gyn-thinprep-hpv-563f37f64356bbfa.webp",
      "duration": null,
      "policy": "NOT_REQUIRED",
      "price": 850000,
      "tagCodes": [
        "POPULAR"
      ]
    },
    {
      "code": "GYN_TRANSVAGINAL_US",
      "slug": "sieu-am-dau-do-am-dao-tu-cung-buong-trung",
      "name": "Siêu âm tử cung và buồng trứng (đầu dò âm đạo)",
      "summary": "Khảo sát cấu trúc vùng chậu, tử cung, nội mạc và buồng trứng bằng siêu âm theo chỉ định.",
      "description": "Siêu âm vùng chậu bằng đầu dò âm đạo hỗ trợ quan sát các cấu trúc cần đánh giá. Bác sĩ trao đổi về mục đích, kỹ thuật, sự đồng ý và lựa chọn phương pháp khác khi không phù hợp. Kết quả được xem xét cùng triệu chứng và tiền sử.",
      "kind": "DIAGNOSTIC",
      "specialtyCode": "GYNECOLOGY",
      "thumbnailUrl": "https://res.cloudinary.com/dpxzyc9wu/image/upload/v1795840457/tam-an/catalog-v2/services/gyn-transvaginal-us-d036242988ac9064.webp",
      "duration": null,
      "policy": "NOT_REQUIRED",
      "price": 350000,
      "tagCodes": [
        "ROUTINE"
      ]
    },
    {
      "code": "POSTPARTUM_MATERNAL_CHECK",
      "slug": "kham-suc-khoe-me-sau-sinh",
      "name": "Khám sức khỏe mẹ sau sinh",
      "summary": "Đánh giá quá trình hồi phục thể chất, sức khỏe tinh thần và nhu cầu chăm sóc của người mẹ sau sinh.",
      "description": "Buổi khám rà soát hồ sơ sinh và ra viện, trao đổi tình trạng hồi phục, đau, vết khâu hoặc vết mổ, sinh hoạt, sức khỏe tinh thần và các vấn đề liên quan. Bác sĩ lựa chọn thăm khám phù hợp và hướng dẫn tái khám hoặc chuyển chuyên khoa nếu cần.",
      "kind": "CONSULTATION",
      "specialtyCode": "POSTPARTUM_CARE",
      "thumbnailUrl": "https://res.cloudinary.com/dpxzyc9wu/image/upload/v1795840458/tam-an/catalog-v2/services/postpartum-maternal-check-29e8b0e5721d4829.webp",
      "duration": null,
      "policy": "RANK_UPGRADE_ALLOWED",
      "price": 300000,
      "tagCodes": [
        "ROUTINE",
        "FEMALE_CARE"
      ]
    },
    {
      "code": "POSTPARTUM_LACTATION",
      "slug": "tu-van-nuoi-con-bang-sua-me",
      "name": "Tư vấn nuôi con bằng sữa mẹ",
      "summary": "Hỗ trợ người mẹ hiểu việc cho bú, tư thế và những khó khăn trong giai đoạn nuôi con bằng sữa mẹ.",
      "description": "Buổi tư vấn tìm hiểu tình trạng cho bú, những khó chịu của mẹ và các vấn đề quan sát được khi chăm sóc bé. Nhân viên chuyên môn hướng dẫn kỹ năng phù hợp, giải thích nhu cầu theo dõi và chuyển đánh giá y tế nếu có dấu hiệu bất thường.",
      "kind": "CONSULTATION",
      "specialtyCode": "POSTPARTUM_CARE",
      "thumbnailUrl": "https://res.cloudinary.com/dpxzyc9wu/image/upload/v1795840460/tam-an/catalog-v2/services/postpartum-lactation-f372797acb463cb4.webp",
      "duration": null,
      "policy": "RANK_UPGRADE_ALLOWED",
      "price": 250000,
      "tagCodes": [
        "ROUTINE",
        "FEMALE_CARE"
      ]
    },
    {
      "code": "MM_PREECLAMPSIA_SCREEN",
      "slug": "sang-loc-quan-ly-tien-san-giat-som",
      "name": "Sàng lọc nguy cơ tiền sản giật & theo dõi huyết áp",
      "summary": "Đánh giá yếu tố nguy cơ tiền sản giật, huyết áp và nhu cầu kiểm tra chuyên sâu trong thai kỳ.",
      "description": "Dịch vụ rà soát tiền sử sản khoa, bệnh nền và thông tin huyết áp, kết hợp các kiểm tra theo chỉ định phù hợp tuổi thai. Không tự gộp mọi dấu ấn xét nghiệm vào một quy trình cố định. Nếu có dấu hiệu nghiêm trọng, người bệnh cần được đánh giá khẩn thay vì đặt lịch sàng lọc thường quy.",
      "kind": "DIAGNOSTIC",
      "specialtyCode": "MATERNAL_MEDICINE",
      "thumbnailUrl": "https://res.cloudinary.com/dpxzyc9wu/image/upload/v1795840461/tam-an/catalog-v2/services/mm-preeclampsia-screen-076b13d78bf46dc4.webp",
      "duration": null,
      "policy": "RANK_UPGRADE_ALLOWED",
      "price": 1200000,
      "tagCodes": [
        "HIGH_RISK",
        "POPULAR"
      ]
    }
  ];

  const reviewOnlyServices = new Set([
    'PRENATAL_FIRST', 'MATERNAL_NUTRITION', 'POSTPARTUM_MATERNAL_CHECK',
    'POSTPARTUM_LACTATION', 'POSTPARTUM_NEWBORN_CARE', 'MM_PREECLAMPSIA_SCREEN',
  ]);
  const serviceMap = {};
  for (const s of servicesDef) {
    const specialtyId = specialtyMap[s.specialtyCode] || null;
    const svcStatus = s.status || 'ACTIVE';
    const bookingEnabled =
      !reviewOnlyServices.has(s.code) && (s.bookingEnabled ?? true);
    const publishedAt = svcStatus === 'DRAFT' ? null : now;
    const content = serviceContentMap[s.code] || null;
    const contentJson = content ? JSON.stringify(content) : null;

    // Idempotent: Kiểm tra xem dịch vụ đã tồn tại trong DB chưa
    const existing = await clients.catalog.query(
      `SELECT id FROM medical_services WHERE code = $1`,
      [s.code],
    );
    let serviceId;
    let priceId;

    if (existing.rows.length > 0) {
      serviceId = existing.rows[0].id;
      // Với dịch vụ đã tồn tại, chỉ cập nhật content và updated_at, không ghi đè các trường khác
      await clients.catalog.query(
        `UPDATE medical_services SET content = $1, duration_minutes = $2, updated_at = NOW() WHERE id = $3`,
        [contentJson, s.duration, serviceId],
      );
      const bp = await clients.catalog.query(
        `SELECT id FROM base_prices WHERE medical_service_id = $1 AND status = 'ACTIVE' LIMIT 1`,
        [serviceId],
      );
      priceId = bp.rows.length > 0 ? bp.rows[0].id : null;
    } else {
      const sRes = await clients.catalog.query(
        `INSERT INTO medical_services (id, code, slug, name, summary, description, kind, specialty_id, thumbnail_url, duration_minutes, booking_enabled, doctor_rank_selection_policy, content, status, version, published_at, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 1, $14, NOW(), NOW()) RETURNING id`,
        [
          s.code,
          s.slug,
          s.name,
          s.summary,
          s.description,
          s.kind,
          specialtyId,
          s.thumbnailUrl,
          s.duration,
          bookingEnabled,
          s.policy,
          contentJson,
          svcStatus,
          publishedAt,
        ],
      );
      serviceId = sRes.rows[0].id;

      // Giá cơ bản (BasePrice)
      const bpRes = await clients.catalog.query(
        `INSERT INTO base_prices (id, medical_service_id, amount_minor, currency, effective_from, status, version, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'VND', NOW(), 'ACTIVE', 1, NOW(), NOW()) RETURNING id`,
        [serviceId, s.price],
      );
      priceId = bpRes.rows[0].id;

      // Gắn thẻ (tags)
      for (const tagCode of s.tagCodes) {
        if (tagMap[tagCode]) {
          await clients.catalog.query(
            `INSERT INTO medical_service_tags (medical_service_id, tag_id, created_at)
             VALUES ($1, $2, NOW())`,
            [serviceId, tagMap[tagCode]],
          );
        }
      }
    }

    serviceMap[s.code] = {
      id: serviceId,
      priceId,
      price: s.price,
      name: s.name,
      specialtyId,
    };
  }

  // Kiểm tra & log sau seed
  const assignedCountRes = await clients.catalog.query(
    `SELECT COUNT(*)::int as count FROM medical_services WHERE content IS NOT NULL`,
  );
  const assignedCount = assignedCountRes.rows[0].count;

  const dbServicesRes = await clients.catalog.query(
    `SELECT code FROM medical_services`,
  );
  const dbCodes = new Set(dbServicesRes.rows.map((r) => r.code));

  const jsonCodes = Object.keys(rawServiceContent);
  const unmappedInDb = jsonCodes.filter((code) => {
    const mapped =
      code === 'MM_PREECLAMPSIA_SCREENING' ? 'MM_PREECLAMPSIA_SCREEN' : code;
    return !dbCodes.has(mapped);
  });

  const nullContentRes = await clients.catalog.query(
    `SELECT code FROM medical_services WHERE content IS NULL`,
  );
  const nullContentCodes = nullContentRes.rows.map((r) => r.code);

  console.log(`\n📊 [Catalog Seed Summary]`);
  console.log(
    `   - Số dịch vụ đã gán content: ${assignedCount}/${dbCodes.size}`,
  );
  console.log(
    `   - Danh sách code trong JSON không tìm thấy trong DB:`,
    unmappedInDb,
  );
  console.log(
    `   - Danh sách dịch vụ trong DB còn content = null:`,
    nullContentCodes,
  );

  console.log(
    '✅ Đã khởi tạo 20 Dịch vụ Y tế chuẩn kèm nội dung lâm sàng, Phân loại, Thẻ tag và Bảng giá hiện hành (ACTIVE).',
  );

  // ============================================================================
  // 4. KHU VỰC & CÁC BƯỚC ĐIỀU PHỐI HÀNG ĐỢI (QUEUE STAGES)
  // ============================================================================
  console.log(
    '\n--- BƯỚC 4: KHỞI TẠO CÁC CHẶNG HÀNG ĐỢI PHÒNG KHÁM (QUEUE STAGES) ---',
  );
  const queueStagesDef = [
    { code: 'RECEPTION', name: 'Tiếp đón & Đăng ký khám', roomCode: null },
    { code: 'VITALS', name: 'Đo sinh hiệu & Tiền sàng lọc', roomCode: null },
    {
      code: 'CONSULTATION',
      name: 'Phòng khám Bác sĩ Chuyên khoa',
      roomCode: 'P.201',
    },
    { code: 'ULTRASOUND', name: 'Phòng Siêu âm Chẩn đoán', roomCode: null },
    { code: 'LAB_SAMPLE', name: 'Phòng Lấy mẫu Xét nghiệm', roomCode: null },
    {
      code: 'PROCEDURE',
      name: 'Phòng Thủ thuật & Can thiệp Sản khoa',
      roomCode: null,
    },
    {
      code: 'IMMUNIZATION',
      name: 'Phòng Tiêm chủng Vắc xin Thai kỳ',
      roomCode: null,
    },
    { code: 'PHARMACY', name: 'Nhà thuốc & Cấp phát thuốc', roomCode: null },
  ];

  const stageMap = {};
  for (const st of queueStagesDef) {
    const res = await clients.queue.query(
      `INSERT INTO queue_stages (id, code, name, active, room_code, created_at)
       VALUES (gen_random_uuid(), $1, $2, true, $3, NOW()) RETURNING id`,
      [st.code, st.name, st.roomCode],
    );
    stageMap[st.code] = res.rows[0].id;
  }
  console.log(`✅ Đã khởi tạo 8 Khu vực hàng đợi (Queue Stages).`);

  // ============================================================================
  // 5. DANH MỤC THUỐC THAI KỲ & CẢNH BÁO AN TOÀN (MEDICATION CATALOG)
  // ============================================================================
  console.log(
    '\n--- BƯỚC 5: KHỞI TẠO DANH MỤC THUỐC AN TOÀN THAI KỲ (PRESCRIPTION) ---',
  );
  const medicationsDef = [
    {
      code: 'MED_FOLIC_400',
      name: 'Axit Folic 400mcg (Folio Forte)',
      ingredient: 'Acid Folic + Iodine + Vitamin D3',
      strength: '400 mcg',
      dosageForm: 'Viên nén',
      route: 'Uống',
      dose: '1 viên',
      freq: '1 lần/ngày',
      instruction:
        'Uống sau bữa ăn sáng với nhiều nước, duy trì suốt 3 tháng đầu thai kỳ.',
      category: 'CATEGORY_A',
      warning:
        'An toàn tuyệt đối cho thai phụ, phòng ngừa dị tật ống thần kinh thai nhi.',
    },
    {
      code: 'MED_IRON_FEMAT',
      name: 'Sắt hữu cơ Polymaltose (Femat)',
      ingredient: 'Sắt (III) Hydroxide Polymaltose Complex',
      strength: '50 mg',
      dosageForm: 'Viên nang mềm',
      route: 'Uống',
      dose: '1 viên',
      freq: '1 lần/ngày',
      instruction:
        'Uống trước bữa ăn 30 phút hoặc 2 giờ sau ăn, không uống cùng sữa hoặc canxi.',
      category: 'CATEGORY_A',
      warning:
        'Thuốc sắt hữu cơ ít gây táo bón, dùng phòng ngừa và điều trị thiếu máu thiếu sắt thai kỳ.',
    },
    {
      code: 'MED_CALCIUM_CORBIERE',
      name: 'Canxi Corbiere Sanofi 5ml',
      ingredient: 'Calcium glucoheptonate + Nicotinamide + Vitamin C',
      strength: '552.5 mg/5ml',
      dosageForm: 'Dung dịch uống ống bẻ',
      route: 'Uống',
      dose: '1 ống (5ml)',
      freq: '2 lần/ngày',
      instruction:
        'Bẻ ống uống trực tiếp sau ăn sáng và ăn trưa. Tránh uống vào buổi tối.',
      category: 'CATEGORY_A',
      warning:
        'Cung cấp canxi phát triển khung xương thai nhi và phòng loãng xương mẹ.',
    },
    {
      code: 'MED_DHA_PRENATAL',
      name: 'Bio Island DHA for Pregnancy 210mg',
      ingredient:
        'Docosahexaenoic Acid (DHA) tinh khiết từ vi tảo Schizochytrium',
      strength: '210 mg',
      dosageForm: 'Viên nang mềm',
      route: 'Uống',
      dose: '1 viên',
      freq: '1 lần/ngày',
      instruction: 'Uống ngay trong hoặc ngay sau bữa ăn có chất béo.',
      category: 'CATEGORY_A',
      warning:
        'Hỗ trợ phát triển não bộ và thị giác của thai nhi từ tuần thai thứ 12.',
    },
    {
      code: 'MED_PROGESTERONE_200',
      name: 'Utrogestan 200mg (Progesterone vi hạt)',
      ingredient: 'Progesterone tự nhiên dạng vi hạt',
      strength: '200 mg',
      dosageForm: 'Viên nang đặt âm đạo/uống',
      route: 'Đặt âm đạo sâu',
      dose: '1 viên',
      freq: '1-2 lần/ngày',
      instruction:
        'Đặt sâu vào âm đạo vào buổi tối trước khi đi ngủ, nằm nghỉ ít nhất 30 phút.',
      category: 'CATEGORY_B',
      warning:
        'Chỉ định trong dọa sảy thai, tiền sử sảy thai liên tiếp hoặc dọa sinh non.',
    },
    {
      code: 'MED_PARACETAMOL_500',
      name: 'Paracetamol 500mg Dược Hậu Giang',
      ingredient: 'Paracetamol',
      strength: '500 mg',
      dosageForm: 'Viên nén bao phim',
      route: 'Uống',
      dose: '1 viên',
      freq: 'Khi sốt >= 38.5°C, cách nhau 4-6 giờ',
      instruction:
        'Uống với nước đun sôi để nguội. Tối đa không quá 4 viên trong 24 giờ.',
      category: 'CATEGORY_B',
      warning:
        'Thuốc hạ sốt và giảm đau được lựa chọn hàng đầu cho phụ nữ có thai.',
    },
    {
      code: 'MED_MAGNE_B6',
      name: 'Magne-B6 Corbiere',
      ingredient: 'Magnesium lactate dihydrate + Pyridoxine hydrochloride (B6)',
      strength: '470mg / 5mg',
      dosageForm: 'Viên bao đường',
      route: 'Uống',
      dose: '1 viên',
      freq: '2 lần/ngày',
      instruction: 'Uống cùng bữa ăn với nhiều nước.',
      category: 'CATEGORY_B',
      warning:
        'Hỗ trợ giảm co cứng cơ bắp chân (chuột rút) và căng thẳng thần kinh thai kỳ.',
    },
    {
      code: 'MED_ASPIRIN_81',
      name: 'Aspirin pH8 81mg',
      ingredient: 'Acid Acetylsalicylic',
      strength: '81 mg',
      dosageForm: 'Viên bao tan trong ruột',
      route: 'Uống',
      dose: '1 viên',
      freq: '1 lần/ngày vào buổi tối',
      instruction:
        'Uống nguyên viên trước khi ngủ, duy trì từ tuần 12 đến tuần 36 theo chỉ định.',
      category: 'CATEGORY_B',
      warning:
        'Liều thấp dự phòng tiền sản giật ở thai phụ có yếu tố nguy cơ cao.',
    },
    // Thuốc CATEGORY_C: Thận trọng, cân nhắc kỹ lợi ích và nguy cơ
    {
      code: 'MED_CLOTRIMAZOLE_100',
      name: 'Canesten 100mg viên đặt phụ khoa',
      ingredient: 'Clotrimazole',
      strength: '100 mg',
      dosageForm: 'Viên nén đặt âm đạo',
      route: 'Đặt âm đạo sâu',
      dose: '1 viên',
      freq: '1 lần/ngày vào buổi tối',
      instruction:
        'Đặt sâu vào âm đạo liên tục 6 ngày trước khi đi ngủ. Không dùng dụng cụ thụt rửa.',
      category: 'CATEGORY_C',
      warning:
        'Điều trị viêm âm đạo do nấm Candida ở thai phụ 3 tháng giữa và 3 tháng cuối khi có chỉ định bác sĩ.',
    },
    {
      code: 'MED_DEXAMETHASONE_4',
      name: 'Dexamethasone 4mg/1ml Vinphaco',
      ingredient: 'Dexamethasone natri phosphat',
      strength: '4 mg/1ml',
      dosageForm: 'Dung dịch tiêm',
      route: 'Tiêm bắp',
      dose: '6 mg (1.5 ống)',
      freq: 'Mỗi 12 giờ x 4 liều',
      instruction:
        'Tiêm bắp sâu theo phác đồ cấp cứu kích thích trưởng thành phổi thai nhi.',
      category: 'CATEGORY_C',
      warning:
        'Áp dụng cho thai kỳ nguy cơ dọa sinh non từ tuần 24 đến 34 để kích thích sản xuất surfactant phổi bé.',
    },
    // Thuốc CATEGORY_D: Có bằng chứng nguy cơ đối với thai nhi ở người
    {
      code: 'MED_ENALAPRIL_5',
      name: 'Enalapril Stella 5mg (Hạ áp ức chế men chuyển)',
      ingredient: 'Enalapril maleat',
      strength: '5 mg',
      dosageForm: 'Viên nén',
      route: 'Uống',
      dose: '1 viên',
      freq: '1 lần/ngày',
      instruction:
        'Uống buổi sáng. Phải ngừng ngay lập tức và chuyển sang Methyldopa/Labetalol khi phát hiện có thai.',
      category: 'CATEGORY_D',
      warning:
        'CẢNH BÁO NGUY HIỂM: Gây thiểu ối, hạ huyết áp sơ sinh, suy thận vô niệu và biến dạng sọ thai nhi.',
    },
    // Thuốc CATEGORY_X: Chống chỉ định tuyệt đối trong thai kỳ (Quái thai)
    {
      code: 'MED_ISOTRETINOIN_10',
      name: 'Acnotin 10mg (Isotretinoin trị mụn nặng)',
      ingredient: 'Isotretinoin',
      strength: '10 mg',
      dosageForm: 'Viên nang mềm',
      route: 'Uống',
      dose: '1 viên',
      freq: '1 lần/ngày',
      instruction:
        'CHỐNG CHỈ ĐỊNH TUYỆT ĐỐI CHO PHỤ NỮ MANG THAI HOẶC CHUẨN BỊ MANG THAI.',
      category: 'CATEGORY_X',
      warning:
        'ĐỘC TÍNH CỰC CAO: Gây dị tật bẩm sinh nặng nề (não úng thủy, dị tật tim, sọ mặt). Bắt buộc ngừa thai 1 tháng trước và sau dùng thuốc.',
    },
  ];

  const medicationMap = {};
  for (const med of medicationsDef) {
    const isActive = med.isActive !== undefined ? med.isActive : true;
    const res = await clients.prescription.query(
      `INSERT INTO medication_catalog (id, code, name, active_ingredient, strength, dosage_form, route, default_dose, default_frequency, default_instruction, pregnancy_category, pregnancy_warning, is_active, version, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 1, NOW(), NOW()) RETURNING id`,
      [
        med.code,
        med.name,
        med.ingredient,
        med.strength,
        med.dosageForm,
        med.route,
        med.dose,
        med.freq,
        med.instruction,
        med.category,
        med.warning,
        isActive,
      ],
    );
    medicationMap[med.code] = { id: res.rows[0].id, ...med };
  }
  console.log(
    `✅ Đã khởi tạo 12 Thuốc chuẩn Thai kỳ (Phân loại an toàn thai kỳ FDA: A, B, C, D, X hiện hành).`,
  );

  // ============================================================================
  // 6. ĐỘI NGŨ BÁC SĨ & LỊCH LÀM VIỆC (DOCTORS & SCHEDULES)
  // ============================================================================
  console.log(
    '\n--- BƯỚC 6: KHỞI TẠO PHÒNG KHÁM (CLINIC ROOMS), ĐỘI NGŨ BÁC SĨ & LỊCH KHÁM ---',
  );
  const clinicRoomsDef = [
    {
      "code": "P.201",
      "name": "Phòng khám đa chuyên khoa 201",
      "status": "ACTIVE"
    },
    {
      "code": "P.202",
      "name": "Phòng khám đa chuyên khoa 202",
      "status": "ACTIVE"
    },
    {
      "code": "P.203",
      "name": "Phòng khám đa chuyên khoa 203",
      "status": "ACTIVE"
    },
    {
      "code": "P.207",
      "name": "Phòng khám đa chuyên khoa 207",
      "status": "ACTIVE"
    },
    {
      "code": "P.208",
      "name": "Phòng khám đa chuyên khoa 208",
      "status": "ACTIVE"
    }
  ];

  const roomMap = {};
  for (const rm of clinicRoomsDef) {
    const rmRes = await clients.doctor.query(
      `INSERT INTO clinic_rooms (id, code, name, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, NOW(), NOW()) RETURNING id, code, name, status`,
      [rm.code, rm.name, rm.status],
    );
    roomMap[rm.code] = rmRes.rows[0];
  }

  const doctorRoomShifts = [
    { roomCode: 'P.201', startTime: '07:30:00', endTime: '12:00:00' }, // 0: BS. Lê Thu Hà (Trưởng khoa Sản - P.201 Ca sáng)
    { roomCode: 'P.203', startTime: '07:30:00', endTime: '12:00:00' }, // 1: PGS. TS. BS. Nguyễn Quang Minh (CĐTS - P.203 Ca sáng)
    { roomCode: 'P.201', startTime: '12:30:00', endTime: '17:00:00' }, // 2: ThS. BS. Trần Thanh Mai (Sản Phụ khoa - P.201 Ca chiều)
    { roomCode: 'P.203', startTime: '12:30:00', endTime: '17:00:00' }, // 3: BS. CKI. Đặng Kim Oanh (Y học bào thai - P.203 Ca chiều)
    { roomCode: 'P.201', startTime: '17:30:00', endTime: '20:30:00' }, // 4: BS. CKII. Vũ Hoàng Long (Chăm sóc sau sinh - P.201 Ca tối)
    { roomCode: 'P.207', startTime: '07:30:00', endTime: '12:00:00' }, // 5: BS. CKI. Phạm Thùy Dương (Nội tiết thai kỳ - P.207 Ca sáng)
    { roomCode: 'P.207', startTime: '12:30:00', endTime: '17:00:00' }, // 6: BS. Nguyễn Hồng Nhung (Sản Phụ khoa - P.207 Ca chiều)
    { roomCode: 'P.207', startTime: '17:30:00', endTime: '20:30:00' }, // 7: TS. BS. Đoàn Văn Bắc (Chuyên gia Cố vấn - P.207 Ca tối)
    { roomCode: 'P.202', startTime: '07:30:00', endTime: '12:00:00' }, // 8: BS. Hoàng Minh Tuấn (BASIC - P.202 Ca sáng)
    { roomCode: 'P.208', startTime: '07:30:00', endTime: '12:00:00' }, // 9: BS. Trần Mai Anh (BASIC - P.208 Ca sáng)
    { roomCode: 'P.208', startTime: '12:30:00', endTime: '17:00:00' }, // 10: BS. Lê Văn Đức (BASIC - P.208 Ca chiều)
    { roomCode: 'P.202', startTime: '12:30:00', endTime: '17:00:00' }, // 11: BS. Bùi Thảo Linh (BASIC - P.202 Ca chiều)
  ];
  const doctorsDef = [
    {
      "email": "dr.lethuha@antam.local",
      "fullName": "BS. Lê Thu Hà",
      "phone": "0903112001",
      "license": "001234/BYT-CCHN",
      "rank": "HEAD_DOCTOR",
      "startYear": 2008,
      "specialtyCode": "OBSTETRICS",
      "photoUrl": "https://res.cloudinary.com/dpxzyc9wu/image/upload/v1795840462/tam-an/catalog-v2/doctors/01-1757685217c7ffb9.webp",
      "bio": "Phụ trách thăm khám sản khoa, rà soát hồ sơ quản lý thai nghén và tư vấn chuẩn bị sinh. Trong các buổi khám, bác sĩ chú trọng làm rõ tiền sử, kết quả đã có và những nhu cầu cần đánh giá bổ sung. Có thể phối hợp khám phụ khoa và các chuyên khoa liên quan khi người bệnh cần. Định hướng thăm khám là giải thích rõ mục tiêu của từng chỉ định, thống nhất lịch theo dõi và tôn trọng quyền lựa chọn của thai phụ. Hồ sơ nhân sự và thông tin chuyên môn này là dữ liệu mô phỏng của đồ án."
    },
    {
      "email": "dr.nguyenquangminh@antam.local",
      "fullName": "PGS. TS. Nguyễn Quang Minh",
      "phone": "0903112002",
      "license": "002345/BYT-CCHN",
      "rank": "ASSOC_PROFESSOR",
      "startYear": 2002,
      "specialtyCode": "PERINATOLOGY",
      "photoUrl": "https://res.cloudinary.com/dpxzyc9wu/image/upload/v1795840464/tam-an/catalog-v2/doctors/02-886c6725cb1f7259.webp",
      "bio": "Phụ trách đánh giá thông tin siêu âm và sàng lọc trước sinh, giải thích vai trò của các mốc khảo sát và giới hạn của từng phương pháp. Bác sĩ phối hợp với nhóm quản lý thai kỳ để lựa chọn kiểm tra phù hợp và hướng dẫn người bệnh hiểu các kết quả nguy cơ. Khi thông tin chưa đầy đủ hoặc cần đánh giá chuyên sâu, bác sĩ trao đổi kế hoạch hẹn kiểm tra hoặc chuyển chuyên khoa phù hợp. Hồ sơ nhân sự và thông tin chuyên môn này là dữ liệu mô phỏng của đồ án."
    },
    {
      "email": "dr.tranthanhmai@antam.local",
      "fullName": "ThS. BS. Trần Thanh Mai",
      "phone": "0903112003",
      "license": "003456/BYT-CCHN",
      "rank": "MASTER",
      "startYear": 2014,
      "specialtyCode": "OBSTETRICS",
      "photoUrl": "https://res.cloudinary.com/dpxzyc9wu/image/upload/v1795840465/tam-an/catalog-v2/doctors/03-1f58e1325b89c240.webp",
      "bio": "Phụ trách khám thai lần đầu, khám theo dõi thai kỳ và tư vấn sức khỏe sinh sản. Bác sĩ tập trung thu thập thông tin lâm sàng, đối chiếu các lần khám và hướng dẫn thai phụ chuẩn bị cho lần hẹn tiếp theo. Trong các buổi khám phụ khoa phối hợp, bác sĩ giải thích phương pháp trước khi thực hiện và tôn trọng quyền riêng tư của người bệnh. Hồ sơ nhân sự và thông tin chuyên môn này là dữ liệu mô phỏng của đồ án."
    },
    {
      "email": "dr.dangkimoanh@antam.local",
      "fullName": "BS. CKI. Đặng Kim Oanh",
      "phone": "0903112004",
      "license": "004567/BYT-CCHN",
      "rank": "SPECIALIST_I",
      "startYear": 2016,
      "specialtyCode": "PERINATOLOGY",
      "photoUrl": "https://res.cloudinary.com/dpxzyc9wu/image/upload/v1795840466/tam-an/catalog-v2/doctors/04-ff2b0d5d469e9e02.webp",
      "bio": "Phụ trách siêu âm thai theo mục tiêu khảo sát, hỗ trợ bác sĩ quản lý thai nghén đánh giá thông tin theo giai đoạn. Bác sĩ giải thích sự khác nhau giữa siêu âm cơ bản, khảo sát hình thái và sàng lọc sinh hóa, đồng thời lưu ý rằng kết quả hình ảnh có thể cần đối chiếu hoặc kiểm tra lại. Định hướng chăm sóc là báo cáo rõ ràng và phối hợp theo dõi liên tục. Hồ sơ nhân sự và thông tin chuyên môn này là dữ liệu mô phỏng của đồ án."
    },
    {
      "email": "dr.vuhoanglong@antam.local",
      "fullName": "BS. CKII. Vũ Hoàng Long",
      "phone": "0903112005",
      "license": "005678/BYT-CCHN",
      "rank": "SPECIALIST_II",
      "startYear": 2010,
      "specialtyCode": "POSTPARTUM_CARE",
      "photoUrl": "https://res.cloudinary.com/dpxzyc9wu/image/upload/v1795840467/tam-an/catalog-v2/doctors/05-b88c2622d0bebc54.webp",
      "bio": "Phụ trách chăm sóc sau sinh, đánh giá quá trình hồi phục của sản phụ và tư vấn nhu cầu theo dõi. Bác sĩ rà soát hồ sơ sinh, tình trạng vết thương khi phù hợp, các khó khăn thể chất và tinh thần, đồng thời hướng dẫn người mẹ nhận biết khi nào cần hỗ trợ y tế. Phối hợp với hộ sinh và nhân viên tư vấn để hỗ trợ gia đình trong giai đoạn sau ra viện. Hồ sơ nhân sự và thông tin chuyên môn này là dữ liệu mô phỏng của đồ án."
    },
    {
      "email": "dr.phamthuyduong@antam.local",
      "fullName": "BS. CKI. Phạm Thùy Dương",
      "phone": "0903112006",
      "license": "006789/BYT-CCHN",
      "rank": "SPECIALIST_I",
      "startYear": 2015,
      "specialtyCode": "MATERNAL_MEDICINE",
      "photoUrl": "https://res.cloudinary.com/dpxzyc9wu/image/upload/v1795840468/tam-an/catalog-v2/doctors/06-40e2ce9a61314b29.webp",
      "bio": "Phụ trách đánh giá nguy cơ bệnh lý thai kỳ, tập trung vào đường huyết, huyết áp và các yếu tố liên quan. Bác sĩ xem xét tiền sử, kết quả xét nghiệm và nhật ký theo dõi, tư vấn kế hoạch phù hợp với tình trạng. Không áp dụng cùng một phương án theo dõi cho mọi thai phụ; khi cần, phối hợp Khoa Sản và các chuyên khoa liên quan. Hồ sơ nhân sự và thông tin chuyên môn này là dữ liệu mô phỏng của đồ án."
    },
    {
      "email": "dr.nguyenhongnhung@antam.local",
      "fullName": "BS. Nguyễn Hồng Nhung",
      "phone": "0903112007",
      "license": "007890/BYT-CCHN",
      "rank": "BASIC",
      "startYear": 2019,
      "specialtyCode": "OBSTETRICS",
      "photoUrl": "https://res.cloudinary.com/dpxzyc9wu/image/upload/v1795840469/tam-an/catalog-v2/doctors/07-b1f4c3690f65fb17.webp",
      "bio": "Phụ trách khám thai định kỳ và hỗ trợ quản lý thai nghén. Bác sĩ trao đổi về diễn biến sức khỏe, rà soát kết quả trước đó và hướng dẫn chuẩn bị cho các mốc tiếp theo. Có thể phối hợp nhóm bệnh lý thai kỳ khi cần đánh giá huyết áp, đường huyết hoặc thông tin nguy cơ. Chú trọng cách giải thích dễ hiểu và kế hoạch theo dõi thực tế. Hồ sơ nhân sự và thông tin chuyên môn này là dữ liệu mô phỏng của đồ án."
    },
    {
      "email": "dr.doanvanbac@antam.local",
      "fullName": "BS. Đoàn Văn Bắc",
      "phone": "0903112008",
      "license": "008901/BYT-CCHN",
      "rank": "EXPERT",
      "startYear": 2004,
      "specialtyCode": "OBSTETRICS",
      "photoUrl": "https://res.cloudinary.com/dpxzyc9wu/image/upload/v1795840471/tam-an/catalog-v2/doctors/08-416484ccf057061c.webp",
      "bio": "Phụ trách rà soát kế hoạch chăm sóc thai kỳ, tư vấn chuẩn bị sinh và phối hợp theo dõi sau sinh. Trong các buổi tư vấn, bác sĩ tập trung giải thích các lựa chọn, lợi ích và giới hạn theo tình trạng cụ thể của người mẹ. Với những nhu cầu sau sinh, bác sĩ phối hợp đơn vị chăm sóc mẹ và bé để hỗ trợ kế hoạch tái khám phù hợp. Hồ sơ nhân sự và thông tin chuyên môn này là dữ liệu mô phỏng của đồ án."
    },
    {
      "email": "dr.hoangminhtuan@antam.local",
      "fullName": "BS. Hoàng Minh Tuấn",
      "phone": "0903112009",
      "license": "007891/BYT-CCHN",
      "rank": "BASIC",
      "startYear": 2020,
      "specialtyCode": "OBSTETRICS",
      "photoUrl": "https://res.cloudinary.com/dpxzyc9wu/image/upload/v1795840473/tam-an/catalog-v2/doctors/09-55c296a6cfb038bc.webp",
      "bio": "Phụ trách khám thai ban đầu, theo dõi định kỳ và phối hợp khám phụ khoa theo phân công. Bác sĩ quan tâm đến việc ghi nhận diễn biến giữa các lần khám, giải thích nhu cầu kiểm tra bổ sung và giúp người bệnh hiểu cách chuẩn bị cho cuộc hẹn. Khi gặp vấn đề ngoài phạm vi, bác sĩ hướng dẫn tiếp cận chuyên khoa phù hợp. Hồ sơ nhân sự và thông tin chuyên môn này là dữ liệu mô phỏng của đồ án."
    },
    {
      "email": "dr.tranmaianh@antam.local",
      "fullName": "BS. Trần Mai Anh",
      "phone": "0903112010",
      "license": "007892/BYT-CCHN",
      "rank": "BASIC",
      "startYear": 2021,
      "specialtyCode": "POSTPARTUM_CARE",
      "photoUrl": "https://res.cloudinary.com/dpxzyc9wu/image/upload/v1795840474/tam-an/catalog-v2/doctors/10-5fccfd0b2bd0afa3.webp",
      "bio": "Phụ trách tư vấn và đánh giá sức khỏe sản phụ trong giai đoạn hậu sản. Bác sĩ trao đổi về tình trạng hồi phục, nghỉ ngơi, nuôi con và những khó khăn của gia đình; phối hợp hộ sinh hướng dẫn chăm sóc tại nhà. Khi trẻ cần đánh giá bệnh lý hoặc can thiệp điều trị, hướng dẫn gia đình đến dịch vụ nhi khoa phù hợp. Hồ sơ nhân sự và thông tin chuyên môn này là dữ liệu mô phỏng của đồ án."
    },
    {
      "email": "dr.levanduc@antam.local",
      "fullName": "BS. Lê Văn Đức",
      "phone": "0903112011",
      "license": "007893/BYT-CCHN",
      "rank": "BASIC",
      "startYear": 2018,
      "specialtyCode": "MATERNAL_MEDICINE",
      "photoUrl": "https://res.cloudinary.com/dpxzyc9wu/image/upload/v1795840475/tam-an/catalog-v2/doctors/11-93c1224f0b3efa7b.webp",
      "bio": "Phụ trách theo dõi thông tin sức khỏe thai phụ có nhu cầu đánh giá bệnh lý và tư vấn lối sống. Bác sĩ xem xét thông tin về dinh dưỡng, huyết áp, đường huyết và các kết quả đã có, giải thích các bước theo dõi cần thiết. Phối hợp bác sĩ quản lý thai nghén để người mẹ có kế hoạch chăm sóc nhất quán. Hồ sơ nhân sự và thông tin chuyên môn này là dữ liệu mô phỏng của đồ án."
    },
    {
      "email": "dr.buithaolinh@antam.local",
      "fullName": "BS. Bùi Thảo Linh",
      "phone": "0903112012",
      "license": "007894/BYT-CCHN",
      "rank": "BASIC",
      "startYear": 2020,
      "specialtyCode": "GYNECOLOGY",
      "photoUrl": "https://res.cloudinary.com/dpxzyc9wu/image/upload/v1795840477/tam-an/catalog-v2/doctors/12-6edc10afdbf08e31.webp",
      "bio": "Phụ trách khám phụ khoa tổng quát và tư vấn sức khỏe sinh sản. Bác sĩ lắng nghe nhu cầu khám định kỳ, triệu chứng và tiền sử, giải thích lựa chọn thăm khám, siêu âm hoặc tầm soát khi phù hợp. Chú trọng sự riêng tư, sự đồng ý trước mỗi kỹ thuật và giải thích kết quả rõ ràng để người bệnh biết hướng theo dõi tiếp theo. Hồ sơ nhân sự và thông tin chuyên môn này là dữ liệu mô phỏng của đồ án."
    }
  ];

  const doctorList = [];
  const effectiveDate = new Date(now.getFullYear(), now.getMonth(), 1);

  for (let docIdx = 0; docIdx < doctorsDef.length; docIdx++) {
    const doc = doctorsDef[docIdx];
    const shift = doctorRoomShifts[docIdx];
    const assignedRoom = roomMap[shift.roomCode] || roomMap['P.201'];
    const accId = await createAuthAccount(doc.email, 'DOCTOR');

    const docRes = await clients.doctor.query(
      `INSERT INTO doctors (id, account_id, license_number, consultation_rank, status, version, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'ACTIVE', 1, NOW(), NOW()) RETURNING id`,
      [accId, doc.license, doc.rank],
    );
    const doctorId = docRes.rows[0].id;

    await clients.doctor.query(
      `INSERT INTO doctor_profiles (doctor_id, full_name, biography, practice_start_year, languages, photo_url, created_at, updated_at)
       VALUES ($1, $2, $3, $4, ARRAY['vi', 'en'], $5, NOW(), NOW())`,
      [doctorId, doc.fullName, doc.bio, doc.startYear, doc.photoUrl],
    );

    const specId = specialtyMap[doc.specialtyCode];
    if (specId) {
      await clients.doctor.query(
        `INSERT INTO doctor_specialties (doctor_id, specialty_id, is_primary, created_at)
         VALUES ($1, $2, true, NOW())`,
        [doctorId, specId],
      );
    }

    // Lịch làm việc chuẩn từ Thứ 2 đến Thứ 7 (day_of_week: 1 -> 6 theo chuẩn doctor-service, Chủ nhật nghỉ)
    for (let day = 1; day <= 6; day++) {
      await clients.doctor.query(
        `INSERT INTO doctor_schedules (id, doctor_id, day_of_week, start_time, end_time, slot_duration_minutes, room_id, effective_from, timezone, status, version, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 30, $5, $6, 'Asia/Ho_Chi_Minh', 'ACTIVE', 1, NOW(), NOW())`,
        [
          doctorId,
          day,
          shift.startTime,
          shift.endTime,
          assignedRoom.id,
          effectiveDate,
        ],
      );
    }

    doctorList.push({
      id: doctorId,
      accountId: accId,
      roomId: assignedRoom.id,
      roomCode: assignedRoom.code,
      roomName: assignedRoom.name,
      ...doc,
    });
  }

  // Chuyên khoa phụ (Secondary specialty) cho các bác sĩ để đảm bảo chuyên khoa nào cũng có đội ngũ chuyên gia
  const gynSpecId = specialtyMap['GYNECOLOGY'];
  if (gynSpecId && doctorList.length > 0) {
    await clients.doctor.query(
      `INSERT INTO doctor_specialties (doctor_id, specialty_id, is_primary, created_at)
       VALUES ($1, $2, false, NOW()) ON CONFLICT DO NOTHING`,
      [doctorList[0].id, gynSpecId], // BS. CKII. Lê Thu Hà
    );
  }
  if (gynSpecId && doctorList.length > 2) {
    await clients.doctor.query(
      `INSERT INTO doctor_specialties (doctor_id, specialty_id, is_primary, created_at)
       VALUES ($1, $2, false, NOW()) ON CONFLICT DO NOTHING`,
      [doctorList[2].id, gynSpecId], // ThS. BS. Trần Thanh Mai
    );
  }
  const reproSpecId = specialtyMap['POSTPARTUM_CARE'];
  if (reproSpecId && doctorList.length > 7) {
    await clients.doctor.query(
      `INSERT INTO doctor_specialties (doctor_id, specialty_id, is_primary, created_at)
       VALUES ($1, $2, false, NOW()) ON CONFLICT DO NOTHING`,
      [doctorList[7].id, reproSpecId], // TS. BS. Đoàn Văn Bắc
    );
  }
  const matSpecId = specialtyMap['MATERNAL_MEDICINE'];
  if (matSpecId && doctorList.length > 6) {
    await clients.doctor.query(
      `INSERT INTO doctor_specialties (doctor_id, specialty_id, is_primary, created_at)
       VALUES ($1, $2, false, NOW()) ON CONFLICT DO NOTHING`,
      [doctorList[6].id, matSpecId], // BS. Nguyễn Hồng Nhung
    );
  }
  if (gynSpecId && doctorList.length > 8) {
    await clients.doctor.query(
      `INSERT INTO doctor_specialties (doctor_id, specialty_id, is_primary, created_at)
       VALUES ($1, $2, false, NOW()) ON CONFLICT DO NOTHING`,
      [doctorList[8].id, gynSpecId], // BS. Hoàng Minh Tuấn
    );
  }
  const obsSpecId = specialtyMap['OBSTETRICS'];
  if (obsSpecId && doctorList.length > 11) {
    await clients.doctor.query(
      `INSERT INTO doctor_specialties (doctor_id, specialty_id, is_primary, created_at)
       VALUES ($1, $2, false, NOW()) ON CONFLICT DO NOTHING`,
      [doctorList[11].id, obsSpecId], // BS. Bùi Thảo Linh
    );
  }

  console.log(
    '✅ Đã khởi tạo 5 Phòng khám (Clinic Rooms), 12 Bác sĩ chuyên khoa, Chuyên khoa chính/phụ và Lịch làm việc tuần (Thứ 2 - Thứ 7).',
  );

  // ============================================================================
  // 7. NHÂN VIÊN LỄ TÂN & TIẾP ĐÓN (RECEPTIONISTS)
  // ============================================================================
  console.log(
    '\n--- BƯỚC 7: KHỞI TẠO BỘ PHẬN LỄ TÂN TIẾP ĐÓN (RECEPTIONIST) ---',
  );
  const receptionistsDef = [
    {
      "email": "reception.hoangyen@antam.local",
      "fullName": "Hoàng Thị Yến",
      "phone": "0904001001",
      "code": "REC-001",
      "dept": "Quầy Tiếp đón Trung tâm Tầng 1",
      "gender": "FEMALE",
      "address": "25 Tràng Thi, Hoàn Kiếm, Hà Nội",
      "avatarUrl": "https://res.cloudinary.com/dpxzyc9wu/image/upload/v1795840478/tam-an/catalog-v2/receptionists/01-c38403f790f0d57c.webp",
      "status": "ACTIVE",
      "authStatus": "ACTIVE"
    },
    {
      "email": "reception.maiphuong@antam.local",
      "fullName": "Lê Mai Phương",
      "phone": "0904001002",
      "code": "REC-002",
      "dept": "Khu vực Tiếp đón Khoa Khám bệnh Tầng 2",
      "gender": "FEMALE",
      "address": "88 Giảng Võ, Ba Đình, Hà Nội",
      "avatarUrl": "https://res.cloudinary.com/dpxzyc9wu/image/upload/v1795840480/tam-an/catalog-v2/receptionists/02-a5337703b281853a.webp",
      "status": "ACTIVE",
      "authStatus": "ACTIVE"
    },
    {
      "email": "reception.thungan@antam.local",
      "fullName": "Trần Thu Ngân",
      "phone": "0904001003",
      "code": "REC-000",
      "dept": "Ban Tiếp đón & Chăm sóc Khách hàng",
      "gender": "FEMALE",
      "address": "12 Nguyễn Du, Hai Bà Trưng, Hà Nội",
      "avatarUrl": "https://res.cloudinary.com/dpxzyc9wu/image/upload/v1795840481/tam-an/catalog-v2/receptionists/03-76d0dda813ddb17d.webp",
      "status": "ACTIVE",
      "authStatus": "ACTIVE"
    },
    {
      "email": "reception.quocanh@antam.local",
      "fullName": "Phạm Quốc Anh",
      "phone": "0904001004",
      "code": "REC-003",
      "dept": "Quầy Tiếp đón & Hướng dẫn Cấp cứu Tầng 1",
      "gender": "MALE",
      "address": "15 Lê Duẩn, Ba Đình, Hà Nội",
      "avatarUrl": "https://res.cloudinary.com/dpxzyc9wu/image/upload/v1795840482/tam-an/catalog-v2/receptionists/04-cf9f112372749d14.webp",
      "status": "ACTIVE",
      "authStatus": "ACTIVE"
    }
  ];

  const receptionistList = [];
  for (const rec of receptionistsDef) {
    const accId = await createAuthAccount(
      rec.email,
      'RECEPTIONIST',
      null,
      rec.authStatus,
    );

    const recRes = await clients.receptionist.query(
      `INSERT INTO receptionists (id, account_id, employee_code, status, version, created_by_account_id, updated_by_account_id, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 1, $4, $4, NOW(), NOW()) RETURNING id`,
      [accId, rec.code, rec.status, adminAccountId],
    );
    const receptionistId = recRes.rows[0].id;

    await clients.receptionist.query(
      `INSERT INTO receptionist_profiles (receptionist_id, full_name, work_phone, login_email, address, department, gender, avatar_url, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())`,
      [
        receptionistId,
        rec.fullName,
        rec.phone,
        rec.email,
        rec.address,
        rec.dept,
        rec.gender,
        rec.avatarUrl,
      ],
    );

    receptionistList.push({ id: receptionistId, accountId: accId, ...rec });
  }

  console.log('✅ Đã khởi tạo 4 Nhân viên Lễ tân (Receptionists & Profiles).');

  // ============================================================================
  // 8. BỆNH NHÂN THAI PHỤ (PATIENTS WITH ENCRYPTED NATIONAL ID)
  // ============================================================================
  console.log(
    '\n--- BƯỚC 8: KHỞI TẠO DANH SÁCH BỆNH NHÂN THAI PHỤ (PATIENTS) ---',
  );
  const patientsDef = [
    {
      email: 'patient.minhanh@gmail.com',
      fullName: 'Nguyễn Minh Anh',
      phone: '0901000001',
      dob: '1995-06-15',
      nationalId: '001195000101',
      address: '12 Nguyễn Du, Phường Hàng Bài, Hoàn Kiếm, Hà Nội',
      emergencyName: 'Trần Văn Bình',
      emergencyRel: 'Chồng',
      emergencyPhone: '0901000002',
      secondaryContacts: [
        {
          name: 'Lê Thị Mai',
          rel: 'Mẹ ruột',
          phone: '0901000099',
          priority: 2,
        },
      ],
    },
    {
      email: 'patient.thanhhang@gmail.com',
      fullName: 'Trần Thị Thanh Hằng',
      phone: '0901234003',
      dob: '1993-09-22',
      nationalId: '001193000102',
      address: '45 Tràng Thi, Hàng Trống, Hoàn Kiếm, Hà Nội',
      emergencyName: 'Nguyễn Hoàng Long',
      emergencyRel: 'Chồng',
      emergencyPhone: '0901234004',
      secondaryContacts: [
        {
          name: 'Trần Thị Kim Oanh',
          rel: 'Chị ruột',
          phone: '0901234098',
          priority: 2,
        },
      ],
    },
    {
      email: 'patient.ngocmai@gmail.com',
      fullName: 'Lê Ngọc Mai',
      phone: '0901234005',
      dob: '1998-03-10',
      nationalId: '001198000103',
      address: '88 Cầu Giấy, Quan Hoa, Cầu Giấy, Hà Nội',
      emergencyName: 'Lê Văn Tuấn',
      emergencyRel: 'Bố đẻ',
      emergencyPhone: '0901234006',
    },
    {
      email: 'patient.quynhchi@gmail.com',
      fullName: 'Phạm Quỳnh Chi',
      phone: '0901234007',
      dob: '1992-12-05',
      nationalId: '001192000104',
      address: '156 Nguyễn Trãi, Thượng Đình, Thanh Xuân, Hà Nội',
      emergencyName: 'Vũ Mạnh Hùng',
      emergencyRel: 'Chồng',
      emergencyPhone: '0901234008',
      secondaryContacts: [
        {
          name: 'Vũ Thị Lan',
          rel: 'Mẹ chồng',
          phone: '0901234097',
          priority: 2,
        },
      ],
    },
    {
      email: 'patient.thuyduong@gmail.com',
      fullName: 'Hoàng Thùy Dương',
      phone: '0901234009',
      dob: '1996-08-18',
      nationalId: '001196000105',
      address: '23 Lạc Long Quân, Bưởi, Tây Hồ, Hà Nội',
      emergencyName: 'Hoàng Văn Nam',
      emergencyRel: 'Bố đẻ',
      emergencyPhone: '0901234010',
    },
    {
      email: 'patient.kimngan@gmail.com',
      fullName: 'Vũ Thị Kim Ngân',
      phone: '0901234011',
      dob: '1994-11-30',
      nationalId: '001194000106',
      address: '74 Giải Phóng, Đồng Tâm, Hai Bà Trưng, Hà Nội',
      emergencyName: 'Đỗ Đức Thắng',
      emergencyRel: 'Chồng',
      emergencyPhone: '0901234012',
    },
    {
      email: 'patient.thutrang@gmail.com',
      fullName: 'Đỗ Thu Trang',
      phone: '0901234013',
      dob: '1997-04-25',
      nationalId: '001197000107',
      address: '102 Thái Hà, Trung Liệt, Đống Đa, Hà Nội',
      emergencyName: 'Phạm Hải Đăng',
      emergencyRel: 'Chồng',
      emergencyPhone: '0901234014',
    },
    {
      email: 'patient.phuonglinh@gmail.com',
      fullName: 'Bùi Phương Linh',
      phone: '0901234015',
      dob: '1999-01-14',
      nationalId: '001199000108',
      address: '55 Xã Đàn, Nam Đồng, Đống Đa, Hà Nội',
      emergencyName: 'Bùi Quang Vinh',
      emergencyRel: 'Bố đẻ',
      emergencyPhone: '0901234016',
    },
    {
      email: 'patient.honghanh@gmail.com',
      fullName: 'Đinh Thị Hồng Hạnh',
      phone: '0901234017',
      dob: '1991-07-08',
      nationalId: '001191000109',
      address: '36 Hoàng Hoa Thám, Thụy Khuê, Tây Hồ, Hà Nội',
      emergencyName: 'Trương Quốc Bảo',
      emergencyRel: 'Chồng',
      emergencyPhone: '0901234018',
    },
    {
      email: 'patient.bichthuy@gmail.com',
      fullName: 'Phan Thị Bích Thủy',
      phone: '0901234019',
      dob: '1995-10-12',
      nationalId: '001195000110',
      address: '19 Lê Văn Lương, Nhân Chính, Thanh Xuân, Hà Nội',
      emergencyName: 'Nguyễn Đình Trọng',
      emergencyRel: 'Chồng',
      emergencyPhone: '0901234020',
    },
    {
      email: 'patient.yennhi@gmail.com',
      fullName: 'Dương Yến Nhi',
      phone: '0901234021',
      dob: '2000-02-28',
      nationalId: '001200000111',
      address: '67 Trần Duy Hưng, Trung Hòa, Cầu Giấy, Hà Nội',
      emergencyName: 'Dương Thế Anh',
      emergencyRel: 'Bố đẻ',
      emergencyPhone: '0901234022',
    },
    {
      email: 'patient.baochau@gmail.com',
      fullName: 'Võ Bảo Châu',
      phone: '0901234023',
      dob: '1996-05-19',
      nationalId: '001196000112',
      address: '18 Lý Thường Kiệt, Phan Chu Trinh, Hoàn Kiếm, Hà Nội',
      emergencyName: 'Lê Quang Huy',
      emergencyRel: 'Chồng',
      emergencyPhone: '0901234024',
    },
    // Bệnh nhân vãng lai đăng ký trực tiếp tại quầy tiếp đón (authAccountId = null)
    {
      isWalkIn: true,
      email: null,
      fullName: 'Bùi Thị Ngọc Mai',
      phone: '0901234025',
      dob: '1999-12-05',
      nationalId: '001199000113',
      address: '72 Bà Triệu, Hàng Bài, Hoàn Kiếm, Hà Nội',
      emergencyName: 'Bùi Văn Hưng',
      emergencyRel: 'Bố ruột',
      emergencyPhone: '0901234026',
    },
    {
      isWalkIn: true,
      email: null,
      fullName: 'Phan Thanh Trúc',
      phone: '0901234027',
      dob: '2001-04-20',
      nationalId: '001201000114',
      address: '15 Lê Thánh Tông, Phan Chu Trinh, Hoàn Kiếm, Hà Nội',
      emergencyName: 'Đặng Quốc Anh',
      emergencyRel: 'Chồng',
      emergencyPhone: '0901234028',
    },
  ];

  const patientList = [];

  for (const pat of patientsDef) {
    let accId = null;
    let creatorAccountId = receptionistList[0].accountId;
    if (!pat.isWalkIn && pat.email) {
      accId = await createAuthAccount(pat.email, 'PATIENT');
      creatorAccountId = accId;
    }
    const { ciphertext, lookupHash } = encryptNationalId(pat.nationalId);
    const normName = normalizeSearchName(pat.fullName);
    const formattedPhone = normalizePhone(pat.phone);

    const patRes = await clients.patient.query(
      `INSERT INTO patients (id, auth_account_id, full_name, normalized_full_name, date_of_birth, phone_number, national_id_ciphertext, national_id_lookup_hash, address, version, created_by_account_id, updated_by_account_id, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $9, NOW(), NOW()) RETURNING id`,
      [
        accId,
        pat.fullName,
        normName,
        pat.dob,
        formattedPhone,
        ciphertext,
        lookupHash,
        pat.address,
        creatorAccountId,
      ],
    );
    const patientId = patRes.rows[0].id;

    // Người liên hệ khẩn cấp chính (Primary Contact, priority = 1)
    await clients.patient.query(
      `INSERT INTO emergency_contacts (id, patient_id, full_name, relationship, phone_number, is_primary, priority, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, true, 1, NOW(), NOW())`,
      [
        patientId,
        pat.emergencyName,
        pat.emergencyRel,
        normalizePhone(pat.emergencyPhone),
      ],
    );

    // Người liên hệ khẩn cấp phụ (Secondary Contacts, priority >= 2)
    if (pat.secondaryContacts && Array.isArray(pat.secondaryContacts)) {
      for (const sc of pat.secondaryContacts) {
        await clients.patient.query(
          `INSERT INTO emergency_contacts (id, patient_id, full_name, relationship, phone_number, is_primary, priority, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, false, $5, NOW(), NOW())`,
          [
            patientId,
            sc.name,
            sc.rel,
            normalizePhone(sc.phone),
            sc.priority || 2,
          ],
        );
      }
    }

    patientList.push({
      id: patientId,
      accountId: accId,
      ...pat,
      phone: formattedPhone,
    });
  }

  console.log(
    '✅ Đã khởi tạo 14 Bệnh nhân thai phụ (12 trực tuyến + 2 vãng lai) với mã hóa AES-256-GCM và Người liên hệ khẩn cấp.',
  );

  // ============================================================================
  // ĐÓNG TẤT CẢ KẾT NỐI DATABASE
  // ============================================================================
  // Commit only the seven databases written by this seed. Hold the read guards
  // on the remaining databases until the setup closes its connections.
  for (const name of Object.keys(foundationTables)) await clients[name].query('COMMIT');
  } catch (error) {
    await Promise.allSettled(Object.values(clients).map((client) => client.query('ROLLBACK')));
    throw error;
  } finally {
    await Promise.allSettled(Object.values(clients).map((client) => client.end()));
  }

  console.log('Đã khởi tạo dữ liệu demo Tâm An.');
}

main().catch((error) => {
  console.error('Seed thất bại:', error.code || error.message);
  process.exitCode = 1;
});
