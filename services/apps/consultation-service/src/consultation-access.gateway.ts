import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GrpcClientFactory, type PublicAuthContext } from '@platform';

@Injectable()
export class ConsultationAccessGateway {
  constructor(private readonly config: ConfigService, private readonly grpc: GrpcClientFactory) {}
  async assertPatientOwner(patientId: string, auth: PublicAuthContext): Promise<void> {
    if (auth.role !== 'PATIENT') return;
    const client = this.grpc.client({
      key: 'patient',
      target: this.config.get<string>('PATIENT_GRPC_TARGET') ?? 'patient-service:6004',
      proto: 'patient/v1/patient_internal.proto',
      package: 'maternal.patient.v1',
      service: 'PatientInternalService',
    });
    const context = { requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), actorAccountId: auth.userId, actorRole: auth.role };
    const response = await this.grpc.unary<any, any>(
      client,
      'getPatientEligibility',
      { context, patientId },
      this.grpc.metadata('patient-service', ['patient:eligibility:read'], context),
    );
    if (!response.callerOwnsPatient) throw new ForbiddenException('PATIENT_OWNERSHIP_MISMATCH');
  }
}
