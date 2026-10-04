import 'dotenv/config';
import {createHash} from 'node:crypto';
import {createReadStream, statSync} from 'node:fs';
import {PrismaClient} from '@prisma/client';
import {protectIbans,ibanKey} from './iban.js';
// Chiffrement des IBAN existants. Abandon AVANT toute connexion si la sauvegarde n'est pas attestée
// (BACKUP_VERIFIED=true) ou, lorsque BACKUP_FILE est fourni, si le fichier est vide ou si son SHA-256
// ne correspond pas à BACKUP_SHA256. Transaction unique : toute erreur annule l'ensemble.
// Idempotent : les valeurs déjà chiffrées (préfixe v1:) et les lignes inchangées ne sont pas réécrites.
if(process.env.BACKUP_VERIFIED !== 'true') throw new Error('Sauvegarde/restauration vérifiée requise : BACKUP_VERIFIED=true.');
if(process.env.BACKUP_FILE){
 const expected=(process.env.BACKUP_SHA256||'').toLowerCase();
 if(!/^[a-f0-9]{64}$/.test(expected)) throw new Error('BACKUP_SHA256 (64 caractères hex) requis avec BACKUP_FILE.');
 if(!statSync(process.env.BACKUP_FILE).size) throw new Error('Sauvegarde vide : migration abandonnée.');
 const hash=createHash('sha256'); for await (const chunk of createReadStream(process.env.BACKUP_FILE)) hash.update(chunk);
 if(hash.digest('hex')!==expected) throw new Error('Empreinte de sauvegarde différente : migration abandonnée.');
}
const key=ibanKey();
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const db=new PrismaClient();
try {
 const counts=await db.$transaction(async tx=>{
  const n={referrer:0,settings:0,quote:0,invoice:0};
  for(const row of await tx.referrer.findMany({select:{id:true,iban:true}})){
   const iban=protectIbans({iban:row.iban},true,key).iban;
   if(iban!==row.iban){await tx.referrer.update({where:{id:row.id},data:{iban}});n.referrer++;}
  }
  for(const row of await tx.settings.findMany()){
   const data=protectIbans(row.data,true,key);
   if(!same(data,row.data)){await tx.settings.update({where:{id:row.id},data:{data}});n.settings++;}
  }
  for(const model of ['quote','invoice']) for(const row of await tx[model].findMany({select:{id:true,issuerSnapshot:true,clientSnapshot:true,updatedAt:true}})){
   const issuerSnapshot=protectIbans(row.issuerSnapshot,true,key), clientSnapshot=protectIbans(row.clientSnapshot,true,key);
   if(!same(issuerSnapshot,row.issuerSnapshot)||!same(clientSnapshot,row.clientSnapshot)){
    // updatedAt conservé : le chiffrement n'est pas une modification métier du document.
    await tx[model].update({where:{id:row.id},data:{issuerSnapshot,clientSnapshot,updatedAt:row.updatedAt}});n[model]++;
   }
  }
  // Contrôle avant validation : tout IBAN relu doit être chiffré et déchiffrable avec la clé fournie.
  const check=v=>{protectIbans(v,false,key);if(JSON.stringify(v).match(/"iban":"(?!v1:)[^"]+"/))throw new Error('IBAN non chiffré détecté : annulation.');};
  for(const r of await tx.referrer.findMany({select:{iban:true}})) check(r);
  for(const r of await tx.settings.findMany({select:{data:true}})) check(r.data);
  for(const model of ['quote','invoice']) for(const r of await tx[model].findMany({select:{issuerSnapshot:true,clientSnapshot:true}})) check(r);
  return n;
 },{timeout:120000});
 console.log('Migration IBAN terminée, lignes chiffrées :', JSON.stringify(counts));
} finally {await db.$disconnect();}
