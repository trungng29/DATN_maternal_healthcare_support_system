'use strict';

// Data-only, local development. The configuration and undo journal are private files.
const { readFileSync, writeFileSync, renameSync, existsSync } = require('node:fs');
const { basename, dirname, join, resolve } = require('node:path');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { Client } = require('pg');

const oldSpecialty = 'REPRODUCTIVE_ENDOCRINOLOGY';
const oldServices = ['NIPT_PRO', 'GENETIC_COUNSELING', 'RE_AMH_ASSAY', 'RE_SEMEN_ANALYSIS', 'IUI_PROCEDURE'];
const newServices = ['PRENATAL_FIRST', 'MATERNAL_NUTRITION', 'POSTPARTUM_MATERNAL_CHECK', 'POSTPARTUM_LACTATION', 'POSTPARTUM_NEWBORN_CARE'];
const holdBooking = new Set([...newServices, 'MM_PREECLAMPSIA_SCREEN']);
const order = ['doctor', 'receptionist', 'catalog'];
const databaseNames = [...order, 'appointment', 'billing', 'medical-record'];
const schema = {
  specialties: ['doctor', ['id'], ['code','name','slug','description','overview','status','created_at','updated_at']],
  clinic_rooms: ['doctor', ['id'], ['name']],
  doctor_profiles: ['doctor', ['doctor_id'], ['biography','photo_url','photo_storage_key']],
  doctor_specialties: ['doctor', ['doctor_id','specialty_id'], ['is_primary','created_at']],
  receptionist_profiles: ['receptionist', ['receptionist_id'], ['avatar_url']],
  medical_services: ['catalog', ['id'], ['code','slug','name','summary','description','kind','specialty_id','thumbnail_url','duration_minutes','booking_enabled','doctor_rank_selection_policy','content','status','version','published_at','created_at','updated_at']],
  medical_service_tags: ['catalog', ['medical_service_id','tag_id'], ['created_at']],
  base_prices: ['catalog', ['id'], ['medical_service_id','amount_minor','currency','effective_from','status','version','created_at','updated_at']],
};
const read = path => readFileSync(path, 'utf8').replace(/^\ufeff/, '');
const hash = value => createHash('sha256').update(value).digest('hex');
const json = path => JSON.parse(read(path));
const normalize = obj => {
  if (Array.isArray(obj)) return obj.map(normalize);
  if (obj && typeof obj === 'object') return Object.fromEntries(Object.keys(obj).sort().map(k => [k, normalize(obj[k])]));
  return obj;
};
const equivalent = (a,b) => isDeepStrictEqual(normalize(a),normalize(b));
function requireCondition(ok, message) {
  if (!ok) throw new Error(message);
}
const q = name => '"' + name + '"';
const params = (list, offset = 0) => list.map((_, i) => '$' + (i + offset + 1));
const fields = (obj, list) => Object.fromEntries(list.map(k => [k, obj[k]]));
const timestamp = new Date().toISOString().replace('T',' ').replace(/Z$/, '+00:00');
const insertContext = {created_at:timestamp,updated_at:timestamp};
const normalizedTime = value => typeof value==='string' && /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d/.test(value)
  ? new Date(value).toISOString() : value;
