import { NestFactory } from '@nestjs/core';
import { configureCatalogApp } from './app-bootstrap';
import { ServiceCatalogModule } from './service-catalog.module';

async function bootstrap() {
  const app = await NestFactory.create(ServiceCatalogModule);
  configureCatalogApp(app);
  await app.listen(process.env.PORT ?? 5007);
}
void bootstrap();
