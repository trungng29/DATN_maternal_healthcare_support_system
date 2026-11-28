import { ConfigService } from '@nestjs/config';
import { status } from '@grpc/grpc-js';
import { GrpcClientFactory } from '@platform';
import { AppointmentDependencyGateway } from './dependency.gateway';

describe('booking offering dependency errors', () => {
  it.each([
    [status.FAILED_PRECONDITION, 'BOOKING_DISABLED', 409, 'BOOKING_DISABLED'],
    [status.FAILED_PRECONDITION, 'OTHER', 503, undefined],
    [status.UNAVAILABLE, 'BOOKING_DISABLED', 503, undefined],
    [status.DEADLINE_EXCEEDED, 'deadline', 503, undefined],
  ])('maps gRPC %s %s to HTTP %s', async (code, details, http, domainCode) => {
    const grpc = {
      client: jest.fn(),
      metadata: jest.fn(),
      unary: jest.fn().mockRejectedValue({ code, details }),
    } as unknown as GrpcClientFactory;
    const gateway = new AppointmentDependencyGateway(new ConfigService(), grpc);
    const request = gateway.offering('test-service', 'BASIC', new Date(), {});

    await expect(request).rejects.toMatchObject(
      domainCode ? { status: http, code: domainCode } : { status: http },
    );
  });
});