const comparable = (obj, columns) => !obj ? null : Object.fromEntries(columns.map(k => [k,
  ['created_at','updated_at','effective_from','published_at'].includes(k) ? normalizedTime(obj[k]) : obj[k],
]));
function dataBlock(source, name, close) {
  const prefix = '  const ' + name + ' = ';
  const start = source.indexOf(prefix);
  const end = source.indexOf('\n  ' + close + ';', start);
  requireCondition(start >= 0 && end > start, 'Missing reviewed seed block: '+name);
  return JSON.parse(source.slice(start + prefix.length, end + 4));
}
const source = read(join(__dirname, '..', 'seed_system_data.js'));
const reviewed = {
  specialties:dataBlock(source,'specialtiesDef',']'),
  services:dataBlock(source,'servicesDef',']'),
  content:dataBlock(source,'SERVICE_CONTENT','}'),
  doctors:dataBlock(source,'doctorsDef',']'),
  receptionists:dataBlock(source,'receptionistsDef',']'),
  rooms:dataBlock(source,'clinicRoomsDef',']'),
};
for (const key of newServices) requireCondition(reviewed.services.some(x=>x.code===key),'Reviewed code missing');
const seedSha = hash(source);
const args=process.argv.slice(2);
const action=args[0]||'--dry-run';
const option = flag => args.includes(flag)?args[args.indexOf(flag)+1]:undefined;
const clients = {};
const get = async (db, sql, values=[]) => (await clients[db].query(sql,values)).rows;
const ids = rows => Object.fromEntries(rows.map(row=>[row.code,row]));
const byCode = (obj, code, label) => {
  requireCondition(obj[code],label+' does not match the reviewed baseline.');
  return obj[code];
};
async function assertQuiescent(names) {
  for (const name of names) {
    const [row] = await get(name, `SELECT count(*)::int AS sessions
      FROM pg_stat_activity WHERE datname=current_database()
        AND pid<>pg_backend_pid() AND backend_type='client backend'`);
    requireCondition(row.sessions===0, 'Database has other client sessions: '+name);
  }
}

