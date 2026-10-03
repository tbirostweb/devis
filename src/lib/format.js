export const money=(n=0,decimals=false)=>new Intl.NumberFormat('fr-FR',{style:'currency',currency:'EUR',maximumFractionDigits:decimals?2:0,minimumFractionDigits:decimals?2:0}).format(n/100);
export const dateLabel=(s,short=false)=>s?new Intl.DateTimeFormat('fr-FR',{day:'2-digit',month:short?'short':'long',...(!short?{year:'numeric'}:{}),timeZone:'Europe/Paris'}).format(new Date(s.length===10?s+'T12:00:00Z':s)):'—';
export const today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Paris'}).format(new Date());
export const addDays=(s,n)=>{const d=new Date(s+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
export const paid=(r)=>r.payments?.reduce((a,p)=>a+p.amountCents,0)||0;
export const initials=(s='')=>s.split(' ').slice(0,2).map(v=>v[0]).join('').toUpperCase();
export const progress=(p)=>p.tasks?.length?Math.round(p.tasks.filter(t=>t.done).length/p.tasks.length*100):0;
export const sizeLabel=n=>n>1048576?`${(n/1048576).toFixed(1)} Mo`:`${Math.max(1,Math.round(n/1024))} Ko`;
export function downloadCsv(name,headers,rows){const encode=v=>`"${String(v??'').replace(/^[=+@-]/,"'$&").replaceAll('"','""')}"`;const blob=new Blob(['\ufeff'+[headers,...rows].map(row=>row.map(encode).join(';')).join('\r\n')],{type:'text/csv;charset=utf-8'});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
