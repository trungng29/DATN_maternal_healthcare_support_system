import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { User } from '../users/entities/user.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { AuditLog } from '../users/entities/audit-log.entity';
import { Role } from '@app/common';
import {
  RegisterDto,
  LoginDto,
  RefreshTokenDto,
  LogoutDto,
  UpdateProfileDto,
  ChangePasswordDto,
} from './auth.dto';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(RefreshToken)
    private readonly refreshTokenRepo: Repository<RefreshToken>,
    @InjectRepository(AuditLog)
    private readonly auditLogRepo: Repository<AuditLog>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  // ─── Helpers ────────────────────────────────────────────────────
  private async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, 10);
  }

  private async generateTokens(user: User) {
    const payload = { sub: user.id, email: user.email, role: user.role };
    const accessToken = this.jwtService.sign(payload, {
      secret: this.configService.get<string>('app.jwtSecret'),
      expiresIn: this.configService.get<string>('app.jwtExpiration'),
    });
    const refreshTokenValue = uuidv4();
    const refreshExpiration = this.configService.get<string>(
      'app.jwtRefreshExpiration',
    );
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7); // 7 days

    await this.refreshTokenRepo.save(
      this.refreshTokenRepo.create({
        token: refreshTokenValue,
        userId: user.id,
        expiresAt,
      }),
    );
    return { accessToken, refreshToken: refreshTokenValue };
  }

  private async logAudit(
    userId: string | null,
    action: string,
    targetId?: string,
    details?: Record<string, any>,
    ipAddress?: string,
  ) {
    await this.auditLogRepo.save(
      this.auditLogRepo.create({ userId, action, targetId, details, ipAddress }),
    );
  }

  // ─── Register ───────────────────────────────────────────────────
  async register(dto: RegisterDto, ipAddress?: string) {
    const existing = await this.userRepo.findOne({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException('Email đã được sử dụng');
    }
    const hashed = await this.hashPassword(dto.password);
    const user = await this.userRepo.save(
      this.userRepo.create({
        email: dto.email,
        password: hashed,
        fullName: dto.fullName,
        phoneNumber: dto.phoneNumber,
        role: Role.PATIENT,
      }),
    );
    await this.logAudit(user.id, 'REGISTER', null, { email: user.email }, ipAddress);
    const { password, ...result } = user;
    return result;
  }

  // ─── Login ──────────────────────────────────────────────────────
  async login(dto: LoginDto, ipAddress?: string) {
    const user = await this.userRepo.findOne({ where: { email: dto.email } });
    if (!user || !(await bcrypt.compare(dto.password, user.password))) {
      throw new UnauthorizedException('Email hoặc mật khẩu không đúng');
    }
    if (!user.isActive) {
      throw new UnauthorizedException('Tài khoản đã bị khóa');
    }
    const tokens = await this.generateTokens(user);
    await this.logAudit(user.id, 'LOGIN', null, { email: user.email }, ipAddress);
    return {
      ...tokens,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
      },
    };
  }

  // ─── Refresh Token ──────────────────────────────────────────────
  async refreshToken(dto: RefreshTokenDto) {
    const stored = await this.refreshTokenRepo.findOne({
      where: { token: dto.refreshToken },
      relations: ['user'],
    });
    if (!stored) {
      throw new UnauthorizedException('Refresh token không hợp lệ');
    }
    if (stored.expiresAt < new Date()) {
      await this.refreshTokenRepo.remove(stored);
      throw new UnauthorizedException('Refresh token đã hết hạn');
    }
    if (!stored.user.isActive) {
      throw new UnauthorizedException('Tài khoản đã bị khóa');
    }
    // Token rotation: remove old, issue new
    await this.refreshTokenRepo.remove(stored);
    return this.generateTokens(stored.user);
  }

  // ─── Logout ─────────────────────────────────────────────────────
  async logout(userId: string, dto: LogoutDto) {
    const token = await this.refreshTokenRepo.findOne({
      where: { token: dto.refreshToken, userId },
    });
    if (token) {
      await this.refreshTokenRepo.remove(token);
    }
    await this.logAudit(userId, 'LOGOUT');
    return { message: 'Logged out successfully' };
  }

  // ─── Get Profile ─────────────────────────────────────────────────
  async getMe(userId: string) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();
    const { password, ...result } = user;
    return result;
  }

  // ─── Update Profile ──────────────────────────────────────────────
  async updateMe(userId: string, dto: UpdateProfileDto) {
    await this.userRepo.update(userId, dto);
    return this.getMe(userId);
  }

  // ─── Change Password ─────────────────────────────────────────────
  async changePassword(userId: string, dto: ChangePasswordDto, ipAddress?: string) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!(await bcrypt.compare(dto.currentPassword, user.password))) {
      throw new UnauthorizedException('Mật khẩu hiện tại không đúng');
    }
    const hashed = await this.hashPassword(dto.newPassword);
    await this.userRepo.update(userId, { password: hashed });
    // Revoke all refresh tokens on password change
    await this.refreshTokenRepo.delete({ userId });
    await this.logAudit(userId, 'CHANGE_PASSWORD', null, {}, ipAddress);
    return { message: 'Password changed successfully' };
  }
}