async function lockMigrationTables() {
  await assertQuiescent(databaseNames);
  for (const name of databaseNames) {
    const tables=await get(name, "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='public' AND tablename<>'_prisma_migrations' ORDER BY tablename");
    requireCondition(tables.length>0, 'Expected operational tables: '+name);
    const qualified=tables.map(row=>'public.'+q(row.tablename.replaceAll('"','""')));
    await get(name,'LOCK TABLE '+qualified.join(', ')+' IN SHARE ROW EXCLUSIVE MODE NOWAIT');
  }
}
function uuid(seed) {
  const hex=hash(seed).slice(0,32);
  return hex.slice(0,8)+'-'+hex.slice(8,12)+'-5'+hex.slice(13,16)+'-a'+hex.slice(17,20)+'-'+hex.slice(20);
}
function rowTag(key,value) {
  return Object.entries(value).map(([k,v])=>[k, ['created_at','updated_at','published_at','effective_from'].includes(k)&&v===timestamp?'@migration-time':v]);
}
async function connect(write) {
  const supplied=process.env.TAMAN_MIGRATION_URLS_FILE;
  requireCondition(supplied,'Set TAMAN_MIGRATION_URLS_FILE to a private local JSON file.');
  requireCondition(process.env.NODE_ENV!=='production','Production is outside the migration scope.');
  const urls=json(supplied);
  const environment=databaseNames;
  const identity=[];
  for(const db of environment){
    let u;
    try{u=new URL(urls[db]);}catch{throw new Error('Missing or invalid URL for '+db);}
    requireCondition(u.protocol==='postgresql:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname),'Only local development PostgreSQL is supported.');
    requireCondition(!u.searchParams.get('schema')||u.searchParams.get('schema')==='public','Expected public schema.');
    const client=new Client({connectionString:u.href,connectionTimeoutMillis:5000,statement_timeout:15000,lock_timeout:3000});
    clients[db]=client;
    await client.connect();
    const [server]=await get(db,"SELECT current_database() AS name, (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid");
    identity.push([db,u.hostname,u.port,server.name,server.oid]);
    await client.query(write?'BEGIN':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    if(write){
      const [lock]=await get(db,'SELECT pg_try_advisory_xact_lock(221128063) AS locked');
      requireCondition(lock.locked,'Migration already in progress.');
    }
  }
  requireCondition(new Set(identity.map(([,host,port,name])=>port+'/'+name)).size===environment.length,
    'Migration databases must be distinct.');
  if(write) await lockMigrationTables();
  return hash(JSON.stringify(identity));
}
async function historicalReferences(plan) {
  const serviceIds=plan.changes.filter(c=>c.table==='medical_services'&&!c.before).map(c=>c.key.id);
  const specialtyIds=plan.changes.filter(c=>c.table==='specialties'&&!c.before).map(c=>c.key.id);
  if(!serviceIds.length&&!specialtyIds.length) return 0;
  const queries=[
    ['appointment','SELECT count(*)::int AS count FROM appointments WHERE service_id=ANY($1::uuid[]) OR specialty_id=ANY($2::uuid[])',[serviceIds,specialtyIds]],
    ['appointment','SELECT count(*)::int AS count FROM slot_holds WHERE service_id=ANY($1::uuid[])',[serviceIds]],
    ['billing','SELECT count(*)::int AS count FROM invoice_lines WHERE service_id=ANY($1::uuid[])',[serviceIds]],
    ['medical-record','SELECT count(*)::int AS count FROM clinical_service_orders WHERE catalog_service_id=ANY($1::uuid[])',[serviceIds]],
  ];
  let count=0;
  for(const [db,sql,params] of queries) count+=(await get(db,sql,params))[0].count;
  return count;
}
async function openBusiness(serviceIds, specialtyIds, doctorIds) {
  const [a] = await get('appointment', "SELECT count(*)::int AS count FROM appointments WHERE status IN ('BOOKED','REASSIGNMENT_REQUIRED','CHECKED_IN','IN_CLINICAL_CARE') AND (service_id=ANY($1::uuid[]) OR specialty_id=ANY($2::uuid[]) OR assigned_doctor_id=ANY($3::uuid[]) OR requested_doctor_id=ANY($3::uuid[]))", [serviceIds,specialtyIds,doctorIds]);
  const [h] = await get('appointment',"SELECT count(*)::int AS count FROM slot_holds WHERE status='ACTIVE' AND expires_at>now() AND (service_id=ANY($1::uuid[]) OR doctor_id=ANY($2::uuid[]))",[serviceIds,doctorIds]);
  const [b] = await get('billing',"SELECT count(*)::int AS count FROM invoices i WHERE EXISTS (SELECT 1 FROM invoice_lines l WHERE i.id=l.invoice_id AND l.service_id=ANY($1::uuid[])) AND (i.status IN ('OPEN','PAYMENT_PENDING_VERIFICATION','OUTSTANDING','CREDIT_APPROVED') OR EXISTS (SELECT 1 FROM payment_attempts p WHERE p.invoice_id=i.id AND p.status IN ('PENDING','RECONCILIATION_REQUIRED')))",[serviceIds]);
  // Quotes are computed by GET /estimate, with no quote table. Holds and invoices persist their own state.
  return {openAppointments:a.count,activeHolds:h.count,openInvoices:b.count};
}
async function planMigration() {
  const changes=[];
  function plan(table, key, old, next) {
    const prev=old?fields(old,Object.keys(next||old).filter(k=>!Object.hasOwn(key,k))):null;
    if(equivalent(prev,next))return;
    const [,keyColumns,allowed]=schema[table];
    requireCondition(equivalent(Object.keys(key).sort(),[...keyColumns].sort()),'Invalid migration key');
    requireCondition(Object.keys(next||prev).every(k=>allowed.includes(k)),'Invalid migration column');
    changes.push({table,key,before:prev,after:next});
  }
  const specs=ids(await get('doctor','SELECT id,code,name,slug,description,overview,status FROM specialties'));
  const services=ids(await get('catalog','SELECT id,code,slug,name,summary,description,kind,specialty_id,thumbnail_url,duration_minutes,booking_enabled,doctor_rank_selection_policy,content,status,version FROM medical_services'));
  const tags=ids(await get('catalog',"SELECT id,code FROM catalog_tags WHERE status='ACTIVE'"));
  const rooms=ids(await get('doctor','SELECT id,code,name FROM clinic_rooms'));
  const specsIds={};
  const anchor=byCode(specs,'OBSTETRICS','Specialty').id;
  const legacy=byCode(specs,oldSpecialty,'Legacy specialty');
  const doctors=[];
  const created={specialties:[],services:[]}, retained={specialties:[],services:[],doctorCount:0,receptionistCount:0};
  const currentOfferings=[];
  for(const row of reviewed.specialties){
    const current=specs[row.code];
    const values={name:row.name,description:row.desc,overview:row.overview,status:'ACTIVE'};
    if(row.code==='POSTPARTUM_CARE'&&!current){
      const id=uuid('taman-20261128:'+anchor+':'+row.code);
      specsIds[row.code]=id;
      plan('specialties',{id},null,{code:row.code,slug:row.slug,...values,...insertContext});
      created.specialties.push(row.code);
    }else{
      requireCondition(current&&current.slug===row.slug,'Unexpected specialty code/slug '+row.code);
      specsIds[row.code]=current.id;
      plan('specialties',{id:current.id},current,values);
      retained.specialties.push(row.code);
    }
  }
  for(const doc of reviewed.doctors){
    const matches=await get('doctor','SELECT d.id,p.biography,p.photo_url,p.photo_storage_key FROM doctors d JOIN doctor_profiles p ON p.doctor_id=d.id WHERE d.license_number=$1 AND p.full_name=$2',[doc.license,doc.fullName]);
    requireCondition(matches.length===1,'Reviewed doctor identity does not uniquely match.');
    const d=matches[0];
    doctors.push(d.id);
    const values={biography:doc.bio,photo_url:doc.photoUrl,photo_storage_key:d.photo_url!==doc.photoUrl?null:d.photo_storage_key};
    plan('doctor_profiles',{doctor_id:d.id},d,values);
    retained.doctorCount++;
  }
  const linked=await get('doctor','SELECT doctor_id,specialty_id,is_primary,to_jsonb(created_at) AS created_at FROM doctor_specialties WHERE doctor_id=ANY($1::uuid[]) ORDER BY doctor_id,specialty_id',[doctors]);
  for(let i=0;i<reviewed.doctors.length;i++){
    const doc=reviewed.doctors[i], doctor_id=doctors[i], target=specsIds[doc.specialtyCode];
    const existing=linked.filter(row=>row.doctor_id===doctor_id);
    requireCondition(existing.filter(r=>r.is_primary).length===1,'Doctor primary specialty is ambiguous.');
    const primary=existing.find(r=>r.is_primary);
    if(primary.specialty_id!==target) plan('doctor_specialties',{doctor_id,specialty_id:primary.specialty_id},primary,null);
    const same=existing.find(row=>row.specialty_id===target);
    if(!same) plan('doctor_specialties',{doctor_id,specialty_id:target},null,{is_primary:true,created_at:timestamp});
    else if(!same.is_primary) plan('doctor_specialties',{doctor_id,specialty_id:target},same,{is_primary:true});
    if(i===7){
      const secondary=existing.find(row=>row.specialty_id===legacy.id && !row.is_primary);
      if(secondary){
        plan('doctor_specialties',{doctor_id,specialty_id:legacy.id},secondary,null);
        if(!existing.some(row=>row.specialty_id===specsIds.POSTPARTUM_CARE) && target!==specsIds.POSTPARTUM_CARE)
          plan('doctor_specialties',{doctor_id,specialty_id:specsIds.POSTPARTUM_CARE},null,{is_primary:false,created_at:timestamp});
      }
    }
  }
  plan('specialties',{id:legacy.id},legacy,{status:'INACTIVE'});
  for(const room of reviewed.rooms){
    const current=byCode(rooms,room.code,'Room');
    plan('clinic_rooms',{id:current.id},current,{name:room.name});
  }
  for(const staff of reviewed.receptionists){
    const matches=await get('receptionist','SELECT r.id,p.avatar_url FROM receptionists r JOIN receptionist_profiles p ON p.receptionist_id=r.id WHERE r.employee_code=$1 AND p.full_name=$2',[staff.code,staff.fullName]);
    requireCondition(matches.length===1,'Reviewed receptionist identity does not uniquely match.');
    plan('receptionist_profiles',{receptionist_id:matches[0].id},matches[0],{avatar_url:staff.avatarUrl});
    retained.receptionistCount++;
  }
  for(const target of reviewed.services){
    const old=services[target.code];
    if(old) requireCondition(old.slug===target.slug && old.status==='ACTIVE','Service version/status incompatible: '+target.code);
    else requireCondition(newServices.includes(target.code),'Missing retained service: '+target.code);
    const id=old?.id || uuid('taman-20261128:'+anchor+':'+target.code);
    if(old) {
      const prices=await get('catalog',`SELECT id, amount_minor::text, currency, status, version,
        to_jsonb(effective_from) AS effective_from, to_jsonb(effective_to) AS effective_to
        FROM base_prices WHERE medical_service_id=$1 AND status='ACTIVE' AND currency='VND'
          AND effective_from<=now() AND (effective_to IS NULL OR effective_to>now()) ORDER BY id`,[id]);
      requireCondition(prices.length===1 && prices[0].amount_minor===String(target.price),
        'Current VND price needs review: '+target.code);
      currentOfferings.push({
        id, code:old.code, status:old.status, bookingEnabled:old.booking_enabled,
        policy:old.doctor_rank_selection_policy, version:old.version, price:prices[0],
      });
    }
    const content=reviewed.content[target.code];
    requireCondition(content?.review?.status==='DRAFT'&&content.review.needs_medical_review===true,'Unexpected review state');
    requireCondition(specsIds[target.specialtyCode]&&target.thumbnailUrl.startsWith('https://res.cloudinary.com/'),'Missing verified source data.');
    const values={name:target.name,summary:target.summary,description:target.description,kind:target.kind,
      specialty_id:specsIds[target.specialtyCode],thumbnail_url:target.thumbnailUrl,duration_minutes:target.duration,
      doctor_rank_selection_policy:target.policy,content,booking_enabled:holdBooking.has(target.code)?false:old?.booking_enabled??true};
    const existing=await get('catalog','SELECT medical_service_id,tag_id,to_jsonb(created_at) AS created_at FROM medical_service_tags WHERE medical_service_id=$1 ORDER BY tag_id',[id]);
    const desiredTags=target.tagCodes.map(code=>byCode(tags,code,'Tag').id).sort();
    const currentTags=existing.map(row=>row.tag_id).sort();
    if(old){
      if(!equivalent(fields(old,Object.keys(values)),values)||!equivalent(currentTags,desiredTags))
        plan('medical_services',{id},old,{...values,version:old.version+1});
      retained.services.push(target.code);
    }else{
      plan('medical_services',{id},null,{...values,code:target.code,slug:target.slug,version:1,status:'ACTIVE',published_at:timestamp,...insertContext});
      const priceId=uuid('taman-20261128:price:'+id);
      plan('base_prices',{id:priceId},null,{medical_service_id:id,amount_minor:target.price,currency:'VND',effective_from:timestamp,status:'ACTIVE',version:1,...insertContext});
      created.services.push(target.code);
    }
    for(const oldTag of existing) if(!desiredTags.includes(oldTag.tag_id))
      plan('medical_service_tags',{medical_service_id:id,tag_id:oldTag.tag_id},oldTag,null);
    for(const tag_id of desiredTags.filter(id=>!currentTags.includes(id)))
      plan('medical_service_tags',{medical_service_id:id,tag_id},null,{created_at:timestamp});
  }
  for(const code of oldServices){
    const item=byCode(services,code,'Legacy service');
    if(item.status!=='INACTIVE'||item.booking_enabled) plan('medical_services',{id:item.id},item,{status:'INACTIVE',booking_enabled:false,version:item.version+1});
  }
  return {changes,created,retained,currentOfferings,retired:{specialties:[oldSpecialty],services:oldServices},affected:{
    serviceIds:[...Object.values(services).filter(o=>reviewed.services.some(s=>s.code===o.code)||oldServices.includes(o.code)).map(o=>o.id),...created.services.map(code=>uuid('taman-20261128:'+anchor+':'+code))],
    specialtyIds:[...Object.values(specsIds),legacy.id],doctorIds:doctors,
  }};
}
async function execute(change, reverse){
  const {table,key}=change;
  const [db,keyColumns,allowed]=schema[table];
  requireCondition(equivalent(Object.keys(key).sort(),[...keyColumns].sort()),'Invalid journal key');
  const [before, after]=reverse?[change.after,change.before]:[change.before,change.after];
  const columns=Object.keys(after||before);
  requireCondition(columns.length&&columns.every(k=>allowed.includes(k)),'Invalid journal columns');
  const selector=keyColumns.map((name,i)=>q(name)+'=$'+(i+1)).join(' AND ');
  const keys=keyColumns.map(name=>key[name]);
  const [raw]=await get(db,'SELECT to_jsonb(t) AS value FROM '+q(table)+' t WHERE '+selector,keys);
  const state=comparable(raw?.value,columns);
  // Price bigint reads as a number in JSONB for these fixture prices.
  if(equivalent(state,comparable(after,columns)))return;
  requireCondition(equivalent(state,comparable(before,columns)),'Row changed since plan/journal: '+table);
  if(!after){await get(db,'DELETE FROM '+q(table)+' WHERE '+selector,keys);return;}
  const values=columns.map(k=>after[k]);
  if(!before){
    const all=[...keyColumns,...columns];
    await get(db,'INSERT INTO '+q(table)+' ('+all.map(q).join(',')+') VALUES ('+params(all).join(',')+')',[...keys,...values]);
  }else{
    const assignments=columns.map((name,i)=>q(name)+'=$'+(i+1+keys.length));
    await get(db,'UPDATE '+q(table)+' SET '+assignments.join(',')+' WHERE '+selector,[...keys,...values]);
  }
}
function journalWrite(file,data) {
  const temp=join(dirname(file),'.'+basename(file)+'.tmp');
  writeFileSync(temp,JSON.stringify(data,null,2)+'\n',{mode:0o600,flag:'wx'});
  renameSync(temp,file);
}
async function run() {
  requireCondition(['--dry-run','--apply','--rollback'].includes(action),'Invalid command.');
  const write=action!=='--dry-run';
  const file=option('--journal')&&resolve(option('--journal'));
  if(write) requireCondition(file&&args.includes('--maintenance'),'Require private --journal and --maintenance with writers stopped.');
  const environment=await connect(write);
  const rollback=action==='--rollback';
  const previous=rollback?json(file):null;
  if(previous) requireCondition(previous.environment===environment&&previous.seedSha===seedSha,'Journal target or seed mismatch');
  const plan=previous?.plan||await planMigration();
  const fingerprint=hash(JSON.stringify(normalize({environment,seedSha,currentOfferings:plan.currentOfferings,
    changes:plan.changes.map(c=>({...c,after:c.after&&rowTag(c.key,c.after)}))})));
  const conflicts=await openBusiness(plan.affected.serviceIds,plan.affected.specialtyIds,plan.affected.doctorIds);
  if(rollback) conflicts.historicalReferences=await historicalReferences(plan);
  const blocked=Object.values(conflicts).some(v=>v>0);
  console.log(JSON.stringify({action,fingerprint,operations:plan.changes.length,created:plan.created,retained:plan.retained,retired:plan.retired,conflicts,status:blocked?'BLOCKED':write?'READY':'PASS'}));
  if(blocked){process.exitCode=3;return;}
  if(!write)return;
  if(!rollback){
    requireCondition(option('--expected')===fingerprint,'Dry-run fingerprint does not match the current target.');
    requireCondition(!existsSync(file),'Journal already exists.');
    if(!plan.changes.length)return;
    journalWrite(file,{environment,seedSha,fingerprint,plan});
  }
  const changes=rollback?[...plan.changes].reverse():plan.changes;
  for(const change of changes)await execute(change,rollback);
  // Foreign IDs are shared across databases. The journal permits safe retry/compensation
  // if a commit succeeds in one database and another one fails.
  for(const db of rollback?[...order].reverse():order) {
    await assertQuiescent(databaseNames);
    await clients[db].query('COMMIT');
  }
  console.log(JSON.stringify({status:'PASS',applied:changes.length,mode:action}));
}
run().catch(error=>{
  console.error(JSON.stringify({status:'FAIL',code:error.code||'MIGRATION',message:error.code?undefined:error.message}));
  process.exitCode=1;
}).finally(async()=>{
  await Promise.allSettled(Object.values(clients).map(async client=>{
    try{await client.query('ROLLBACK');} finally{await client.end();}
  }));
});
