// Project obligations and independent invoices are counted once. Subscription
// payments never reduce the outstanding balance of an unrelated project.
export const paidCents=record=>(record.payments||[]).reduce((sum,p)=>sum+p.amountCents,0);
export function clientLedger(client){
  const projects=client.projects||[],invoices=(client.invoices||[]).filter(i=>!i.projectId&&!['draft','cancelled'].includes(i.status));
  const projectPaid=p=>(client.payments||[]).filter(payment=>payment.projectId===p.id).reduce((s,p)=>s+p.amountCents,0);
  return {totalCents:projects.reduce((s,p)=>s+p.totalCents,0)+invoices.reduce((s,i)=>s+i.totalCents,0),paidCents:paidCents(client),remainingCents:projects.reduce((s,p)=>s+Math.max(0,p.totalCents-projectPaid(p)),0)+invoices.reduce((s,i)=>s+Math.max(0,i.totalCents-paidCents(i)),0)};
}
