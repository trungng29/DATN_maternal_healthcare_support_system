import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { getRepositoryToken } from '@nestjs/typeorm';
import { User } from './users/entities/user.entity';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { Role } from '@app/common';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const userRepo = app.get<Repository<User>>(getRepositoryToken(User));

  console.log('🌱 Bắt đầu seeding dữ liệu (Seed Users)...');

  const password = await bcrypt.hash('Password123', 10);

  const users = [
    {
      email: 'admin@example.com',
      fullName: 'System Admin',
      phoneNumber: '0900000001',
      role: Role.ADMIN,
      password,
    },
    {
      email: 'doctor@example.com',
      fullName: 'Doctor John Doe',
      phoneNumber: '0900000002',
      role: Role.DOCTOR,
      password,
    },
    {
      email: 'nurse@example.com',
      fullName: 'Nurse Jane',
      phoneNumber: '0900000003',
      role: Role.NURSE,
      password,
    },
    {
      email: 'receptionist@example.com',
      fullName: 'Receptionist Mary',
      phoneNumber: '0900000004',
      role: Role.RECEPTIONIST,
      password,
    },
    {
      email: 'patient@example.com',
      fullName: 'Patient Bob',
      phoneNumber: '0900000005',
      role: Role.PATIENT,
      password,
    },
  ];

  for (const u of users) {
    const existing = await userRepo.findOne({ where: { email: u.email } });
    if (!existing) {
      await userRepo.save(userRepo.create(u));
      console.log(`✅ Đã tạo user: ${u.email} (Role: ${u.role})`);
    } else {
      console.log(`⚠️ User đã tồn tại, bỏ qua: ${u.email}`);
    }
  }

  console.log('🎉 Seeding hoàn tất!');
  await app.close();
}

bootstrap().catch((err) => {
  console.error('❌ Lỗi khi seeding:', err);
  process.exit(1);
});
