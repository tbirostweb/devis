import 'dotenv/config';
import argon2 from 'argon2';
import {randomUUID} from 'node:crypto';
import {db,today,addDays} from '../server/db.js';
import {defaultSettings} from '../server/routes/records.js';
import {totals} from '../shared/money.js';
const email=(process.env.ADMIN_EMAIL||'').toLowerCase(),password=process.env.ADMIN_PASSWORD||'';
if(!email||password.length<14)throw new Error('Définissez ADMIN_EMAIL et ADMIN_PASSWORD (14 caractères minimum) dans .env.');
import {isPwned} from '../server/pwned.js';
if(await isPwned(password))console.warn('AVERTISSEMENT : le mot de passe administrateur figure dans une fuite connue (HIBP). Changez-le après la première connexion.');
if(process.env.NODE_ENV==='production'&&process.env.SEED_DEMO==='true')throw new Error('Les données de démonstration sont interdites en production.');
const existingUser=await db.user.findUnique({where:{email}});
const user=existingUser||await db.user.create({data:{email,name:'Théo Birost',passwordHash:await argon2.hash(password,{type:argon2.argon2id,memoryCost:65536,timeCost:3,parallelism:1})}});
await db.settings.upsert({where:{id:'company'},create:{id:'company',data:defaultSettings},update:{}});
const catalogue=[
  ['Création de site','Site vitrine',99900,'once',true,'Un site clair et rapide, responsive, SEO technique et mise en ligne.','fixed',false],
  ['Création de site','Boutique en ligne',189900,'once',true,'Catalogue, commandes et intégration du paiement.','fixed',false],
  ['Création de site','Application web / Full-stack',299900,'once',true,'Application métier, API, authentification et base de données.','fixed',false],
  ['Création de site','Projet sur mesure',0,'once',true,'Prix personnalisé après étude du besoin.','custom',false],
  ['Hébergement','Votre hébergement',0,'once',false,'Déploiement chez votre hébergeur. La maintenance reste facultative.','fixed',false],
  ['Hébergement','Essentiel · VPS-1',4500,'monthly',false,'Hébergement, HTTPS, mises à jour, sécurité, sauvegardes et support inclus.','fixed',true],
  ['Hébergement','Pro · VPS-2',6900,'monthly',false,'Toutes les prestations Essentiel, davantage de ressources et support prioritaire.','fixed',true],
  ['Maintenance','Suivi mensuel',3900,'monthly',false,'Mises à jour et suivi sur votre propre hébergement. Déjà inclus dans Essentiel et Pro.','fixed',false],
  ['Maintenance',"Pack d’heures",3900,'once',false,'Modifications et évolutions à la carte.','hourly',false],
  ['Maintenance','Pack 5 h',17500,'once',false,'5 heures de modifications, valables 24 mois.','fixed',false],
  ['Maintenance','Pack 10 h',32000,'once',false,'10 heures de modifications, valables 24 mois.','fixed',false],
];
for(const [category,name,unitCents,frequency,indicative,description,pricing,includesMaintenance] of catalogue){const c=await db.serviceCategory.upsert({where:{name:category},create:{name:category},update:{}});const id='seed-service-'+catalogue.findIndex(row=>row[1]===name);await db.service.upsert({where:{id},create:{id,categoryId:c.id,name,unitCents,frequency,indicative,description,pricing,includesMaintenance},update:{}});}
if(process.env.SEED_DEMO==='true'&&!await db.settings.findUnique({where:{id:'demo-seeded'}})){
  await db.$transaction(async tx=>{
    const now=today(),year=now.slice(0,4),month=now.slice(0,7);
    const clientNames=['Acme Studio','Hydrogen','Maison Sillage','Atelier Forma','Collectif Nord','Maison Camille','Léo Martin','Noma Architecture','Éclat Café','Studio Grain','Les Jardins de Lou','Matière Libre'];
    const projectNames=['Refonte du site vitrine','Plateforme de réservation','Boutique en ligne','Identité & site vitrine','Espace membres','Site de collection','Portfolio photographie','Site agence','Click & collect','Site éditorial','Site vitrine','Catalogue en ligne'];
    const states=['progress','progress','review','waiting','pending','delivered','delivered','completed','progress','review','pending','delivered'];
    const amounts=[129900,429900,249900,179900,329900,219900,149900,389900,199900,229900,99900,159900];
    const clients=[];for(let n=0;n<clientNames.length;n++){clients.push(await tx.client.create({data:{name:clientNames[n],contact:['Camille Laurent','Thomas Leroy','Sarah Moreau'][n%3],email:`contact@demo-${n+1}.example`,phone:`06 00 00 00 ${String(n+10)}`,address:`${n+1} rue de Démonstration, 75011 Paris`,status:n===10?'prospect':'active',notes:'Dossier fictif de démonstration.'}}));}
    const issuer={...defaultSettings,name:'Birostweb · démonstration',address:'Adresse de démonstration',siret:'00000000000000'};
    let fac=0;
    for(let n=0;n<clients.length;n++){
      const c=clients[n],main={name:n%3===0?'Site vitrine':n%3===1?'Application web':'Boutique en ligne',description:'Conception, développement responsive et mise en ligne.',category:'Création de site',section:'Projet',quantityMilli:1000,unitCents:amounts[n],discountBps:0,vatBps:0,frequency:'once',optional:false,selected:true,position:0};
      const items=[main,...(n<8?[{...main,name:n%2?'Pro · VPS-2':'Essentiel · VPS-1',description:'Hébergement et suivi technique inclus.',category:'Hébergement',section:'Accompagnement',unitCents:n%2?6900:4500,frequency:'monthly',position:1}]:[])];
      const calc=totals(items),status=n===10?'sent':n===11?'declined':'accepted';
      const q=await tx.quote.create({data:{reference:`DEV-${year}-${String(n+1).padStart(3,'0')}`,clientId:c.id,title:projectNames[n],status,issuedDate:addDays(now,-25-n),validUntil:addDays(now,n===10?2:15),totalCents:calc.total,recurringCents:calc.mrr,depositBps:3000,conditions:defaultSettings.conditions,legalNotice:defaultSettings.legalNotice,estimatedDelay:'4 à 6 semaines',issuerSnapshot:issuer,clientSnapshot:{name:c.name,contact:c.contact,address:c.address,email:c.email,siret:''},items:{create:items}}});
      if(status!=='accepted')continue;
      const p=await tx.project.create({data:{reference:`PRJ-${year}-${String(n+1).padStart(3,'0')}`,clientId:c.id,quoteId:q.id,title:projectNames[n],status:states[n],orderDate:addDays(now,-20-n),startDate:addDays(now,-14-n),dueDate:addDays(now,[5,12,2,18,24,-15,-20,-10,8,4][n]),totalCents:calc.total,recurringCents:calc.mrr,depositBps:3000,notes:'Dossier de démonstration. Les coordonnées et les paiements sont fictifs.',items:{create:items},tasks:{create:['Maquette','Développement','Validation client','Mise en production','Facture finale'].map((title,k)=>({title,position:k,done:k<(n%4)+1}))}}});
      if(n<8)await tx.subscription.create({data:{clientId:c.id,projectId:p.id,name:items[1].name,category:'Hébergement',amountCents:items[1].unitCents,frequency:'monthly',startDate:addDays(now,-30),nextDate:addDays(now,3+n)}});
      // Paid historical invoices provide a realistic, ledger-backed annual chart.
      const historicMonth=Math.min(Number(now.slice(5,7)),1+n%Number(now.slice(5,7)));
      const issuedDate=`${year}-${String(historicMonth).padStart(2,'0')}-01`;
      const i=await tx.invoice.create({data:{reference:`FAC-${year}-${String(++fac).padStart(3,'0')}`,clientId:c.id,projectId:p.id,quoteId:q.id,title:projectNames[n],kind:'final',status:'sent',issuedDate,dueDate:n<3?addDays(now,n===0?-3:n*3):addDays(issuedDate,20),totalCents:main.unitCents,conditions:defaultSettings.conditions,legalNotice:defaultSettings.legalNotice,issuerSnapshot:issuer,clientSnapshot:q.clientSnapshot,items:{create:[main]}}});
      const full=['completed','delivered'].includes(states[n]);const amount=full?main.unitCents:Math.round(main.unitCents*.4);
      await tx.payment.create({data:{clientId:c.id,projectId:p.id,invoiceId:i.id,amountCents:amount,date:n<3?`${month}-0${n+2}`:issuedDate,method:'transfer',reference:`DEMO-${n+1}`,comment:'Encaissement fictif',requestKey:randomUUID()}});
      if(n<5)await tx.activityLog.create({data:{userId:user.id,action:['Paiement reçu · Hydrogen','Projet passé en validation · Maison Sillage','Devis accepté · Acme Studio','Facture préparée · Atelier Forma','Client créé · Collectif Nord'][n],entity:n===0?'invoices':'projects',entityId:n===0?i.id:p.id,clientId:c.id,projectId:p.id,createdAt:new Date(Date.now()-n*3600000)}});
    }
    for(let m=1;m<=Number(now.slice(5,7));m++){for(const [supplier,netCents,vatBps,category] of [['OVHcloud',6900,2000,'Hébergement'],['Figma',1500,0,'Logiciels'],['Adobe',5999,2000,'Logiciels']]){await tx.expense.create({data:{supplier,date:`${year}-${String(m).padStart(2,'0')}-01`,dueDate:`${year}-${String(m).padStart(2,'0')}-01`,netCents,vatBps,totalCents:netCents+Math.round(netCents*vatBps/10000),category,method:'card',paid:true,comment:'Dépense fictive de démonstration.'}});}}
    for(const [prefix,value] of [['DEV',12],['PRJ',10],['FAC',fac]])await tx.counter.upsert({where:{key:`${prefix}-${year}`},create:{key:`${prefix}-${year}`,value},update:{value}});
    await tx.settings.create({data:{id:'demo-seeded',data:{date:now}}});
  },{timeout:30000});
}
console.log('Administrateur, catalogue et données demandées initialisés. Le mot de passe existant n’a pas été modifié.');
await db.$disconnect();
