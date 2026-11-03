import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CollectionManifest, type Session } from '@learningxxx/contracts';
import { CourseWorkspaceService } from '../src/course-workspace.ts';
import { materialLayout, syncMaterials } from '../src/course-materials.ts';
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
function setup(t:{after(f:()=>void|Promise<void>):void}, afterBuild:()=>void=()=>{}) {
 const root=mkdtempSync(join(tmpdir(),'course-view-')),sessionsRoot=join(root,'sessions'),store=join(root,'store');mkdirSync(store);mkdirSync(sessionsRoot);
 let account='acct_synthetic01', builds=0;const sessions=new Map<string,Session>(), manifests=new Map<string,CollectionManifest>();
 const addCourse=(title:string,body='WEEK4_CANARY',revision=1,id=randomUUID())=>{
  writeFileSync(join(store,digest(body)),body);
  const week=randomUUID(),resource=randomUUID(),asset=randomUUID();
  const manifest=CollectionManifest.parse({schemaVersion:1,course:{id,title,accountKey:account,termId:'2026-2',sourceCourseId:'77'},weeks:[{id:week,courseId:id,sourceWeekId:'four',label:'4주차',order:0}],revision,syncRunId:randomUUID(),generatedAt:'2026-11-03T00:00:00Z',tombstones:[],items:[{resource:{id:resource,courseId:id,weekId:week,kind:'file',source:'lms',sourceId:'r',sourceUrl:'https://example.test/private?token=SECRET_SHOULD_NOT_APPEAR',title:'4주차 강의',revision,updatedAt:'2026-11-03T00:00:00Z'},assets:[{id:asset,resourceId:resource,mediaType:'application/pdf',bytes:body.length,sha256:digest(body),storageKey:'objects/'+digest(body),originalName:'week4.pdf'}]}]});manifests.set(id,manifest);return id;
 };
 const addSession=(courseId?:string)=>{const id=randomUUID(),cwd=join(sessionsRoot,id);mkdirSync(cwd);sessions.set(id,{appSessionId:id,mode:courseId?'course':'independent',...(courseId?{courseId}:{}),engine:'chat',status:'idle'} as Session);return{id,cwd};};
 const service=new CourseWorkspaceService({root:join(root,'views'),sessionsRoot,getSession:id=>sessions.get(id)!,source:{accountKey:()=>account,manifest:async id=>manifests.get(id),materials:async(id,dir)=>{builds++;const manifest=manifests.get(id)!;const entries=await syncMaterials(dir,materialLayout(manifest),{path:key=>join(store,key.replace('objects/','')),verify:async(key,sha)=>{try{return digest(readFileSync(join(store,key.replace('objects/','')),'utf8'))===sha}catch{return false}},pageTexts:async bytes=>[new TextDecoder().decode(bytes)]});afterBuild();return{manifest,entries};}}});
 // Read-only snapshots are derived test data only.
 t.after(()=>{const unlock=(p:string)=>{if(lstatSync(p).isSymbolicLink())return;if(lstatSync(p).isDirectory()){chmodSync(p,0o700);for(const n of requireReadDir(p))unlock(join(p,n));}else chmodSync(p,0o600);};unlock(root);rmSync(root,{recursive:true,force:true});});
 return{root,sessionsRoot,sessions,manifests,service,addCourse,addSession,builds:()=>builds,setAccount:(value:string)=>account=value};
}
import {readdirSync as requireReadDir} from 'node:fs';
test('course view gives the fixed course, actual week label, sanitized catalog and read-only copies',async t=>{
 const f=setup(t),course=f.addCourse('합성 외식메뉴론'),s=f.addSession(course);const binding=await f.service.prepare(s.id,s.cwd);
 assert.match(binding!.brief,/합성 외식메뉴론/);assert.match(binding!.brief,/INDEX.md/);assert.ok(existsSync(join(s.cwd,'outputs')));
 const catalog=readFileSync(join(s.cwd,'course/catalog.json'),'utf8');assert.doesNotMatch(catalog,/SECRET_SHOULD_NOT_APPEAR|storageKey|accountKey|acct_synthetic/);const info=JSON.parse(catalog);assert.equal(info.weeks[0].label,'4주차');
 const file=info.resources[0].files[0];assert.equal(readFileSync(file.path,'utf8'),'WEEK4_CANARY');assert.match(readFileSync(file.textPath,'utf8'),/=== 1쪽 ===\nWEEK4_CANARY/);assert.equal(statSync(file.path).mode&0o222,0);assert.equal(statSync(join(s.cwd,'course')).mode&0o222,0);
 await f.service.prepare(s.id,s.cwd);assert.equal(f.builds(),1);
});
test('new revisions publish atomically while old paths and user outputs remain readable',async t=>{
 const f=setup(t),course=f.addCourse('합성 A'),s=f.addSession(course);await f.service.prepare(s.id,s.cwd);const old=realpathSync(join(s.cwd,'course'));writeFileSync(join(s.cwd,'outputs/note.md'),'USER');
 f.addCourse('합성 A','REVISION_TWO',2,course);await f.service.prepare(s.id,s.cwd);const next=realpathSync(join(s.cwd,'course'));assert.notEqual(next,old);assert.ok(existsSync(join(old,'INDEX.md')));assert.equal(readFileSync(join(s.cwd,'outputs/note.md'),'utf8'),'USER');assert.match(readFileSync(join(next,'catalog.json'),'utf8'),/"revision": 2/);
});
test('sessions of different courses never inherit the visible course; general sessions never call the source',async t=>{
 const f=setup(t),a=f.addSession(f.addCourse('합성 A')),b=f.addSession(f.addCourse('합성 B')),general=f.addSession();
 const [x,y]=await Promise.all([f.service.prepare(a.id,a.cwd),f.service.prepare(b.id,b.cwd)]);assert.match(x!.brief,/합성 A/);assert.doesNotMatch(x!.brief,/합성 B/);assert.match(y!.brief,/합성 B/);
 const before=f.builds();assert.equal(await f.service.prepare(general.id,general.cwd),undefined);assert.equal(f.builds(),before);assert.equal(existsSync(join(general.cwd,'course')),false);
 f.setAccount('acct_different01');await assert.rejects(f.service.prepare(a.id,a.cwd));
});
test('a modified copy is rebuilt and reserved user folders or outputs symlinks are never overwritten',async t=>{
 const f=setup(t),course=f.addCourse('합성 A'),s=f.addSession(course);await f.service.prepare(s.id,s.cwd);const old=realpathSync(join(s.cwd,'course')),catalog=join(old,'catalog.json');chmodSync(catalog,0o600);writeFileSync(catalog,'TAMPERED');await f.service.prepare(s.id,s.cwd);assert.notEqual(realpathSync(join(s.cwd,'course')),old);assert.equal(f.builds(),2);
 const blocked=f.addSession(course);mkdirSync(join(blocked.cwd,'course'));writeFileSync(join(blocked.cwd,'course/user'),'KEEP');await assert.rejects(f.service.prepare(blocked.id,blocked.cwd));assert.equal(readFileSync(join(blocked.cwd,'course/user'),'utf8'),'KEEP');
 const escaped=f.addSession(course);symlinkSync(storePath(f.root),join(escaped.cwd,'outputs'));await assert.rejects(f.service.prepare(escaped.id,escaped.cwd));
});
const storePath=(root:string)=>join(root,'store');
test('parallel preparation of one session builds once and unavailable assets stay explicitly unavailable',async t=>{
 const f=setup(t),course=f.addCourse('합성 A'),manifest=f.manifests.get(course)!;manifest.items[0]!.assets[0]!.storageKey='objects/missing';const s=f.addSession(course);
 await Promise.all([f.service.prepare(s.id,s.cwd),f.service.prepare(s.id,s.cwd)]);assert.equal(f.builds(),1);const catalog=JSON.parse(readFileSync(join(s.cwd,'course/catalog.json'),'utf8'));assert.equal(catalog.resources[0].files[0].available,false);assert.equal(catalog.resources[0].files[0].path,undefined);
});
test('an account change during preparation aborts publication',async t=>{
 let switchAccount=false;const f=setup(t,()=>{if(switchAccount)f.setAccount('acct_different01');}),s=f.addSession(f.addCourse('합성 A'));switchAccount=true;
 await assert.rejects(f.service.prepare(s.id,s.cwd));assert.equal(existsSync(join(s.cwd,'course')),false);
});
test('a user file appearing during preparation is preserved instead of being replaced by the course link',async t=>{
 let cwd='';const f=setup(t,()=>writeFileSync(join(cwd,'course'),'USER_FILE')),s=f.addSession(f.addCourse('합성 A'));cwd=s.cwd;
 await assert.rejects(f.service.prepare(s.id,s.cwd));assert.equal(readFileSync(join(s.cwd,'course'),'utf8'),'USER_FILE');
});
