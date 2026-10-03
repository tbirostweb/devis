import PDFDocument from 'pdfkit';
import {totals,lineTotal} from '../shared/money.js';
import {lineSchema} from '../shared/contracts.js';
import {resolve} from 'node:path';
const euro=n=>(n/100).toFixed(2).replace('.',',')+' EUR';
const clean=s=>String(s??'').replace(/[\u202f\u00a0]/g,' ').replace(/[\u2011\u2013\u2014]/g,'-');
export async function makePdf(record,kind,logo){
  const doc=new PDFDocument({size:'A4',margin:44,bufferPages:true,info:{Title:`${kind} ${record.reference}`,Author:'Birostweb'}}),chunks=[];
  doc.registerFont('BW',resolve('public/fonts/ibmplexsans-400-latin.ttf'));
  doc.registerFont('BW-Bold',resolve('public/fonts/ibmplexsans-600-latin.ttf'));
  const done=new Promise((res,rej)=>{doc.on('data',c=>chunks.push(c));doc.on('end',()=>res(Buffer.concat(chunks)));doc.on('error',rej);});
  const ink='#231F20',accent='#F0451E',muted='#6E6A5F',width=507;
  const text=(s,x,y,opts={})=>doc.fillColor(opts.color||ink).font(opts.bold?'BW-Bold':'BW').fontSize(opts.size||10).text(clean(s),x,y,{width:opts.width||width,...opts});
  function header(){doc.rect(0,0,595,8).fill(accent);text('BIROSTWEB.',44,34,{size:25,bold:true});if(logo){try{doc.image(logo,440,32,{fit:[110,45]});}catch{}}text(`${kind.toUpperCase()} / ${record.reference}`,44,80,{size:11,color:accent});doc.moveTo(44,104).lineTo(551,104).strokeColor('#CFCABC').stroke();doc.y=120;}
  function room(height){if(doc.y+height>760){doc.addPage();header();}}
  header();const issuer=record.issuerSnapshot,client=record.clientSnapshot;
  text('ÉMETTEUR',44,124,{size:9,color:muted});text('CLIENT',310,124,{size:9,color:muted});
  const left=[issuer.name,issuer.owner,issuer.address,issuer.email,issuer.phone,issuer.siret?`SIRET ${issuer.siret}`:''].filter(Boolean).join('\n');
  const right=[client.name,client.contact,client.address,client.email,client.siret?`SIRET ${client.siret}`:''].filter(Boolean).join('\n');
  text(left,44,142,{width:235,lineGap:4});const ly=doc.y;text(right,310,142,{width:241,lineGap:4});doc.y=Math.max(ly,doc.y)+24;
  text(record.title,44,doc.y,{size:18,bold:true});doc.y+=10;text(`Date : ${record.issuedDate}   |   ${kind==='Devis'?'Valable jusqu’au':'Échéance'} : ${record.validUntil||record.dueDate}`,44,doc.y,{color:muted});doc.y+=18;
  if(record.status==='draft'){text('BROUILLON - document non émis',44,doc.y,{bold:true,color:accent});doc.y+=15;}
  let section='';
  for(const raw of record.items){const item=lineSchema.parse(raw);const fullName=`${item.name}${item.optional?' (option'+(item.selected?' retenue':' non retenue')+')':''}`;const desc=[item.description,`${item.quantityMilli/1000} x ${euro(item.unitCents)}${item.discountBps?` | Remise ${item.discountBps/100}%`:''} | TVA ${item.vatBps/100}%${item.frequency==='monthly'?' | /mois':item.frequency==='yearly'?' | /an':''}`].filter(Boolean).join('\n');const h=doc.font('BW').fontSize(9).heightOfString(clean(desc),{width:365,lineGap:3})+doc.font('BW-Bold').fontSize(11).heightOfString(clean(fullName),{width:365})+22;room(h+35);
    if(item.section!==section){section=item.section;doc.rect(44,doc.y,507,23).fill('#E5E2D6');text(section.toUpperCase(),52,doc.y+7,{size:9,bold:true});doc.y+=17;}
    const y=doc.y+9;text(fullName,44,y,{bold:true,size:11,width:365});const nameBottom=doc.y;text(euro(lineTotal(item,record.discountBps).total),422,y,{width:129,align:'right',bold:true});text(desc,44,nameBottom+5,{size:9,width:365,color:muted,lineGap:3});doc.y+=12;doc.moveTo(44,doc.y).lineTo(551,doc.y).strokeColor('#E5E2D6').stroke();
  }
  const t=totals(record.items.map(i=>lineSchema.parse(i)),record.discountBps,record.depositBps??0);room(220);doc.y+=20;
  for(const [label,amount,strong] of [['Sous-total HT',t.subtotal,false],['Remises',-t.discount,false],['TVA',t.tax,false],['TOTAL TTC',t.total,true],...(kind==='Devis'?[['Acompte à la commande',t.deposit,false],['Solde',t.remaining,false]]:[]),...(t.monthly?[['Récurrent mensuel TTC',t.monthly,true]]:[]),...(t.yearly?[['Récurrent annuel TTC',t.yearly,true]]:[])]){const y=doc.y;text(label,260,y,{width:190,bold:strong,color:strong?accent:ink});text(euro(amount),440,y,{width:111,align:'right',bold:strong,color:strong?accent:ink});doc.y=y+23;}
  const terms=[record.estimatedDelay?`Délai estimé : ${record.estimatedDelay}`:'',record.conditions,record.legalNotice,record.proClient&&issuer.latePaymentNotice?issuer.latePaymentNotice:'',issuer.iban?`IBAN : ${issuer.iban}`:''].filter(Boolean);
  for(const paragraph of terms){const h=doc.font('BW').fontSize(9).heightOfString(clean(paragraph),{width:507,lineGap:3});room(h+20);text(paragraph,44,doc.y+10,{size:9,color:muted,lineGap:3});doc.y+=10;}
  if(kind==='Devis'&&record.notesOnPdf&&String(record.notes??'').trim()){const body=clean(record.notes);const h=doc.font('BW').fontSize(9).heightOfString(body,{width:507,lineGap:3});room(h+34);text('NOTE / PROJET',44,doc.y+14,{size:9,bold:true,color:accent});text(record.notes,44,doc.y+4,{size:9,color:ink,lineGap:3});doc.y+=10;}
  if(kind==='Devis'){room(60);text('Bon pour accord - date et signature du client',44,doc.y+18,{size:10});}
  const {count}=doc.bufferedPageRange();for(let i=0;i<count;i++){doc.switchToPage(i);doc.moveTo(44,772).lineTo(551,772).strokeColor('#CFCABC').stroke();text(`${issuer.name} / ${record.reference}`,44,782,{size:8,color:muted,lineBreak:false});text(`${i+1} / ${count}`,490,782,{width:61,align:'right',size:8,color:muted,lineBreak:false});}
  doc.end();return done;
}
