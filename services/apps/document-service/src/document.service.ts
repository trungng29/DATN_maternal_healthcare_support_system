import { ConflictException,Injectable,NotFoundException } from '@nestjs/common';
import { DocumentStatus,ScanStatus } from '../../../generated/document-client';
import { randomUUID } from 'node:crypto';
import { DocumentPrismaService } from './database/prisma.service';
@Injectable()
export class DocumentService {
  constructor(private readonly db:DocumentPrismaService){}
  async create(r:any){const old=await this.db.uploadSession.findUnique({where:{idempotencyKey:r.idempotencyKey}});if(old)return{sessionId:old.id,documentId:old.documentId,uploadUrl:this.url(old.id),expiresAt:this.time(old.expiresAt)};const d=await this.db.document.create({data:{ownerType:r.ownerType,ownerId:r.ownerId,patientId:r.patientId,purpose:r.purpose,createdByAccountId:r.context?.actorAccountId||randomUUID()}});await this.db.documentVersion.create({data:{documentId:d.id,version:1,storageKey:'documents/'+d.id+'/1',fileName:r.fileName,mediaType:r.mediaType,sizeBytes:BigInt(r.sizeBytes),sha256:r.sha256}});const u=await this.db.uploadSession.create({data:{documentId:d.id,version:1,expectedMediaType:r.mediaType,maxBytes:BigInt(r.sizeBytes),expiresAt:new Date(Date.now()+900000),idempotencyKey:r.idempotencyKey}});return{sessionId:u.id,documentId:d.id,uploadUrl:this.url(u.id),expiresAt:this.time(u.expiresAt)};}
  async link(r:any){const d=await this.db.document.findUnique({where:{id:r.documentId},include:{versions:{orderBy:{version:'desc'},take:1}}});if(!d)throw new NotFoundException('DOCUMENT_NOT_FOUND');if(d.versions[0]?.scanStatus!==ScanStatus.CLEAN)throw new ConflictException('DOCUMENT_NOT_CLEAN');const x=await this.db.document.update({where:{id:d.id},data:{ownerType:r.ownerType,ownerId:r.ownerId,patientId:r.patientId,status:DocumentStatus.CLEAN}});return this.ref(x,d.versions[0]);}
  async list(r:any){const docs=await this.db.document.findMany({where:{ownerType:r.ownerType,ownerId:r.ownerId},include:{versions:{orderBy:{version:'desc'},take:1}}});return{documents:docs.map(d=>this.ref(d,d.versions[0]))};}
  async access(r:any){const d=await this.db.document.findUnique({where:{id:r.documentId},include:{versions:{orderBy:{version:'desc'},take:1}}});if(!d)throw new NotFoundException('DOCUMENT_NOT_FOUND');const ok=d.status===DocumentStatus.CLEAN&&d.versions[0]?.scanStatus===ScanStatus.CLEAN;return{document:this.ref(d,d.versions[0]),allowed:ok,denialCode:ok?'':'DOCUMENT_NOT_CLEAN',downloadUrl:ok?this.url(d.id):'',expiresAt:ok?this.time(new Date(Date.now()+300000)):undefined};}
  async archive(r:any){const x=await this.db.document.updateMany({where:{ownerType:r.ownerType,ownerId:r.ownerId,status:{not:DocumentStatus.ARCHIVED}},data:{status:DocumentStatus.ARCHIVED}});return{archivedCount:x.count};}
  private ref(d:any,v:any){return{documentId:d.id,ownerType:d.ownerType,ownerId:d.ownerId,patientId:d.patientId,status:d.status,currentVersion:d.currentVersion,mediaType:v?.mediaType??'',sizeBytes:String(v?.sizeBytes??0)};}
  private url(id:string){return'document://private/'+id;}
  private time(d:Date){return{seconds:Math.floor(d.getTime()/1000).toString(),nanos:0};}
}
