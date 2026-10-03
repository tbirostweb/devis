import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,unlink,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileTypeFromBuffer} from 'file-type';
import {z} from 'zod';
import {db,transaction,audit,found,HttpError} from '../db.js';
import {querySchema} from './records.js';
import {makePdf} from '../pdf.js';
const root=resolve(process.env.STORAGE_PATH||'storage');
const publicDoc=({storageKey,...doc})=>doc;
export async function files(app){
  await mkdir(root,{recursive:true,mode:0o700});
  app.get('/api/documents',async(req)=>{const q=querySchema.parse(req.query);const where={name:{contains:q.q}};const [rows,count]=await Promise.all([db.document.findMany({where,include:{client:true,project:true,quote:true,invoice:true,expense:true,referrer:true},orderBy:{createdAt:'desc'},take:q.limit,skip:(q.page-1)*q.limit}),db.document.count({where})]);return {rows:rows.map(publicDoc),count,page:q.page};});
  app.post('/api/documents',async(req)=>{
    const links=z.object({clientId:z.string().optional(),projectId:z.string().optional(),quoteId:z.string().optional(),invoiceId:z.string().optional(),expenseId:z.string().optional(),referrerId:z.string().optional()}).parse(req.query);
    // Resolve associations before reading the file and reject cross-client links.
    let clientId=links.clientId;
    for(const [key,model] of [['projectId','project'],['quoteId','quote'],['invoiceId','invoice'],['expenseId','expense'],['referrerId','referrer']])if(links[key]){const entity=found(await db[model].findUnique({where:{id:links[key]}}));if(entity.clientId){if(clientId&&clientId!==entity.clientId)throw new HttpError(400,'Les documents doivent appartenir au même client.');clientId=entity.clientId;}}
    if(clientId)found(await db.client.findUnique({where:{id:clientId}}));
    const file=await req.file();if(!file)throw new HttpError(400,'Sélectionnez un fichier.');
    const buffer=await file.toBuffer(),type=await fileTypeFromBuffer(buffer);
    if(file.file.truncated)throw new HttpError(413,'Fichier trop volumineux (10 Mo maximum).');
    if(!type||!['application/pdf','image/jpeg','image/png'].includes(type.mime))throw new HttpError(400,'Formats acceptés : PDF, JPEG et PNG uniquement.');
    const storageKey=`${randomUUID()}.${type.ext}`;await writeFile(join(root,storageKey),buffer,{flag:'wx',mode:0o600});
    try{return await transaction(async tx=>{const d=await tx.document.create({data:{...links,clientId,name:file.filename.replace(/[\x00-\x1f/\\]/g,'_').slice(0,180),mime:type.mime,size:buffer.length,storageKey}});await audit(tx,req.user.id,`Document ajouté · ${d.name}`,'documents',d.id,{clientId,projectId:links.projectId,quoteId:links.quoteId,invoiceId:links.invoiceId});return publicDoc(d);});}
    catch(e){await unlink(join(root,storageKey));throw e;}
  });
  app.get('/api/documents/:id/download',async(req,reply)=>{const {id}=z.object({id:z.string()}).parse(req.params),doc=found(await db.document.findUnique({where:{id}}));const data=await readFile(join(root,doc.storageKey));reply.header('Content-Disposition',`attachment; filename="document.${doc.storageKey.split('.').at(-1)}"; filename*=UTF-8''${encodeURIComponent(doc.name)}`).header('X-Content-Type-Options','nosniff').type(doc.mime);return reply.send(data);});
  app.get('/api/documents/:id/image',async(req,reply)=>{const {id}=z.object({id:z.string()}).parse(req.params),doc=found(await db.document.findUnique({where:{id}}));if(!['image/jpeg','image/png'].includes(doc.mime))throw new HttpError(400,'Ce document n’est pas une image.');return reply.type(doc.mime).send(await readFile(join(root,doc.storageKey)));});
  app.delete('/api/documents/:id',async(req)=>{const {id}=z.object({id:z.string()}).parse(req.params);const doc=await transaction(async tx=>{const d=found(await tx.document.findUnique({where:{id}}));const settings=await tx.settings.findUnique({where:{id:'company'}});if(settings?.data?.logoDocumentId===id)throw new HttpError(409,'Retirez ce logo des paramètres avant de le supprimer.');await tx.document.delete({where:{id}});await audit(tx,req.user.id,`Document supprimé · ${d.name}`,'documents',id,{clientId:d.clientId??undefined,projectId:d.projectId??undefined});return d;});await unlink(join(root,doc.storageKey)).catch(e=>req.log.error(e));return {ok:true};});
  for(const kind of ['quotes','invoices'])app.get(`/api/${kind}/:id/pdf`,async(req,reply)=>{const {id}=z.object({id:z.string()}).parse(req.params);const record=found(await db[kind==='quotes'?'quote':'invoice'].findUnique({where:{id},include:{items:{orderBy:{position:'asc'}}}}));let logo;const logoId=record.issuerSnapshot?.logoDocumentId;if(logoId){const doc=await db.document.findUnique({where:{id:logoId}});if(doc&&['image/jpeg','image/png'].includes(doc.mime))logo=await readFile(join(root,doc.storageKey));}const bytes=await makePdf(record,kind==='quotes'?'Devis':'Facture',logo);return reply.type('application/pdf').header('Content-Disposition',`inline; filename="${record.reference}.pdf"`).send(bytes);});
}
