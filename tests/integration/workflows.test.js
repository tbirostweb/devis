import 'dotenv/config';
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {today,addDays} from '../../server/db.js';
import {enrollTotp,testTotpKey} from './totp-helper.js';
const originalUrl=new URL(process.env.DATABASE_URL);
const testUrl=new URL(process.env.TEST_DATABASE_URL||originalUrl);if(!process.env.TEST_DATABASE_URL)testUrl.pathname='/birostweb_test';
if(testUrl.pathname!=='/birostweb_test'||process.env.NODE_ENV==='production')throw new Error('Tests require a dedicated database named birostweb_test, outside production.');
const env={...process.env,NODE_ENV:'test',DATABASE_URL:testUrl.toString(),SEED_DEMO:'false',STORAGE_PATH:'./tmp/test-storage',PORT:'3202',APP_ORIGIN:'http://127.0.0.1:3202',ADMIN_EMAIL:'test-admin@birostweb.example',ADMIN_PASSWORD:randomUUID()+randomUUID(),TOTP_ENCRYPTION_KEY:testTotpKey()};
const base='http://127.0.0.1:3202/api',origin=env.APP_ORIGIN;let child,logs='',cookie='',csrf='',client,other,category,service,quote,project,invoice,expense,document,subscription,referrer,commission;const now=today();
async function call(path,{method='GET',body,headers={},anonymous=false}={}){const form=body instanceof FormData;const response=await fetch(base+path,{method,headers:{origin,...(!anonymous?{cookie,'x-csrf-token':csrf}:{}),...(!form&&body?{'content-type':'application/json'}:{}),...headers},body:body?(form?body:JSON.stringify(body)):undefined});const json=response.headers.get('content-type')?.includes('application/json');const data=json?await response.json():Buffer.from(await response.arrayBuffer());return {status:response.status,data,headers:response.headers};}
async function ok(path,opts){const r=await call(path,opts);assert.equal(r.status,200,`${path}: ${JSON.stringify(r.data)}`);return r.data;}
const line=(unitCents=99900,extra={})=>({name:'Site vitrine QA',description:'Une prestation de test.',category:'Création de site',section:'Projet',unitCents,quantityMilli:1000,frequency:'once',vatBps:0,discountBps:0,optional:false,selected:true,position:0,...extra});
const quoteBody=(extra={})=>({clientId:client.id,title:'QA Hydrogen site',issuedDate:now,validUntil:addDays(now,30),depositBps:3000,discountBps:0,conditions:'Acompte de 30 % à la commande.',legalNotice:'Document fictif de validation.',items:[line(),line(10000,{quantityMilli:3000}),line(4500,{frequency:'monthly'}),line(3900,{frequency:'monthly'})],...extra});
before(async()=>{
  for(const args of [['node_modules/prisma/build/index.js','migrate','reset','--force','--skip-seed','--skip-generate'],['prisma/seed.js']])execFileSync(process.execPath,args,{env,stdio:'pipe'});
  child=spawn(process.execPath,['server/index.js'],{env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
  let ready=false;for(let i=0;i<60;i++){try{if((await fetch(base+'/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,150));}if(!ready)throw new Error(logs.slice(-3000));
  const login=await call('/auth/login',{method:'POST',anonymous:true,body:{email:env.ADMIN_EMAIL,password:env.ADMIN_PASSWORD}});assert.equal(login.status,200,JSON.stringify(login.data));cookie=login.headers.get('set-cookie').split(';')[0];csrf=login.data.csrf;
  await enrollTotp(call,env.ADMIN_PASSWORD); // 2FA administrateur obligatoire avant tout accès métier
});
after(async()=>{if(child){child.kill('SIGTERM');await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);});}});
test('Private APIs, files and mutations enforce session, Origin and CSRF',async()=>{
  for(const route of ['/clients','/dashboard','/settings','/documents/nope/download'])assert.equal((await call(route,{anonymous:true})).status,401);
  assert.equal((await call('/clients',{method:'POST',headers:{'x-csrf-token':''},body:{}})).status,403);
  assert.equal((await call('/clients',{method:'POST',headers:{origin:'https://evil.example'},body:{}})).status,403);
  assert.equal((await call('/clients',{method:'POST',headers:{'x-csrf-token':'é'.repeat(64)},body:{}})).status,403);
  const me=await ok('/auth/me');assert.equal(me.user.email,env.ADMIN_EMAIL);assert.match(cookie,/bw_session=/);
});
test('Client and catalog CRUD validate input, persist and paginate',async()=>{
  assert.equal((await call('/clients',{method:'POST',body:{name:'Bad',email:'not-email'}})).status,400);
  client=await ok('/clients',{method:'POST',body:{name:'QA Hydrogen',email:'qa@example.com',address:'12 rue de Test',status:'active'}});
  other=await ok('/clients',{method:'POST',body:{name:'QA Other',email:'other@example.com'}});
  category=await ok('/categories',{method:'POST',body:{name:'QA category'}});
  service=await ok('/services',{method:'POST',body:{name:'QA Service',categoryId:category.id,unitCents:99900}});
  await ok('/services/'+service.id,{method:'PATCH',body:{...service,unitCents:199900,active:false}});
  assert.equal((await ok('/services?status=inactive')).rows.find(s=>s.id===service.id).unitCents,199900);
  const list=await ok('/clients?limit=1');assert.equal(list.rows.length,1);assert.equal(list.count,2);
});
test('Quote totals are server-calculated and price snapshots survive catalogue edits',async()=>{
  quote=await ok('/quotes',{method:'POST',body:quoteBody({totalCents:1})});assert.equal(quote.totalCents,129900);assert.equal(quote.recurringCents,8400);
  const row=await ok('/quotes/'+quote.id);assert.equal(row.items[0].unitCents,99900);
  assert.equal((await call('/quotes/'+quote.id+'/status',{method:'PATCH',body:{status:'accepted'}})).status,409);
  await ok('/quotes/'+quote.id+'/status',{method:'PATCH',body:{status:'sent'}});await ok('/quotes/'+quote.id+'/status',{method:'PATCH',body:{status:'accepted'}});
  // Un devis accepté reste désormais modifiable (sans facture officielle) et conserve son statut.
  const editedQuote=await call('/quotes/'+quote.id,{method:'PUT',body:quoteBody()});assert.equal(editedQuote.status,200,JSON.stringify(editedQuote.data));
  assert.equal((await ok('/quotes/'+quote.id)).status,'accepted');
});
test('Concurrent quote conversion is idempotent and preserves all project lines',async()=>{
  const results=await Promise.all([call('/quotes/'+quote.id+'/convert',{method:'POST',body:{}}),call('/quotes/'+quote.id+'/convert',{method:'POST',body:{}})]);for(const r of results)assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(results[0].data.id,results[1].data.id);project=results[0].data;
  const p=await ok('/projects/'+project.id);assert.equal(p.items.length,4);assert.equal(p.tasks.length,5);assert.equal(p.quoteId,quote.id);
  await ok('/projects/'+project.id,{method:'PATCH',body:{status:'progress'}});assert.equal((await ok('/projects/'+project.id)).status,'progress');
  const t=await ok('/projects/'+project.id+'/tasks',{method:'POST',body:{title:'Étape QA'}});await ok('/tasks/'+t.id,{method:'PATCH',body:{done:true}});
});
test('Invoice sequence begins at issuance; incomplete settings block issuance',async()=>{
  const body={clientId:client.id,projectId:project.id,quoteId:quote.id,title:'QA acompte',kind:'deposit',issuedDate:now,dueDate:addDays(now,10),items:[line(50000)]};
  invoice=await ok('/invoices',{method:'POST',body});assert.match(invoice.reference,/^BRO-/);
  assert.equal((await call('/invoices/'+invoice.id+'/status',{method:'PATCH',body:{status:'sent'}})).status,400);
  const settings=await ok('/settings');await ok('/settings',{method:'PUT',body:{...settings,address:'12 rue de Test, 75001 Paris',siret:'00000000000000'}});
  invoice=await ok('/invoices/'+invoice.id+'/status',{method:'PATCH',body:{status:'sent'}});assert.match(invoice.reference,/^FAC-\d{4}-001$/);
  assert.equal((await call('/invoices/'+invoice.id,{method:'PUT',body})).status,409);
  assert.equal((await call('/invoices/'+invoice.id+'/status',{method:'PATCH',body:{status:'cancelled'}})).status,409);
  assert.equal((await call('/invoices',{method:'POST',body:{...body,items:[line(100000)]}})).status,400);
});
test('Concurrent payments cannot overpay; retry key prevents double collection',async()=>{
  const payment=extra=>({clientId:client.id,projectId:project.id,invoiceId:invoice.id,amountCents:30000,date:now,method:'transfer',requestKey:randomUUID(),...extra});
  const results=await Promise.all([call('/payments',{method:'POST',body:payment()}),call('/payments',{method:'POST',body:payment()})]);assert.deepEqual(results.map(r=>r.status).sort(),[200,400]);
  const body=payment({amountCents:10000});const a=await ok('/payments',{method:'POST',body}),b=await ok('/payments',{method:'POST',body});assert.equal(a.id,b.id);
  await ok('/payments',{method:'POST',body:payment({amountCents:10000})});const result=await ok('/invoices/'+invoice.id);assert.equal(result.status,'paid');assert.equal(result.payments.reduce((s,p)=>s+p.amountCents,0),50000);
  assert.equal((await call('/payments',{method:'POST',body:payment({clientId:other.id,amountCents:1})})).status,400);
  assert.equal((await call('/payments',{method:'POST',body:payment({amountCents:1,date:addDays(now,1)})})).status,400);
});
test('Expenses and private uploads round-trip; MIME spoofing and cross-client links fail',async()=>{
  expense=await ok('/expenses',{method:'POST',body:{supplier:'QA Supplier',date:now,dueDate:now,netCents:10000,vatBps:2000,category:'Logiciels',paid:true}});assert.equal(expense.totalCents,12000);
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=','base64');
  const body=new FormData();body.append('file',new Blob([png],{type:'image/png'}),'QA Hydrogen.png');document=await ok('/documents?expenseId='+expense.id,{method:'POST',body});assert.equal(document.size,png.length);assert.equal(document.storageKey,undefined);
  const download=await call('/documents/'+document.id+'/download');assert.equal(download.status,200);assert.deepEqual(download.data,png);assert.equal(download.headers.get('cache-control'),'no-store');
  const bad=new FormData();bad.append('file',new Blob(['<script>bad</script>'],{type:'application/pdf'}),'fake.pdf');assert.equal((await call('/documents',{method:'POST',body:bad})).status,400);
  const cross=new FormData();cross.append('file',new Blob([png]),'cross.png');assert.equal((await call(`/documents?projectId=${project.id}&clientId=${other.id}`,{method:'POST',body:cross})).status,400);
});
test('Recurring invoice preserves tax, handles month ends and rejects duplicate period',async()=>{
  subscription=await ok('/subscriptions',{method:'POST',body:{clientId:client.id,name:'QA hébergement',category:'Hébergement',amountCents:4500,vatBps:2000,frequency:'monthly',startDate:'2026-01-01',nextDate:'2026-01-31'}});
  const i=await ok('/subscriptions/'+subscription.id+'/invoice',{method:'POST',body:{nextDate:'2026-01-31'}});assert.equal(i.totalCents,5400);
  const subs=await ok('/subscriptions');assert.equal(subs.find(s=>s.id===subscription.id).nextDate,'2026-02-28');
  assert.equal((await call('/subscriptions/'+subscription.id+'/invoice',{method:'POST',body:{nextDate:'2026-01-31'}})).status,409);
});
test('Reporting, search, timeline and notification reads use persisted records',async()=>{
  const d=await ok('/dashboard?period=custom&from='+now+'&to='+now);assert.equal(d.stats.collected,50000);assert.equal(d.stats.expenses,12000);assert.equal(d.stats.cashMargin,38000);assert.equal(d.chart.reduce((s,r)=>s+r.revenue,0),50000);
  const c=await ok('/clients/'+client.id);assert.ok(c.activities.length>=5);const r=await ok('/search?q=Hydrogen');assert.ok(r.some(r=>r.type==='clients'));assert.ok(r.some(r=>r.type==='quotes'));assert.ok(r.some(r=>r.type==='documents'));
  const n=await ok('/notifications');await ok('/notifications/read',{method:'POST',body:{keys:n.map(v=>v.key)}});assert.ok((await ok('/notifications')).every(v=>v.read));
  const calendar=await ok('/calendar?from='+now.slice(0,4)+'-01-01&to='+now.slice(0,4)+'-12-31');assert.ok(calendar.archive.some(r=>r.id===invoice.id));assert.ok(calendar.archive.some(r=>r.id===expense.id));
});
test('Quote and invoice PDFs download; long descriptions paginate',async()=>{
  const duplicated=await ok('/quotes/'+quote.id+'/duplicate',{method:'POST',body:{}});await ok('/quotes/'+duplicated.id,{method:'PUT',body:quoteBody({title:'Devis de validation multipage',items:Array.from({length:28},(_,i)=>line(99900,{position:i,name:'Prestation '+(i+1),description:'Conception et développement d’une interface claire, responsive et accessible. '.repeat(3)}))})});
  mkdirSync('tmp/pdfs',{recursive:true});for(const [path,name] of [[`/quotes/${duplicated.id}/pdf`,'devis-long.pdf'],[`/invoices/${invoice.id}/pdf`,'facture.pdf']]){const r=await call(path);assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.subarray(0,5).toString(),'%PDF-');assert.ok(r.data.length>2000);writeFileSync('tmp/pdfs/'+name,r.data);}
});
test('A prior project payment can be allocated to a later invoice without double collection',async()=>{
  const payment=await ok('/payments',{method:'POST',body:{clientId:client.id,projectId:project.id,amountCents:1000,date:now,method:'transfer',requestKey:randomUUID()}});
  const i=await ok('/invoices',{method:'POST',body:{clientId:client.id,projectId:project.id,title:'QA paiement déjà reçu',issuedDate:now,dueDate:now,items:[line(1000)]}});
  await ok('/invoices/'+i.id+'/status',{method:'PATCH',body:{status:'sent'}});
  await ok('/payments/'+payment.id+'/allocate',{method:'POST',body:{invoiceId:i.id}});
  await ok('/payments/'+payment.id+'/allocate',{method:'POST',body:{invoiceId:i.id}});
  assert.equal((await ok('/invoices/'+i.id)).status,'paid');
  const p=await ok('/projects/'+project.id);assert.equal(p.payments.reduce((s,v)=>s+v.amountCents,0),51000);
  const paidInvoices=await ok('/invoices?status=paid&limit=1');assert.equal(paidInvoices.count,2);assert.equal(paidInvoices.rows.length,1);
});
test('Apport d’affaires: barème, exigibilité après encaissement, dépense liée et seuil DAS2',async()=>{
  assert.equal((await call('/referrers',{method:'POST',body:{name:'QA sans SIRET',status:'regular'}})).status,400);
  referrer=await ok('/referrers',{method:'POST',body:{name:'QA Apporteur',email:'apporteur@birostweb.example',conventionDate:now}});
  client=await ok('/clients/'+client.id,{method:'PATCH',body:{...client,referrerId:referrer.id}});
  assert.equal((await ok('/clients/'+client.id)).referrer.name,'QA Apporteur');
  assert.equal((await call('/commissions',{method:'POST',body:{referrerId:referrer.id,clientId:client.id,baseCents:300000,rateBps:1000,date:addDays(now,1)}})).status,400);
  assert.equal((await call('/commissions',{method:'POST',body:{referrerId:referrer.id,clientId:other.id,projectId:project.id,baseCents:300000,rateBps:1000,date:now}})).status,400);
  commission=await ok('/commissions',{method:'POST',body:{referrerId:referrer.id,clientId:client.id,projectId:project.id,baseCents:300000,rateBps:1000,date:now}});
  assert.equal(commission.amountCents,30000);assert.equal(commission.status,'awaiting');
  assert.equal((await call('/commissions/'+commission.id+'/settle',{method:'POST',body:{paidDate:now}})).status,409);
  await ok('/commissions/'+commission.id+'/status',{method:'PATCH',body:{status:'due'}});
  const settled=await ok('/commissions/'+commission.id+'/settle',{method:'POST',body:{paidDate:now,method:'transfer',reference:'QA virement',recordExpense:true}});
  assert.equal(settled.status,'settled');assert.equal((await ok('/expenses/'+settled.expenseId)).totalCents,30000);
  assert.equal((await call('/commissions/'+commission.id,{method:'DELETE'})).status,409);
  const first=(await ok('/referrers')).rows.find(r=>r.id===referrer.id);
  assert.equal(first.paidYearCents,30000);assert.equal(first._count.clients,1);assert.equal(first.das2,false);
  const big=await ok('/commissions',{method:'POST',body:{referrerId:referrer.id,clientId:client.id,baseCents:2500000,rateBps:1000,date:now}});
  await ok('/commissions/'+big.id+'/status',{method:'PATCH',body:{status:'due'}});
  await ok('/commissions/'+big.id+'/settle',{method:'POST',body:{paidDate:now,recordExpense:false}});
  assert.equal((await ok('/referrers')).rows.find(r=>r.id===referrer.id).das2,true);
  await ok('/commissions/'+commission.id+'/status',{method:'PATCH',body:{status:'due'}});
  assert.equal((await call('/expenses/'+settled.expenseId)).status,404);
  await ok('/commissions/'+commission.id,{method:'DELETE'});
  const journal=await ok('/commissions?referrerId='+referrer.id);
  assert.equal(journal.count,1);assert.equal(journal.stats.settledCents,250000);
});
test('Archiving retains history and document removal removes access',async()=>{
  await ok('/clients/'+client.id,{method:'PATCH',body:{...client,status:'archived'}});const c=await ok('/clients/'+client.id);assert.equal(c.status,'archived');assert.ok(c.projects.length);assert.equal((await call('/quotes',{method:'POST',body:quoteBody()})).status,400);
  await ok('/documents/'+document.id,{method:'DELETE'});assert.equal((await call('/documents/'+document.id+'/download')).status,404);
  await ok('/auth/logout',{method:'POST'});assert.equal((await call('/auth/me')).status,401);
});
