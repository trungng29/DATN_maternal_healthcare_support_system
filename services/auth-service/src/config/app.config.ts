import { registerAs } from '@nestjs/config';

export default registerAs('app', () => ({
  port: parseInt(process.env.PORT || '3000', 10),
  jwtSecret: process.env.JWT_SECRET || 'default-secret-change-in-production',
  jwtExpiration: process.env.JWT_EXPIRATION || '3600s',
  jwtRefreshSecret:
    process.env.JWT_REFRESH_SECRET || 'default-refresh-secret-change-in-production',
  jwtRefreshExpiration: process.env.JWT_REFRESH_EXPIRATION || '7d',
}));
