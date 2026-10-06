import { Controller, UseGuards } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { ServiceCallers, ServiceJwtGuard, ServiceScopes } from '@platform';
import { PatientsService } from '../patients/patients.service';

@Controller()
@UseGuards(ServiceJwtGuard)
export class PatientGrpcController {
  constructor(private readonly patients: PatientsService) {}

  @GrpcMethod('PatientInternalService', 'GetPatientEligibility')
  @ServiceCallers('appointment-service')
  @ServiceScopes('patient:eligibility:read')
  getPatientEligibility(request: { patientId: string; context?: { actorAccountId?: string } }) {
    return this.patients.getEligibility(
      request.patientId,
      request.context?.actorAccountId,
    );
  }

  @GrpcMethod('PatientInternalService', 'GetPatientIdentity')
  @ServiceCallers('receptionist-service', 'medical-record-service')
  @ServiceScopes('patient:identity:read')
  async getPatientIdentity(request: { patientId: string; purpose?: string }) {
    return { patient: await this.patients.getInternalIdentity(request.patientId, request.purpose ?? 'CLINICAL') };
  }

  @GrpcMethod('PatientInternalService', 'SearchPatients')
  @ServiceCallers('receptionist-service')
  @ServiceScopes('patient:search')
  searchPatients(request: { normalizedPhone?: string; page?: { pageSize?: number; pageToken?: string } }) {
    return this.patients.searchInternal(request.normalizedPhone, request.page?.pageSize, request.page?.pageToken);
  }
}
