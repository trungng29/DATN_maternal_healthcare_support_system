# Service Catalog Service — Research & Service Specification

> **Trạng thái:** Draft để review, chưa phải implementation.
> **Ngày nghiên cứu:** 2026-09-08 (UTC+7).
> **Phạm vi:** Thiết kế Service Catalog Service cho maternal healthcare support system, tham khảo dữ liệu công khai tại Online Vinmec.
> **Quy ước:** **[FACT]** là nội dung được xác nhận từ source/config hoặc nguồn công khai; **[PROPOSAL]** là thiết kế đề xuất; **[OPEN]** cần quyết định trước khi implement.

---

## 1. Executive summary

**[FACT]** Repository hiện chưa có NestJS app, Prisma schema, OpenAPI, Kong route, Docker service hoặc database dành cho Service Catalog Service. Các app hiện có là Auth, Patient, Doctor, Receptionist và Sample.

**[FACT]** Tài liệu quy hoạch hiện tại xác định Catalog domain sở hữu các khái niệm MedicalService, ServiceCategory, Department, Room và BasePrice; chịu trách nhiệm danh mục dịch vụ khám, loại khám, phòng phục vụ luồng khám và giá cơ bản.

**[FACT]** Specialty hiện thuộc Doctor Service trong source thực tế và tài liệu chi tiết. Catalog chỉ được tham chiếu specialtyId; không được tạo bản sao Specialty master hay truy cập Doctor Database.

**[PROPOSAL]** Tách Service Catalog Service thành bounded context riêng, read-heavy, là source of truth cho:

- dịch vụ hoặc gói dịch vụ có thể khám/đặt;
- category và audience tag dùng để khám phá;
- cơ sở, khoa và phòng phục vụ dịch vụ;
- offering của một dịch vụ tại một cơ sở;
- giá cơ bản có hiệu lực theo thời gian.

Service không sở hữu lịch hẹn, slot, bác sĩ, Specialty, hồ sơ y tế, hóa đơn, thanh toán, giảm giá hoặc identity. Public client đọc catalog qua Kong; Admin quản trị catalog; Appointment Service dùng internal contract để kiểm tra offering trước khi đặt lịch và lưu snapshot cần thiết.

**[PROPOSAL]** Không sao chép nguyên mô hình thương mại điện tử của Vinmec. Kết quả crawl chỉ dùng để kiểm chứng taxonomy và nhu cầu query. Không import hoặc phát hành lại dữ liệu/nội dung Vinmec nếu chưa có quyền sử dụng dữ liệu.

---

## 2. Nguồn và phương pháp nghiên cứu

### 2.1 Nguồn nội bộ đã đọc

