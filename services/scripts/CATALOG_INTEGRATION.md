# Khởi tạo và cập nhật bộ dữ liệu demo Tâm An

## Database development mới

Chạy `scripts/setup.ps1 -Mode Docker` để chạy migrations, nạp dữ liệu demo và khởi động các ứng dụng. Mode Local chạy chung bộ migrations và seed, sau đó cho phép chạy từng ứng dụng Node riêng. Cả hai hỗ trợ `-NoSeed`. Compose dùng mạng và volume theo tên project. Đặt tên project và cổng riêng cho mỗi môi trường.

Seed kiểm tra cả 16 PostgreSQL local đã chạy Prisma migrations. Kịch bản nhận diện tập dữ liệu nền đã khởi tạo với mã 3. Nếu có lịch sử vận hành hoặc dữ liệu seed dở dang trong khi thiếu bảng dữ liệu nền, mã 4 dừng setup. Seed giữ lock bảng đến bước commit của từng database. Commit không nguyên tử xuyên database. Sau khi có lỗi commit, giữ writers dừng và kiểm tra từng database trước khi khôi phục từ backup hoặc dựng project demo mới.

Setup lấy URL seed từ thông tin kết nối và cổng PostgreSQL của project Compose đã chọn, rồi chỉ cấp cho tiến trình seed. Khi gọi qua npm hoặc Makefile, cung cấp đủ 16 biến `*_DATABASE_URL` loopback và cấu hình mã hóa development. Prisma db seed là tác vụ nạp vai trò nền riêng.

5 ảnh chuyên khoa được ánh xạ theo code ở frontend. 36 ảnh khác có secure_url trong seed. Không cần credential Cloudinary để đọc URL công khai đã nghiệm thu. Hệ thống đánh dấu ảnh và nhân sự là minh họa demo. Clinical review vẫn NOT_RUN.

## Database development đã có dữ liệu

Chỉ dùng services/scripts/integrate-reviewed-catalog.cjs từ thư mục services. Tạo tập tin JSON riêng tư bên ngoài repository và gói review với sáu khóa `doctor`, `receptionist`, `catalog`, `appointment`, `billing`, `medical-record`, mỗi khóa là URL PostgreSQL local tương ứng. Đặt đường dẫn vào TAMAN_MIGRATION_URLS_FILE.

1. Backup các database có liên quan và thử restore. Đối chiếu mã, UUID, chính sách, giá, metadata và phiên bản hiện có. Ghi checksum/tổng đếm lịch sử mà không xuất dữ liệu bệnh nhân.
2. Chạy node scripts/integrate-reviewed-catalog.cjs --dry-run. Script báo fingerprint và tổng thao tác. Nếu có lịch, hóa đơn hoặc hold mở liên quan, mã thoát 3 và không ghi DB. Đơn vị cập nhật là toàn bộ danh mục đã review.
3. Khi không còn xung đột, dừng app, job và pool kết nối của sáu database trong cửa sổ bảo trì. Chạy lại dry-run ngay trước apply. Chạy node scripts/integrate-reviewed-catalog.cjs --apply --maintenance --expected <fingerprint> --journal <đường-dẫn-riêng>. Script kiểm session khác, khóa bảng, xác minh fingerprint, trạng thái, giá hiện hành, chính sách hạng, tham chiếu và giá trị từng hàng.
4. Nếu commit giữa các database bị gián đoạn, giữ cửa sổ bảo trì. Dùng node scripts/integrate-reviewed-catalog.cjs --rollback --maintenance --journal <đường-dẫn-riêng>. Script kiểm DB đích, phiên bản source, xung đột và cả tham chiếu lịch sử trước khi gỡ thực thể được tạo mới. Journal đảo từng thay đổi nếu hàng còn trạng thái đã biết. Nếu có chỉnh sửa sau apply, dừng để đối chiếu và giữ lịch sử.
5. Kiểm API, UI, giá, hạng, lịch và checksum lịch sử trước khi mở lại writers. Bảo toàn UUID dịch vụ giữ lại, tài khoản, nhân sự và lịch sử. Năm mục cũ và khoa Hiếm muộn giữ bản ghi ở trạng thái INACTIVE nếu đạt preflight. Giữ năm dịch vụ mới và MM_PREECLAMPSIA_SCREEN ở ACTIVE / bookingEnabled=false để review danh mục mà chưa tiếp nhận đặt.

Hai gói sinh tiếp tục đi theo luồng xác nhận của bộ phận dịch vụ. Clinical review phải làm riêng. Chưa sync semantic index và chưa chuyển alias Tier 2.
