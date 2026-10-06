import { Body, Controller, ForbiddenException, Get, Param, Post, UseGuards } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import {
  CurrentAuth,
  PublicHttp,
  PublicJwtGuard,
  ServiceJwtGuard,
  ServiceScopes,
  type PublicAuthContext,
} from '@platform';
import { ConsultationAccessGateway } from './consultation-access.gateway';
import { ConsultationService } from './consultation.service';

@Controller()
export class ConsultationController {
  constructor(private readonly service: ConsultationService, private readonly access: ConsultationAccessGateway) {}
  @PublicHttp() @Get('health') health(){ return {status:'ok'}; }

  @UseGuards(PublicJwtGuard)
  @Post('consultations')
  async create(@Body() request:any, @CurrentAuth() auth:PublicAuthContext){
    if (!['PATIENT','RECEPTIONIST','ADMIN'].includes(auth.role)) throw new ForbiddenException('FORBIDDEN');
    await this.access.assertPatientOwner(request.patientId, auth);
    return this.service.create({...request, actorId:auth.userId});
  }

  @UseGuards(PublicJwtGuard)
  @Post('consultations/:id/assign')
  assign(@Param('id') id:string,@Body() request:any,@CurrentAuth() auth:PublicAuthContext){
    if (!['RECEPTIONIST','ADMIN'].includes(auth.role)) throw new ForbiddenException('FORBIDDEN');
    return this.service.assign(id,request.doctorId,auth.userId);
  }

  @UseGuards(PublicJwtGuard)
  @Post('consultations/:id/messages')
  async message(@Param('id') id:string,@Body() request:any,@CurrentAuth() auth:PublicAuthContext){
    await this.service.authorizeParticipant(id,auth,this.access);
    return this.service.message(id,{...request,senderAccountId:auth.userId,senderType:auth.role});
  }

  @UseGuards(PublicJwtGuard)
  @Post('consultations/:id/close')
  async close(@Param('id') id:string,@CurrentAuth() auth:PublicAuthContext){
    await this.service.authorizeParticipant(id,auth,this.access);
    return this.service.close(id);
  }

  @UseGuards(ServiceJwtGuard) @ServiceScopes('consultation:read')
  @GrpcMethod('ConsultationInternalService','GetConsultation')
  async get(request:any){ return {consultation:await this.service.get(request.consultationId)}; }
  @UseGuards(ServiceJwtGuard) @ServiceScopes('consultation:read')
  @GrpcMethod('ConsultationInternalService','GetConsultationByAppointment')
  by(request:any){ return this.service.byAppointment(request.appointmentId); }
  @UseGuards(ServiceJwtGuard) @ServiceScopes('consultation:read')
  @GrpcMethod('ConsultationInternalService','ListConsultationMessages')
  messages(request:any){ return this.service.messages(request.consultationId,request.limit||50); }
}