| Nguồn | Vai trò | Nhận định chính |
|---|---|---|
| **services/apps/** và **services/prisma/** | Source of truth implementation | Chưa có Catalog Service; Doctor Service đang sở hữu Specialty |
| **docker-compose.yml** | Source of truth infrastructure | Chưa có catalog app/database/migration; app ports hiện dùng 5003–5006 |
| **docs/api-specs/kong.yml** | Gateway config được import | Chưa có Catalog route; public prefix theo dạng /api/domain |
| **docs/quy-hoach-microservices-use-case-thai-phu-kham-thai.md** | Quy hoạch domain | Catalog entities và quan hệ với Appointment, Doctor, Medical Record |
| **docs/doctor-service-specification.md** | Boundary liên quan | Specialty thuộc Doctor; departmentId và roomId là Catalog references |
| **docs/service-specification-template.md** | Convention tài liệu | Boundary, API, rule/scenario, failure, security, test, approval |
| Patient/Doctor/Receptionist source và specs | Pattern hiện hành | NestJS, Prisma, PostgreSQL, JWT RS256, request ID, error envelope, pagination |

Đã kiểm kê toàn bộ file dưới **docs/**, gồm docs hiện hành, OpenAPI/Kong, runbook, template, tài liệu cũ và hướng dẫn AI. Tài liệu trong **docs/_old/** chỉ được dùng làm historical context, không ghi đè source/config hiện tại.

### 2.2 Nguồn Vinmec công khai

| URL | Mục đích | Truy cập |
|---|---|---|
| https://online.vinmec.com/vn/dich-vu | Taxonomy, filter và public payload | 2026-09-08 |
| https://online.vinmec.com/robots.txt | Giới hạn crawl | 2026-09-08 |
| https://online.vinmec.com/sitemap.xml | Inventory URL public | 2026-09-08 |
| https://online.vinmec.com/vn/dich-vu/goi-thai-san-12-tuan-thai-don | Kiểm tra slug và metadata trang chi tiết | 2026-09-08 |
| https://online.vinmec.com/vn/dich-vu/goi-thai-san-12-tuan-thai-oi | Đối chiếu một trang chi tiết thứ hai | 2026-09-08 |

Phương pháp crawl:

1. Chỉ gửi số ít HTTP GET tới nội dung public.
2. Không đăng nhập, không dùng cookie người dùng, không bypass Cloudflare hoặc anti-bot.
3. Không gọi các query URL mà robots.txt disallow.
4. Chỉ phân tích HTML/Next.js payload, page bundle được HTML tham chiếu, sitemap và hai trang chi tiết mẫu.
5. Không lưu nội dung dài của bên thứ ba vào repository; tài liệu chỉ ghi schema, thống kê và ví dụ ngắn cần thiết.

### 2.3 Giới hạn và lưu ý pháp lý

- **[FACT]** robots.txt cho phép đường dẫn gốc nói chung nhưng disallow các URL filter như /vn/dich-vu?categoryIds=..., ?genders=..., ?ages=..., ?sortBy=... và các vùng tài khoản, đơn hàng, thanh toán.
- **[FACT]** Trang đặt sau Cloudflare và trả Cache-Control private, no-cache, no-store.
- **[PROPOSAL]** Không xây scheduled scraper Vinmec trong Catalog Service. Nếu có thỏa thuận dữ liệu, ingestion phải dùng API/export được cấp phép hoặc adapter riêng có rate limit, provenance, checksum và manual approval.
- ID, category, số lượng và field quan sát được có thể thay đổi sau thời điểm nghiên cứu; chúng không phải contract ổn định của Vinmec.
- Publicly accessible không đồng nghĩa với được phép sao chép, phân phối lại hoặc sử dụng thương mại. Cần review Terms, Privacy và licensing trước mọi import.

---

## 3. Kết quả nghiên cứu dữ liệu Vinmec

### 3.1 Technology và inventory quan sát được

- **[FACT]** Trang dùng Next.js App Router: response có header x-powered-by Next.js, RSC payload và page chunk cho app/[countryCode]/services/page.
- **[FACT]** HTML public có marker __MEDUSA_CONFIG__ và publishable key, cho thấy storefront dùng Medusa hoặc SDK tương thích; không thể suy ra private API từ riêng dữ kiện này.
- **[FACT]** Snapshot trang danh mục chứa **15 category**, **269 product ID duy nhất** và **22 branch/facility records**.
- **[FACT]** Sitemap snapshot có **240 URL**, trong đó **226 URL** khớp /vn/dich-vu/slug.
- **[FACT]** 269 product ID trong category lớn hơn 226 URL chi tiết trong sitemap. Có thể do trạng thái publish, category membership, item chưa index hoặc khác biệt snapshot; chưa có bằng chứng để kết luận nguyên nhân.

### 3.2 Taxonomy category quan sát được

15 category hiển thị trong snapshot:

1. Thai sản
2. Sức khỏe tổng quát
3. Biobank
4. Tiêu hóa
5. Thần kinh - Đột quỵ
6. Cơ xương khớp
7. Nhi - Sơ sinh
8. Vaccine
9. Hỗ trợ sinh sản
10. Tim mạch
11. Phục hồi chức năng
12. Dinh dưỡng
13. Vú - Giáp - Phụ khoa
14. Y học cổ truyền
15. Ở cữ An Nhiên

**[FACT]** Category payload có các field quan sát được: id, name, description, metadata.thumbnail và products[].id.

### 3.3 Filter và sort quan sát được

| Nhóm | Giá trị quan sát được | Pattern payload/UI |
|---|---|---|
| Category | 15 nhóm ở trên | categoryIds xuất hiện trong robots rule |
| Cơ sở | “Tất cả cơ sở” và branch records | branch có id, code, location |
| Đối tượng | Phụ nữ có thai, nhân viên văn phòng, người cao tuổi, người chơi thể thao, trẻ em, sức khỏe gia đình | tag group object |
| Giới tính | Nữ, Nam | group gender, gender_code female/male |
| Độ tuổi | 1–17, 18–24, 25–29, 30–50, 50+ | group age, min_age, max_age |
| Giá | Từ thấp đến cao, từ cao đến thấp | UI values price_asc, price_desc |
| Search | “Tìm kiếm dịch vụ, lớp học” | Có UI search; endpoint không được xác nhận |

Payload còn có tag groups như label và feature. Đây là taxonomy merchandising/discovery, không nên dùng như chẩn đoán hoặc clinical eligibility.

### 3.4 Branch/facility fields quan sát được

Các field gồm id, name, code, description, address, phone, email, location, latitude, longitude, type, is_default, external_id, metadata.link và metadata.thumbnail_url.

Một số mã ví dụ quan sát được: VQR01 cho Central Park, VQR04 cho Times City, VQR05 cho Đà Nẵng và VQR08 cho Cần Thơ. Đây là mã của Vinmec, không tái sử dụng làm business code của hệ thống nếu không có thỏa thuận dữ liệu.

### 3.5 Trang chi tiết quan sát được

- URL dùng slug trình bày, ví dụ goi-thai-san-12-tuan-thai-don.
- Server-rendered metadata có title, description, keywords, canonical URL và OpenGraph image.
- Hai trang mẫu khác nhau bằng đặc điểm gói thai đơn/thai đôi, cho thấy mỗi cấu hình dịch vụ có thể là catalog item riêng thay vì query option.
- HTML initial response không chứa product price/variant đầy đủ. Chi tiết thương mại có thể được tải sau ở client hoặc phụ thuộc branch/session; không khẳng định schema price/variant từ hai response này.

### 3.6 Bài học áp dụng, không sao chép mô hình

| Quan sát | Ý nghĩa cho hệ thống này |
|---|---|
| Dịch vụ thuộc category và có slug | Cần ServiceCategory, mapping N—N và slug unique |
| Một category có nhiều product | Không ép category thành enum trong code |
| Giá/cung cấp có thể phụ thuộc cơ sở | Tách MedicalService khỏi ServiceOffering và BasePrice |
| Có age/gender/audience/feature tags | Dùng extensible tag taxonomy thay vì thêm cột cho từng filter |
| Branch có location/contact/coordinate | Cần xác định owner rõ cho Facility |
| Sitemap dùng slug detail | Public detail lookup bằng slug; internal contract dùng UUID |
| UI sort theo giá | Phải định nghĩa giá nào khi service có nhiều facility offering |

---

## 4. Hiện trạng repository và khác biệt tài liệu

### 4.1 Được xác nhận từ source/config

- Backend là NestJS monorepo; Prisma và PostgreSQL theo database/service owner.
- Các service có GET /health; Patient còn có GET /ready kiểm tra DB.
- JWT access token là RS256 với sub, role, jti, issuer và audience.
- Doctor, Patient và Receptionist hiện tự verify JWT/JWKS ở service; Kong JWT plugin hiện chỉ gắn vào Patient route.
- Response pattern đầy đủ nhất hiện có:
  - success: data cùng meta.requestId;
  - error: error.code, error.message và error.requestId;
  - /health không bọc envelope.
- Doctor và Receptionist dùng cursor pagination, default 20, max 100; Patient search có chỗ dùng page/limit.
- Repo chưa bật message broker; event/outbox trong docs/schema chưa chứng minh transport đang chạy.

### 4.2 Boundary phải giữ

- **Doctor Service** sở hữu Doctor, DoctorProfile, Specialty, doctor-specialty mapping, schedule và availability.
- **Catalog Service** chỉ lưu specialtyId như external reference, không tạo FK cross-database và không duplicate Specialty master.
- Doctor schedule có departmentId và roomId nullable, được mô tả là Catalog references.
- **Appointment Service** sở hữu appointment, slot hold, booking state và overbooking rule.
- **Billing Service** sở hữu invoice, charge, payment, discount, tax và refund; Catalog chỉ sở hữu giá niêm yết cơ bản.
- **Auth Service** sở hữu account, role/permission và token/session.
- Gateway chỉ routing, authentication, rate limit và CORS; không tính giá, chọn service hoặc kiểm tra booking eligibility.

### 4.3 Nội dung docs có khả năng outdated

- Authentication architecture có các đoạn mô tả repository còn ở trạng thái sample và Kong chưa có JWT. Source/config hiện đã implement JWT, refresh, JWKS và Patient Kong JWT plugin.
- Auth README vẫn có một đoạn nói chưa phát hành token, nhưng các section sau và source thực tế đã phát hành access/refresh token. Source được ưu tiên.
- Tài liệu quy hoạch cho phép tạm gộp basic catalog vào Appointment ở MVP. Task hiện tại nghiên cứu service độc lập nên spec này chọn boundary riêng, nhưng quyết định triển khai vẫn cần approval.

---

## 5. Tổng quan và boundary đề xuất

| Thuộc tính | Giá trị **[PROPOSAL]** |
|---|---|
| Tên service | Service Catalog Service |
| Mục đích | Danh mục dịch vụ y tế theo category, đối tượng, cơ sở và giá cơ bản |
| Bounded context | Healthcare Service Catalog |
| Actors/Consumers | Public/PATIENT, ADMIN, Appointment, Doctor, Medical Record, Billing |
| Source path | services/apps/service-catalog-service/ |
| Prisma path | services/prisma/catalog/schema.prisma |
| Stack | NestJS, Prisma, PostgreSQL hiện có |
| Internal port | 5007, đề xuất chưa được cấp chính thức |
| Gateway prefix | /api/catalog |
| OpenAPI | docs/api-specs/service-catalog-service.yaml khi implement |

### 5.1 Chịu trách nhiệm

- CRUD và lifecycle của MedicalService.
- Category hierarchy, category mapping và public slug.
- Audience/filter tags cho discovery.
- Facility, Department và Room phục vụ catalog/luồng khám.
- Offering: dịch vụ nào được cung cấp ở cơ sở hoặc khoa nào.
- Giá cơ bản theo offering và effective period.
- Public search, filter, sort và facet cho active catalog.
- Internal eligibility/read contract cho Appointment, Doctor và Medical Record.
- Audit thay đổi catalog và version để consumer lưu snapshot.
- Optional import staging có provenance nếu nguồn dữ liệu được cấp phép.

### 5.2 Không chịu trách nhiệm

- Tài khoản, role, permission, JWT/session.
- Hồ sơ Doctor hoặc master Specialty.
- Lịch làm việc, slot khả dụng, giữ chỗ hoặc appointment lifecycle.
- Hồ sơ Patient, pregnancy profile hoặc clinical eligibility.
- Kết quả xét nghiệm, medical record hoặc chỉ định lâm sàng.
- Hóa đơn, thanh toán, voucher, discount, bảo hiểm, refund hoặc tax.
- Ecommerce cart/order/payment/shipping.
- CMS tổng quát hoặc asset hosting nếu chưa có yêu cầu.
- Crawl/sync website bên thứ ba không có thỏa thuận.

### 5.3 Data ownership

Service là source of truth cho:

- MedicalService
- ServiceCategory và MedicalServiceCategory
- CatalogTag và MedicalServiceTag
- Facility, Department và Room
- ServiceOffering
- BasePrice
- catalog audit/idempotency records

| Dữ liệu chỉ tham chiếu | Owner | Cách tham chiếu |
|---|---|---|
| specialtyId | Doctor Service | UUID, không FK cross-DB |
| doctorId nếu có mapping directory future | Doctor Service | Không lưu ở core MVP; query contract khi cần |
| accountId/actorId | Auth Service | JWT sub dùng cho audit |
| appointmentId | Appointment Service | Không lưu trong catalog core |
| Invoice/price charged | Billing Service | Catalog cung cấp base-price snapshot |

---

## 6. Actors và authorization

| Actor/Consumer | Hành động | Permission đề xuất | Rule |
|---|---|---|---|
| Anonymous/PATIENT | Xem/search active catalog | Public read | Chỉ active records và public field allowlist |
| ADMIN | Tạo, sửa, publish, archive | catalog:manage | DTO allowlist, optimistic version, audit |
| RECEPTIONIST | Tra cứu khi tiếp nhận | catalog:read | Read-only, không đổi giá/master |
| DOCTOR/NURSE | Tra cứu service/room | catalog:read | Read-only, không có PHI |
| Appointment Service | Resolve/validate offering | Internal auth | Không public route; minimum snapshot |
| Doctor Service | Validate department/room | Internal auth | Không public route |
| Medical Record Service | Resolve service metadata | Internal auth | Không trả pricing nếu không cần |
| Billing Service | Lấy base-price/version | Internal auth | Base price không phải final invoice |

**[FACT]** Service-to-service auth chưa thống nhất toàn repo: Patient có internal JWT riêng, Auth internal lookup dùng shared secret, Doctor internal eligibility chưa thể hiện guard tương đương.

**[OPEN]** Phải chọn contract chung trước khi expose /internal/*. Không dùng header tên service không ký và không dùng user JWT như service identity.

---

## 7. Domain model đề xuất

### 7.1 Enums

| Enum | Giá trị |
|---|---|
| CatalogStatus | DRAFT, ACTIVE, INACTIVE, ARCHIVED |
| MedicalServiceKind | CONSULTATION, DIAGNOSTIC, PROCEDURE, PACKAGE, VACCINATION, OTHER |
| TagGroup | AGE, GENDER, AUDIENCE, FEATURE, LABEL |
| FacilityType | HOSPITAL, CLINIC, CENTER, OTHER |
| OfferingStatus | DRAFT, ACTIVE, INACTIVE |
| PriceStatus | SCHEDULED, ACTIVE, EXPIRED, CANCELLED |

### 7.2 MedicalService

| Field | Type | Required | Constraint | Mô tả |
|---|---|---:|---|---|
| id | UUID | Yes | PK | Internal identity |
| code | varchar(50) | Yes | unique, uppercase normalized | Business code nội bộ |
| slug | varchar(160) | Yes | unique | Public URL key |
| name | varchar(200) | Yes | trim 2–200 | Tên hiển thị |
| summary | varchar(500) | No | sanitized | Mô tả card |
| description | text | No | sanitized, bounded | Nội dung chi tiết |
| kind | enum | Yes | — | Loại dịch vụ |
| specialtyId | UUID | No | external reference | Specialty thuộc Doctor Service |
| thumbnailUrl | varchar(2048) | No | HTTPS/allowlist | Ảnh đại diện |
| status | enum | Yes | DRAFT | Lifecycle |
| version | int | Yes | default 1, >0 | Optimistic concurrency/snapshot |
| publishedAt | timestamptz | No | set khi ACTIVE lần đầu | Publish time |
| createdAt/updatedAt | timestamptz | Yes | DB managed | Audit timestamps |

### 7.3 ServiceCategory

| Field | Type | Required | Constraint |
|---|---|---:|---|
| id | UUID | Yes | PK |
| code | varchar(50) | Yes | unique |
| slug | varchar(120) | Yes | unique |
| name | varchar(120) | Yes | unique normalized name |
| description | varchar(1000) | No | sanitized |
| parentId | UUID | No | self-reference; no cycle |
| thumbnailUrl | varchar(2048) | No | HTTPS policy |
| displayOrder | int | Yes | default 0 |
| status/version/timestamps | — | Yes | lifecycle/concurrency |

MedicalServiceCategory(serviceId, categoryId, isPrimary, displayOrder) là mapping N—N. Mỗi active service phải có đúng một primary active category; một service có thể xuất hiện ở nhiều category.

### 7.4 CatalogTag và MedicalServiceTag

| Field | Type | Required | Ghi chú |
|---|---|---:|---|
| id/code/label | UUID/string/string | Yes | code unique trong group |
| group | TagGroup | Yes | AGE, GENDER, AUDIENCE... |
| minAge/maxAge | smallint | No | Chỉ AGE; inclusive, 0–150 |
| genderCode | varchar(30) | No | Discovery label, không suy ra identity |
| metadata | jsonb | No | Không chứa executable HTML/secret |
| status | CatalogStatus | Yes | Public chỉ ACTIVE |

Tag là metadata tìm kiếm, không phải quyết định y khoa. PREGNANT_WOMEN không chứng minh Patient đang mang thai và không thay clinical screening.

### 7.5 Facility

Đây là **[PROPOSAL] mở rộng** từ kết quả nghiên cứu. Tài liệu quy hoạch cũ chưa liệt kê Facility nhưng dữ liệu thực tế và nhu cầu “tất cả cơ sở” cho thấy cần owner rõ.

| Field | Type | Required | Constraint |
|---|---|---:|---|
| id | UUID | Yes | PK |
| code | varchar(50) | Yes | unique |
| slug/name | string | Yes | slug unique; name 2–200 |
| type | FacilityType | Yes | — |
| address/location | string | No | Public operational data |
| phone/email | string | No | Validate format |
| latitude/longitude | decimal | No | Cùng null hoặc cùng có; valid range |
| thumbnailUrl/externalUrl | URL | No | HTTPS/allowlist |
| isDefault | boolean | Yes | Tối đa một default active facility |
| status/version/timestamps | — | Yes | — |

### 7.6 Department và Room

Department thuộc một Facility; Room thuộc một Department. Code unique trong parent scope. Public response không cần trả thông tin vận hành nhạy cảm; internal resolve trả facilityId, departmentId và status.

Room không lưu doctor schedule. Doctor Service tiếp tục lưu departmentId/roomId reference nullable trong schedule và tự sở hữu availability.

### 7.7 ServiceOffering

Biểu diễn “dịch vụ X được cung cấp tại cơ sở Y”.

| Field | Type | Required | Constraint |
|---|---|---:|---|
| id | UUID | Yes | PK |
| medicalServiceId | UUID | Yes | local FK |
| facilityId | UUID | Yes | local FK |
| departmentId | UUID | No | Phải thuộc facility |
| defaultRoomId | UUID | No | Phải thuộc department/facility |
| durationMinutes | int | No | 1–1440; informational, không tạo slot |
| bookingEnabled | boolean | Yes | default false |
| status/version/timestamps | — | Yes | — |

MVP đề xuất unique (medicalServiceId, facilityId). Nếu cùng một dịch vụ được cung cấp bởi nhiều department trong cùng facility, phải đổi business key trước migration.

### 7.8 BasePrice

| Field | Type | Required | Constraint |
|---|---|---:|---|
| id | UUID | Yes | PK |
| offeringId | UUID | Yes | local FK |
| amountMinor | bigint | Yes | >= 0; không dùng float |
| currency | char(3) | Yes | default VND |
| effectiveFrom | timestamptz | Yes | — |
| effectiveTo | timestamptz | No | > effectiveFrom, end-exclusive |
| status | PriceStatus | Yes | — |
| version/timestamps | — | Yes | — |

Không được có hai active/scheduled price intervals overlap cho cùng offering và currency. Catalog trả priceFrom cho discovery và exact active base price khi có offering. Billing không được coi amount này là final charge nếu còn insurance, discount hoặc tax.

### 7.9 Constraints và indexes tối thiểu

- Unique normalized code và slug.
- Index MedicalService(status, updatedAt, id).
- Index mapping (categoryId, serviceId) và (tagId, serviceId).
- Index ServiceOffering(facilityId, status, medicalServiceId).
- Index BasePrice(offeringId, status, effectiveFrom, effectiveTo).
- Check age, coordinate, amount và duration ranges.
- Transaction bảo đảm một primary category/service.
- Lock hoặc database constraint bảo đảm price interval không overlap.
- Search MVP dùng normalized searchable text trong PostgreSQL; chưa thêm Elasticsearch/OpenSearch.

---

## 8. Lifecycle và business rules

### 8.1 State machine

MedicalService và master data: DRAFT → ACTIVE → INACTIVE → ACTIVE; DRAFT/INACTIVE → ARCHIVED. ARCHIVED là terminal và không public.

Offering có DRAFT, ACTIVE, INACTIVE. BasePrice được schedule, active theo effective time, expired hoặc cancelled.

### 8.2 Business rules

| ID | Quy tắc | Enforced by | Error |
|---|---|---|---|
| BR-001 | Code và slug unique sau normalize | DB + app | CATALOG_CODE_EXISTS / SLUG_EXISTS |
| BR-002 | Chỉ ACTIVE records xuất hiện ở public API | Query policy | N/A hoặc 404 |
| BR-003 | Active service có name, kind, đúng một primary category và ít nhất một active offering | App + transaction | SERVICE_NOT_PUBLISHABLE |
| BR-004 | Active offering chỉ tham chiếu active service/facility/department | App + local FK | OFFERING_NOT_PUBLISHABLE |
| BR-005 | Department thuộc facility; room thuộc department | DB + app | LOCATION_HIERARCHY_MISMATCH |
| BR-006 | Price là integer minor unit, interval end-exclusive, không overlap | DB + app | PRICE_INTERVAL_OVERLAP |
| BR-007 | priceFrom không phải quote/final charge | Presenter/contract | N/A |
| BR-008 | Age/gender/audience tags chỉ dùng discovery | Policy | N/A |
| BR-009 | specialtyId là reference Doctor-owned | Boundary | SPECIALTY_REFERENCE_INVALID khi validation bật |
| BR-010 | Admin update yêu cầu If-Match version | App + DB | VERSION_CONFLICT |
| BR-011 | POST create dùng Idempotency-Key và payload hash | App + DB | IDEMPOTENCY_KEY_REUSED |
| BR-012 | Deactivate không xóa appointment lịch sử | Boundary/event | N/A |
| BR-013 | Slug cũ không tự tái cấp cho resource khác | App | SLUG_RESERVED |
| BR-014 | Rich text và URL được sanitize/validate | DTO/sanitizer | CONTENT_UNSAFE |
| BR-015 | Public filters/sort chỉ từ allowlist | DTO/query builder | VALIDATION_FAILED |

---

## 9. API contract đề xuất

### 9.1 Quy ước

- Gateway public prefix: /api/catalog.
- Service-local paths nằm ở bảng dưới.
- GET /health trả chính xác 200 với body status ok khi process sống.
- **[PROPOSAL]** GET /ready kiểm tra Catalog DB và trả 503 nếu chưa ready.
- Success business API có data và meta.requestId.
- Error có error.code, error.message, error.requestId và optional details an toàn.
- Cursor opaque; default limit 20, max 100.
- Timestamp ISO-8601 UTC.
- UUID dùng internal contract; slug dùng public lookup.

### 9.2 Endpoint summary

#### Public/read

| ID | Method | Service-local path | Mục đích | Auth |
|---|---|---|---|---|
| API-001 | GET | /health | Liveness | Public |
| API-002 | GET | /ready | Readiness | Internal/ops |
| API-003 | GET | /services | Search/filter/sort catalog | Public |
| API-004 | GET | /services/{idOrSlug} | Detail active service | Public |
| API-005 | GET | /categories | Active category tree/list | Public |
| API-006 | GET | /facilities | Active facilities | Public |
| API-007 | GET | /facilities/{facilityId}/departments | Active departments | Theo policy |
| API-008 | GET | /filters | Facet metadata/tag values | Public |

#### Admin/write

| ID | Method | Path | Mục đích |
|---|---|---|---|
| API-101 | POST | /admin/services | Tạo draft service |
| API-102 | PATCH | /admin/services/{serviceId} | Sửa service |
| API-103 | POST | /admin/services/{serviceId}/activate | Publish/activate |
| API-104 | POST | /admin/services/{serviceId}/deactivate | Ẩn khỏi catalog |
| API-105 | POST/PATCH | /admin/categories/... | Quản trị category |
| API-106 | POST/PATCH | /admin/tags/... | Quản trị tag |
| API-107 | POST/PATCH | /admin/facilities/... | Quản trị facility |
| API-108 | POST/PATCH | /admin/departments/... | Quản trị department |
| API-109 | POST/PATCH | /admin/rooms/... | Quản trị room |
| API-110 | POST/PATCH | /admin/offerings/... | Quản trị offering |
| API-111 | POST | /admin/offerings/{offeringId}/prices | Schedule base price |
| API-112 | POST | /admin/prices/{priceId}/cancel | Hủy price theo rule |

#### Internal

| ID | Method | Path | Consumer | Mục đích |
|---|---|---|---|---|
| API-201 | GET | /internal/services/{serviceId}/eligibility | Appointment | Service/offering/bookable/base price |
| API-202 | GET | /internal/offerings/{offeringId} | Appointment/Billing | Resolve snapshot fields |
| API-203 | GET | /internal/locations/rooms/{roomId} | Doctor/Medical | Resolve room hierarchy/status |
| API-204 | POST | /internal/services/resolve | Internal consumers | Batch resolve tối đa N IDs |

Không route /internal/* công khai trong Kong.

### 9.3 API-003 — Search, filter và sort

| Param | Type | Validation | Semantics |
|---|---|---|---|
| q | string | trim, 2–100 | name/code/normalized summary; accent-insensitive |
| categoryId | UUID | optional | Category; descendants khi includeChildren=true |
| facilityId | UUID | optional | Có active offering tại facility |
| specialtyId | UUID | optional | Exact Doctor-owned reference |
| kind | enum[] | bounded | OR trong nhóm |
| tagId | UUID[] | max 20 | OR trong group, AND giữa groups |
| gender | code | allowlist | Map tag, discovery only |
| age | int | 0–150 | Match min/max inclusive |
| audience | code[] | max 10 | Discovery tags |
| bookingEnabled | boolean | optional | Có offering bookable |
| minPrice/maxPrice | bigint string | >= 0 | Active price theo selection rule |
| sort | enum | relevance/name_asc/price_asc/price_desc/updated_desc | Deterministic |
| cursor | string | opaque | Client không parse |
| limit | int | 1–100 | default 20 |

Price selection rule:

- Có facilityId: dùng active base price của offering tại facility.
- Không có facilityId: priceFrom là minimum active base price trong active offerings.
- Không có active price: priceFrom null và xếp cuối ở cả hai chiều.
- Cursor mã hóa sort tuple và serviceId. Price sort dùng (priceIsNull, priceFrom, serviceId).

Response ví dụ:

~~~json
{
  "data": [
    {
      "id": "uuid",
      "code": "ANTENATAL_PACKAGE_12W_SINGLE",
      "slug": "goi-thai-san-12-tuan-thai-don",
      "name": "Gói thai sản 12 tuần thai đơn",
      "kind": "PACKAGE",
      "primaryCategory": { "id": "uuid", "name": "Thai sản" },
      "tags": [
        { "group": "AUDIENCE", "code": "PREGNANT_WOMEN", "label": "Phụ nữ có thai" }
      ],
      "priceFrom": { "amountMinor": "1000000", "currency": "VND" },
      "availableFacilityCount": 2,
      "thumbnailUrl": "https://cdn.example/catalog/item.jpg",
      "version": 3
    }
  ],
  "meta": {
    "nextCursor": "opaque-or-null",
    "limit": 20,
    "requestId": "uuid"
  }
}
~~~

### 9.4 API-004 — Detail

- UUID lookup dùng cho authenticated/internal tooling; slug lookup dùng public.
- Anonymous request tới DRAFT, INACTIVE hoặc ARCHIVED trả 404 để không leak unpublished content.
- Response có categories, tags và active offerings grouped by facility.
- Không trả room vận hành chi tiết, audit, internal notes, source payload hoặc raw metadata ngoài allowlist.
- Dùng ETag theo resource/version; hỗ trợ If-None-Match cho public read.

### 9.5 API-101 — Create service

- Caller: ADMIN cùng catalog:manage.
- Header Idempotency-Key bắt buộc, 1–128 ký tự.
- Tạo DRAFT; không public và không phát activated event.
- Body không nhận status, version, createdAt, updatedAt để chống mass assignment.
- Transaction: service, category/tag mapping, audit và idempotency record; outbox chỉ khi event transport được approve.

### 9.6 API-103 — Activate service

Preconditions:

- If-Match khớp version.
- Đúng một primary category active.
- Ít nhất một active offering; hierarchy hợp lệ.
- Có active/current hoặc scheduled base price nếu product policy bắt buộc giá.
- specialtyId đã validate/reconcile nếu field có giá trị và validation được bật.

Activate lặp khi đã ACTIVE trả current state, không tạo duplicate audit/event. Deactivate không gọi đồng bộ Appointment để sửa lịch cũ.

### 9.7 API-201 — Appointment eligibility

Query bắt buộc facilityId; optional at, mặc định server now.

~~~json
{
  "data": {
    "eligible": true,
    "reasonCode": null,
    "service": {
      "id": "uuid",
      "code": "ANTENATAL_PACKAGE_12W_SINGLE",
      "name": "Gói thai sản 12 tuần thai đơn",
      "kind": "PACKAGE",
      "specialtyId": "uuid-or-null",
      "version": 3
    },
    "offering": {
      "id": "uuid",
      "facilityId": "uuid",
      "departmentId": "uuid-or-null",
      "durationMinutes": 30,
      "version": 2
    },
    "basePrice": {
      "priceId": "uuid",
      "amountMinor": "1000000",
      "currency": "VND",
      "version": 1,
      "effectiveAt": "2026-09-08T13:00:00Z"
    }
  },
  "meta": { "requestId": "uuid" }
}
~~~

Appointment lưu snapshot ID/code/name, offering/facility, amount/currency và versions tại booking time. Catalog không giữ slot; eligibility này không thay Doctor/Appointment availability check.

### 9.8 Error catalog

| HTTP | Code | Khi nào |
|---:|---|---|
| 400 | VALIDATION_FAILED | Query/body/header sai |
| 400 | INVALID_CURSOR | Cursor sai hoặc không khớp sort/filter |
| 401 | UNAUTHENTICATED | Token thiếu/sai |
| 403 | FORBIDDEN | Sai role/permission/internal caller |
| 404 | SERVICE_NOT_FOUND | Không tồn tại hoặc không public |
| 404 | CATEGORY_NOT_FOUND / FACILITY_NOT_FOUND / OFFERING_NOT_FOUND | Reference không tồn tại |
| 409 | VERSION_CONFLICT | Optimistic lock conflict |
| 409 | IDEMPOTENCY_KEY_REUSED | Cùng key, khác payload |
| 409 | INVALID_STATE_TRANSITION | Lifecycle invalid |
| 409 | PRICE_INTERVAL_OVERLAP | Giá trùng effective period |
| 422 | SERVICE_NOT_PUBLISHABLE | Thiếu invariant activate |
| 422 | LOCATION_HIERARCHY_MISMATCH | Department/room sai parent |
| 422 | SPECIALTY_REFERENCE_INVALID | Specialty invalid khi validation bật |
| 503 | DEPENDENCY_UNAVAILABLE | Required dependency lỗi |
| 500 | INTERNAL_ERROR | Không leak stack hoặc SQL |

---

## 10. Flow chính

### 10.1 Public discovery

~~~mermaid
sequenceDiagram
    participant Client
    participant Kong
    participant Catalog
    participant DB as Catalog DB
    Client->>Kong: GET /api/catalog/services with filters
    Kong->>Catalog: Routed request + X-Request-Id
    Catalog->>DB: Query active catalog with allowlisted filters
    DB-->>Catalog: Rows + next cursor
    Catalog-->>Kong: data + meta
    Kong-->>Client: 200
~~~

Không gọi Doctor, Auth hoặc Appointment trong hot path public list. specialtyId là reference đã persist; public projection không enrich doctor list.

### 10.2 Appointment validate trước khi tạo

~~~mermaid
sequenceDiagram
    participant Appointment
    participant Catalog
    participant Doctor
    Appointment->>Catalog: Internal service eligibility by facility
    Catalog-->>Appointment: service/offering/base-price snapshot
    Appointment->>Doctor: Check doctor/specialty/availability
    Doctor-->>Appointment: Doctor eligibility
    Appointment->>Appointment: Create hold or appointment in own DB
~~~

Catalog không gọi Doctor để tính slot. Appointment orchestration kết hợp hai contract và sở hữu quyết định booking cuối cùng.

### 10.3 Admin publish

1. Verify JWT locally và enforce ADMIN policy.
2. Validate DTO, Idempotency-Key hoặc If-Match.
3. Validate local invariants trong transaction.
4. Nếu specialty validation bắt buộc, dùng bounded timeout tới Doctor internal contract; lỗi thì không publish.
5. Commit core state, audit và optional outbox.
6. Trả version mới; cache invalidation theo version/event.

---

## 11. Integrations và failure behavior

| Dependency/consumer | Operation | Required | Timeout/retry đề xuất | Failure behavior |
|---|---|---:|---|---|
| Auth/JWKS | Verify JWT offline/cache key | Yes cho protected API | JWKS cache như Patient; không gọi Auth mỗi request | 401/503 theo key availability |
| Doctor Service | Validate specialtyId lúc publish | **[OPEN]** | total 1s, tối đa 1 retry GET | Không publish nếu policy bắt buộc |
| Appointment Service | Consumer eligibility | Inbound | Consumer timeout <= 1s, retry bounded | Không tạo booking nếu chưa xác minh |
| Billing Service | Resolve base-price snapshot | Inbound | Batch/GET idempotent | Dùng persisted snapshot hoặc billing policy |
| Event transport | Publish changes | Chưa có | Outbox retry sau commit | Không rollback core state |
| CDN/media | Hiển thị image | Optional | Client/CDN policy | Core catalog vẫn đọc được |

Không query database của service khác. Không retry write không idempotent. Public list không phụ thuộc sync vào service khác.

### 11.1 Events đề xuất — gated

Repo chưa có broker được bật; đây là target contract, không phải transport hiện hành.

| Event | Consumer tiềm năng | Trigger |
|---|---|---|
| catalog.service.activated | Appointment/search cache/Audit | Service chuyển ACTIVE |
| catalog.service.updated | Appointment/Billing cache | Public/eligibility fields đổi |
| catalog.service.deactivated | Appointment | Ngừng nhận booking mới |
| catalog.offering.changed | Appointment | Facility availability hoặc bookingEnabled đổi |
| catalog.base_price.changed | Billing/Appointment | Effective price đổi |
| catalog.location.changed | Doctor/Medical | Department/room/facility đổi |

Envelope có eventId, eventType, eventVersion, occurredAt, correlationId, aggregateId, aggregateVersion và payload allowlist. Consumer dedupe theo eventId, bỏ stale aggregateVersion.

### 11.2 Consistency và recovery

- Local writes: transaction atomic.
- Cross-service: sync chỉ cho validation thật sự bắt buộc; propagation eventual.
- Concurrency: unique constraints, optimistic version và lock/constraint cho price interval.
- Partial event failure: transactional outbox sau khi broker được chọn.
- Reconciliation: report/job cho specialty references, active offering thiếu price và dangling location mapping.

---

## 12. Security, privacy và audit

### 12.1 Security

- Public read chỉ trả active field allowlist; không trả raw metadata, import payload hoặc internal notes.
- Admin/internal endpoints yêu cầu auth; service vẫn enforce authorization dù Kong đã authenticate.
- Không tin X-User-Id hoặc X-Role do client tự gửi.
- Validate issuer, audience, algorithm, kid, exp và jti theo JWT pattern hiện tại.
- DTO whitelist, transform và forbid unknown fields.
- Sanitize rich text để chặn stored XSS; không render HTML chưa sanitize.
- URL chỉ cho HTTPS và scheme allowlist; backend không fetch arbitrary URL để tránh SSRF.
- Giới hạn search length, filter count, ranges và pagination để chống query abuse.
- Rate limit public search ở Kong; admin write có rate thấp hơn và audit.
- Không log Authorization, JWT, secret, raw request body hoặc nội dung import dài.
- Catalog không chứa PHI; không thêm Patient ID hoặc pregnancy status vào search log.

### 12.2 Classification

| Dữ liệu | Classification | Log policy | Response |
|---|---|---|---|
| Service/category/price/facility public | Public/operational | Log ID/version, không log body | Public allowlist |
| Internal notes/import provenance | Internal | Redact content; log source/checksum | Admin only |
| Actor/account ID | PII/internal | Chỉ khi cần audit | Không public |
| Authorization/internal token | Secret | Không log | Không trả |
| Patient clinical attributes | PHI | Không đưa vào Catalog | N/A |

### 12.3 Audit

Audit create, update, activate, deactivate, archive, category/tag mapping, location, offering/price, import approve/reject và authorization denied. Metadata: actorId, resource type/id, action, old/new version, changed field names, requestId, timestamp; không lưu token hoặc full content.

---

## 13. Search, cache và observability

### 13.1 Search

- MVP dùng PostgreSQL; quy mô vài trăm đến vài nghìn item chưa cần search engine mới.
- Normalize Unicode, case và whitespace; accent-insensitive matching phải có test tiếng Việt.
- Relevance chỉ dùng khi có q; tie-break bằng normalized name và ID.
- Facet counts optional ở MVP; nếu trả phải áp cùng filter scope và giới hạn cardinality.
- Không cho client truyền arbitrary sort column hoặc raw query expression.

### 13.2 Cache

- Category/facility/filter metadata: ETag, TTL gợi ý 5 phút.
- Service list/detail: ETag, TTL gợi ý 30–60 giây; inactive phải invalidate.
- Internal eligibility: cache rất ngắn hoặc không cache nếu booking critical.
- Chưa thêm Redis; HTTP/in-process caching đủ cho MVP vì repo chưa vận hành Redis.

### 13.3 NFR đề xuất

| Concern | Requirement |
|---|---|
| Performance | P95 public list/detail < 300 ms ở tải mục tiêu |
| Availability | Stateless app; nhiều replica dùng chung Catalog DB khi cần |
| Reliability | Critical write atomic; no duplicate create/event; snapshots versioned |
| Scalability | Cursor pagination, indexed filters, batch internal resolve |
| Readiness | 503 khi DB không dùng được; liveness không gọi dependency |
| Backup | PostgreSQL backup/restore runbook trước production |
| Retention | Audit theo policy; idempotency TTL có cleanup |
| Observability | Structured logs, requestId, latency/error/business metrics |

### 13.4 Logs và metrics

Structured JSON logs gồm timestamp, level, service, route template, method, status, latencyMs, requestId/correlationId, actor/service identity khi phù hợp và error code. Không log raw q nếu có thể chứa dữ liệu cá nhân.

Metrics:

- request count, error và latency theo route template;
- search empty-result rate, limit rejection, slow query;
- active service/offering/facility counts;
- publish rejection theo reason;
- version conflict, idempotency conflict và price overlap;
- DB pool/readiness;
- outbox pending/failed nếu bật;
- stale/dangling reference reconciliation count.

---

## 14. Given–When–Then scenarios

### SCN-001 — Public search active services

~~~gherkin
Given có service ACTIVE và INACTIVE cùng category
When client public GET /services theo category
Then chỉ ACTIVE service có ACTIVE offering được trả
And response có cursor và requestId
~~~

### SCN-002 — Filter thai phụ chỉ là discovery

~~~gherkin
Given service có tag AUDIENCE=PREGNANT_WOMEN
When client filter audience=PREGNANT_WOMEN
Then service được đưa vào kết quả discovery
And hệ thống không đọc PregnancyProfile hoặc kết luận clinical eligibility
~~~

### SCN-003 — Sort giá khi nhiều facility

~~~gherkin
Given service có giá 2.000.000 tại A và 1.500.000 tại B
When client sort price_asc không truyền facilityId
Then priceFrom là 1.500.000
And cursor dùng tuple deterministic
~~~

### SCN-004 — Filter theo facility

~~~gherkin
Given service có offering tại A nhưng không có tại B
When client lọc facilityId=B
Then service không xuất hiện dù có price tại A
~~~

### SCN-005 — Publish thiếu offering

~~~gherkin
Given service DRAFT có primary category nhưng không có ACTIVE offering
When Admin activate với version đúng
Then API trả 422 SERVICE_NOT_PUBLISHABLE
And state/version không đổi, không có success event
~~~

### SCN-006 — Concurrent admin update

~~~gherkin
Given hai Admin đọc version 4
When Admin A update thành version 5 và Admin B update với If-Match 4
Then request B trả 409 VERSION_CONFLICT
And thay đổi của A không bị ghi đè
~~~

### SCN-007 — Duplicate create retry

~~~gherkin
Given POST đã commit nhưng response bị mất
When client retry cùng Idempotency-Key và payload
Then API trả cùng resource
And không tạo service, audit success hoặc event lần hai
~~~

### SCN-008 — Price interval overlap

~~~gherkin
Given offering có active VND price từ ngày 1 đến ngày 30
When Admin tạo price khác từ ngày 15 đến ngày 45
Then API trả 409 PRICE_INTERVAL_OVERLAP
And không có khoảng giá mơ hồ
~~~

### SCN-009 — Appointment snapshot

~~~gherkin
Given service và offering ACTIVE tại facility F
When Appointment gọi eligibility
Then Catalog trả service, offering, base-price IDs và versions
And Appointment lưu snapshot trước khi hoàn tất booking
~~~

### SCN-010 — Deactivate sau khi có appointment

~~~gherkin
Given đã có appointment hợp lệ dùng service S
When Admin deactivate S
Then booking mới nhận eligible=false
And Catalog không sửa hoặc xóa appointment cũ
And Appointment tự reconciliation theo policy của mình
~~~

### SCN-011 — Specialty reference unavailable

~~~gherkin
Given policy yêu cầu validate specialty khi publish
And Doctor Service không khả dụng sau bounded retry
When Admin activate service có specialtyId
Then API trả 503 DEPENDENCY_UNAVAILABLE
And service không chuyển ACTIVE
~~~

### SCN-012 — Stored XSS

~~~gherkin
Given Admin gửi description chứa script hoặc event handler
When tạo hoặc sửa service
Then input bị reject hoặc sanitize theo policy
And public API không phát nội dung executable
~~~

---

## 15. Edge cases

| ID | Case | Expected behavior |
|---|---|---|
| EDGE-001 | q chỉ có khoảng trắng hoặc 1 ký tự | 400 |
| EDGE-002 | Unknown filter/sort | 400, không forward raw sort |
| EDGE-003 | Cursor sai/tampered hoặc dùng với sort khác | INVALID_CURSOR |
| EDGE-004 | Category parent cycle | 422, không write |
| EDGE-005 | Category inactive nhưng service active | Không public qua category; remediation alert |
| EDGE-006 | Offering facility active, department inactive | Không eligible; alert/reconciliation |
| EDGE-007 | Room thuộc department khác | Hierarchy mismatch |
| EDGE-008 | effectiveTo bằng effectiveFrom | Invalid range |
| EDGE-009 | Hai price create race | Một commit, một conflict |
| EDGE-010 | Service không có giá | priceFrom null; booking theo policy |
| EDGE-011 | Slug đổi | URL cũ 404 ở MVP; alias future |
| EDGE-012 | Duplicate event | Consumer dedupe eventId |
| EDGE-013 | Stale event sau event mới | Ignore theo aggregateVersion |
| EDGE-014 | Thumbnail/CDN down | Core API vẫn 2xx; UI fallback |
| EDGE-015 | Doctor specialty deactivated | Reconciliation; không duplicate master |
| EDGE-016 | External source thay nội dung | Staging + diff + manual approve |
| EDGE-017 | Amount vượt JS safe integer | API trả amountMinor dạng string |
| EDGE-018 | Age ranges overlap | OR semantics; boundary phải được ghi rõ |
| EDGE-019 | 30–50 và 50+ cùng match 50 | Chốt taxonomy; khuyến nghị 30–49 hoặc intentional overlap |

---

## 16. Import và data provenance — optional, approval required

Không nằm trong core MVP. Nếu có nguồn dữ liệu hợp pháp:

1. Adapter tải API/file được cấp phép với rate limit và allowlist domain.
2. Staging record có source, externalId, sourceUrl, fetchedAt, checksum, raw schema version và parser version.
3. Normalize vào draft; không dùng external ID làm internal PK.
4. Validate duplicate code/slug/category/facility/price/hierarchy.
5. Admin review diff và approve.
6. Chỉ publish qua cùng lifecycle và business rules.
7. Ghi audit/provenance; hỗ trợ dry-run và retry idempotent.

Không tự động xóa hoặc inactive local record chỉ vì upstream tạm thiếu. Không ingest PII, customer, order hoặc session data. Không lưu publishable key, cookie hoặc Cloudflare token trong repository.

**[PROPOSAL]** Snapshot Vinmec của nghiên cứu này không được tạo thành seed file để tránh stale data, licensing issue và coupling với ID bên thứ ba.

---

## 17. Testing và acceptance

### 17.1 Minimum tests

- Health/readiness và DB down behavior.
- Public projection không leak draft/internal fields.
- JWT validation, ADMIN authorization và internal auth.
- Unknown DTO fields, XSS/URL validation và mass assignment.
- Code/slug uniqueness và Unicode normalization.
- Category hierarchy, cycle và primary invariant.
- Facility/department/room hierarchy.
- Search tiếng Việt có/không dấu; filter OR/AND semantics.
- Cursor cho name, price, relevance, null price và invalid cursor.
- Price effective boundary, overlap và concurrent create.
- Publish/deactivate lifecycle, idempotency và optimistic lock.
- Appointment eligibility snapshot contract.
- Required/optional dependency failures.
- Duplicate/stale event và outbox recovery nếu events được bật.
- Logs không chứa token, raw body hoặc PHI.
- OpenAPI và database contract tests.

### 17.2 Acceptance criteria

- AC-001: Patient tìm active service theo category, facility và audience với pagination deterministic.
- AC-002: Admin không publish được service thiếu primary category hoặc active offering.
- AC-003: Hai Admin không gây lost update.
- AC-004: Không có hai effective base price overlap cho một offering/currency.
- AC-005: Appointment resolve được snapshot mà không query Catalog DB trực tiếp.
- AC-006: Catalog không sở hữu hoặc duplicate Specialty, Doctor, Appointment hoặc Billing state.
- AC-007: Internal routes không public và có service authentication đã approve.
- AC-008: Public response không chứa unpublished, import hoặc internal metadata.

---

## 18. Implementation plan đề xuất

> Chỉ thực hiện sau khi Open Questions ảnh hưởng contract được approve.

| Phase | Mục tiêu | Files/modules dự kiến | DB/infra | Verify |
|---|---|---|---|---|
| 0 | Chốt contract | Spec này + OpenAPI | Chốt port, DB, auth | Design review |
| 1 | Foundation | Nest app, config, health/ready, request ID, envelope | Catalog PostgreSQL + Prisma | Build/lint/unit/health |
| 2 | Core catalog | services/categories/tags/facilities/location | Core tables/indexes | Unit + PostgreSQL integration |
| 3 | Offering/price/search | offering/price/search | Price interval constraint | Boundary/concurrency/query tests |
| 4 | Security/admin/internal | JWT/RBAC/internal auth/idempotency/audit | audit/idempotency | Authz/contract/E2E |
| 5 | Integration | Appointment/Doctor contracts; optional outbox | Kong/Compose/env | Failure/retry/acceptance |
| 6 | Operations | dashboards/runbook/backup/reconciliation | Alerts/jobs | Load/restore tests |

Files dự kiến khi implement, **không tạo trong task docs này**:

- services/apps/service-catalog-service/**
- services/prisma/catalog/schema.prisma và migrations
- docs/api-specs/service-catalog-service.yaml
- blocks trong docker-compose.yml, .env.example, services/nest-cli.json và services/package.json
- Catalog route trong docs/api-specs/kong.yml
- README, SETUP và operations runbook

Không cần framework, ORM, search engine, cache hoặc broker mới cho core MVP.

---

## 19. Assumptions và Open Questions

### 19.1 Assumptions của draft

- Catalog là service độc lập thay vì tạm gộp Appointment.
- Reuse PostgreSQL, NestJS và Prisma.
- Specialty tiếp tục thuộc Doctor Service.
- Giá mặc định VND và lưu integer minor unit.
- Public catalog được anonymous read; write chỉ ADMIN.
- Facility/Department/Room là operational catalog, không phải HR/asset management.
- Catalog không xử lý order/payment dù nguồn tham khảo có ecommerce concepts.

### 19.2 Open questions phải chốt

1. **[OPEN] Service boundary:** triển khai Catalog ngay hay gộp basic lookup vào Appointment ở MVP như tài liệu quy hoạch cho phép?
2. **[OPEN] Facility ownership:** Catalog chính thức sở hữu Facility hay sẽ có Organization/Facility Service riêng?
3. **[OPEN] Department/Room:** cần trong MVP hay chỉ Facility + Offering? Doctor schema đã có reference nên owner cần được chốt.
4. **[OPEN] Specialty validation:** Doctor Service cần internal lookup/event nào? Hiện chưa có contract specialty lookup thống nhất.
5. **[OPEN] Internal authentication:** internal JWT per audience, shared-secret interim hay phương án khác?
6. **[OPEN] Price semantics:** giá có bắt buộc khi publish, đã gồm thuế chưa, theo facility hay thêm payer/segment?
7. **[OPEN] Package composition:** model item/xét nghiệm thành phần trong MVP hay structured description là đủ?
8. **[OPEN] Service type:** “khám thường/khám dịch vụ” là kind, tag, offering tier hay appointment type?
9. **[OPEN] Public auth:** Anonymous được đọc catalog hay yêu cầu PATIENT login?
10. **[OPEN] Event transport:** repo chưa bật broker; chọn transport trước outbox dispatcher.
11. **[OPEN] Content/media:** ai sở hữu ảnh/rich content; lưu URL hay cần Media Service?
12. **[OPEN] External data rights:** có thỏa thuận API/export từ Vinmec hay nguồn nào khác không?
13. **[OPEN] Port/schema naming:** xác nhận app 5007, dev DB 5437, Prisma path và env variable names.
14. **[OPEN] Age boundary:** taxonomy 30–50 và 50+ quan sát có overlap ở tuổi 50; phải định nghĩa rõ.

### 19.3 Out of scope

- Implementation, migration, OpenAPI, Kong hoặc Compose changes.
- Production deployment hoặc data migration.
- Sao chép toàn bộ catalog, nội dung, ảnh hoặc giá Vinmec.
- Ecommerce order, cart hoặc payment.
- Recommendation engine dựa trên PHI.
- Search cluster, Redis hoặc broker khi chưa cần/approve.
- Promotion, insurance contract, dynamic pricing và final billing.

### 19.4 Approval

- **Status:** Draft
- **Approved by / Date:** Chưa có
- **Decision gates:** boundary, Facility owner, internal auth, price/package semantics, data licensing

> Mọi thay đổi boundary, public/internal API, database schema, event contract hoặc security model phải cập nhật spec và OpenAPI trước implementation.

---

## 20. Kết luận

Service Catalog Service nên là read-heavy bounded context độc lập, sở hữu catalog, location, offering và base price nhưng không lấn sang Doctor, Appointment hoặc Billing. Mô hình MedicalService → ServiceOffering → BasePrice cùng category, tag và facility giải quyết các chiều dữ liệu quan sát từ Vinmec: category, cơ sở, đối tượng, giới tính, độ tuổi và sort giá, trong khi vẫn dùng stack hiện có.

Kết quả crawl chứng minh taxonomy đa chiều là cần thiết, nhưng không phải bằng chứng cho phép sao chép dữ liệu hoặc contract kỹ thuật của Vinmec. Hướng an toàn là dùng kết quả làm input thiết kế, xây dữ liệu nội bộ có owner rõ, và chỉ bổ sung ingestion khi có nguồn được cấp phép.
