import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User } from './entities/user.entity';
import { AuditLog } from './entities/audit-log.entity';
import { CreateUserDto, UpdateUserDto, QueryUsersDto } from './users.dto';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(AuditLog)
    private readonly auditLogRepo: Repository<AuditLog>,
  ) {}

  // ─── Helper: Audit ───────────────────────────────────────────────
  private async logAudit(
    actorId: string,
    action: string,
    targetId?: string,
    details?: Record<string, any>,
    ipAddress?: string,
  ) {
    await this.auditLogRepo.save(
      this.auditLogRepo.create({
        userId: actorId,
        action,
        targetId,
        details,
        ipAddress,
      }),
    );
  }

  // ─── Find All (paginated) ────────────────────────────────────────
  async findAll(query: QueryUsersDto) {
    const { page = 1, limit = 20, role, search } = query;
    const where: any = {};
    if (role) where.role = role;
    if (search) {
      // Search by fullName or email
      const [data, total] = await this.userRepo.findAndCount({
        where: [
          { ...where, fullName: ILike(`%${search}%`) },
          { ...where, email: ILike(`%${search}%`) },
        ],
        select: ['id', 'email', 'fullName', 'phoneNumber', 'role', 'isActive', 'createdAt'],
        order: { createdAt: 'DESC' },
        skip: (page - 1) * limit,
        take: limit,
      });
      return {
        data,
        meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
      };
    }
    const [data, total] = await this.userRepo.findAndCount({
      where,
      select: ['id', 'email', 'fullName', 'phoneNumber', 'role', 'isActive', 'createdAt'],
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  // ─── Find One ────────────────────────────────────────────────────
  async findOne(id: string) {
    const user = await this.userRepo.findOne({
      where: { id },
      select: ['id', 'email', 'fullName', 'phoneNumber', 'role', 'isActive', 'createdAt', 'updatedAt'],
    });
    if (!user) throw new NotFoundException(`User không tồn tại`);
    return user;
  }

  // ─── Create User (Admin) ─────────────────────────────────────────
  async create(actorId: string, dto: CreateUserDto, ipAddress?: string) {
    const existing = await this.userRepo.findOne({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException('Email đã được sử dụng');
    }
    const hashed = await bcrypt.hash(dto.password, 10);
    const user = await this.userRepo.save(
      this.userRepo.create({ ...dto, password: hashed }),
    );
    await this.logAudit(actorId, 'CREATE_USER', user.id, { email: user.email, role: user.role }, ipAddress);
    const { password, ...result } = user;
    return result;
  }

  // ─── Update User (Admin) ─────────────────────────────────────────
  async update(
    actorId: string,
    targetId: string,
    dto: UpdateUserDto,
    ipAddress?: string,
  ) {
    // Admin không thể tự khóa hoặc thay đổi role của chính mình
    if (actorId === targetId && (dto.isActive === false || dto.role)) {
      throw new ForbiddenException(
        'Không thể khóa hoặc thay đổi role của chính mình',
      );
    }
    const user = await this.findOne(targetId);
    const changes: Record<string, any> = {};
    if (dto.fullName !== undefined) changes.fullName = dto.fullName;
    if (dto.phoneNumber !== undefined) changes.phoneNumber = dto.phoneNumber;
    if (dto.role !== undefined) changes.role = dto.role;
    if (dto.isActive !== undefined) changes.isActive = dto.isActive;

    await this.userRepo.update(targetId, changes);
    await this.logAudit(actorId, dto.isActive === false ? 'DEACTIVATE_USER' : 'UPDATE_USER', targetId, changes, ipAddress);
    return this.findOne(targetId);
  }
}
