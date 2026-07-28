import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { UsersService } from './users.service';
import { CreateUserDto, QueryUsersDto, UpdateUserDto } from './users.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser, Role, Roles } from '@app/common';

@ApiTags('Admin - Users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('auth/admin/users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @ApiOperation({ summary: '[Admin] Danh sách tất cả người dùng (phân trang)' })
  @ApiResponse({ status: 200, description: 'Trả về danh sách user có phân trang' })
  findAll(@Query() query: QueryUsersDto) {
    return this.usersService.findAll(query);
  }

  @Get(':userId')
  @ApiOperation({ summary: '[Admin] Xem chi tiết một người dùng' })
  @ApiResponse({ status: 404, description: 'User không tồn tại' })
  findOne(@Param('userId', ParseUUIDPipe) userId: string) {
    return this.usersService.findOne(userId);
  }

  @Post()
  @ApiOperation({ summary: '[Admin] Tạo tài khoản nhân sự (DOCTOR, NURSE, RECEPTIONIST)' })
  @ApiResponse({ status: 201, description: 'Tạo tài khoản thành công' })
  @ApiResponse({ status: 409, description: 'Email đã tồn tại' })
  create(
    @CurrentUser() actor: { id: string },
    @Body() dto: CreateUserDto,
    @Req() req: Request,
  ) {
    return this.usersService.create(actor.id, dto, req.ip);
  }

  @Patch(':userId')
  @ApiOperation({ summary: '[Admin] Cập nhật thông tin / Khóa-mở khóa tài khoản' })
  @ApiResponse({ status: 403, description: 'Không thể khóa hoặc thay đổi role của chính mình' })
  @ApiResponse({ status: 404, description: 'User không tồn tại' })
  update(
    @CurrentUser() actor: { id: string },
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateUserDto,
    @Req() req: Request,
  ) {
    return this.usersService.update(actor.id, userId, dto, req.ip);
  }
}
