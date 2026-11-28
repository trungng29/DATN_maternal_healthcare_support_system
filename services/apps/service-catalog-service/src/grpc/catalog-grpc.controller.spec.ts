import { HttpStatus } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { CatalogService } from '../catalog/catalog.service';
import { DomainException } from '../common/domain.exception';
import { CatalogGrpcController } from './catalog-grpc.controller';

describe('CatalogGrpcController booking eligibility', () => {
  it('returns a stable gRPC precondition for a closed booking', async () => {
    const catalog = {
      resolveEligibility: jest.fn().mockRejectedValue(
        new DomainException('BOOKING_DISABLED', 'Closed', HttpStatus.CONFLICT),
      ),
    } as unknown as CatalogService;
    const result = await new CatalogGrpcController(catalog)
      .resolveBookingOffering({ serviceId: 'test-service' })
      .catch((error: unknown) => error);
    expect(result).toBeInstanceOf(RpcException);
    expect((result as RpcException).getError()).toEqual({
      code: status.FAILED_PRECONDITION,
      message: 'BOOKING_DISABLED',
    });
  });
});
