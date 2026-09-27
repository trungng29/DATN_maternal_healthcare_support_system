import { Module } from '@nestjs/common';
import { CatalogAdminController } from './catalog-admin.controller';
import { CatalogInternalController } from './catalog-internal.controller';
import { CatalogPublicController } from './catalog-public.controller';
import { CatalogService } from './catalog.service';

@Module({
  controllers: [CatalogPublicController, CatalogAdminController, CatalogInternalController],
  providers: [CatalogService],
})
export class CatalogModule {}
