import { reactive } from 'vue';
export const session=reactive({user:null,csrf:'',ready:false});
export const ui=reactive({toasts:[],revision:0});
export function notify(message,type='success'){const id=crypto.randomUUID();ui.toasts.push({id,message,type});setTimeout(()=>{ui.toasts=ui.toasts.filter(t=>t.id!==id);},5500);}
export async function api(path,options={}){
  const isForm=options.body instanceof FormData;
  const res=await fetch(`/api${path}`,{credentials:'same-origin',...options,headers:{...(!isForm&&options.body?{'Content-Type':'application/json'}:{}),...(options.method&&!['GET','HEAD'].includes(options.method)?{'x-csrf-token':session.csrf}:{}),...options.headers},body:options.body?(isForm?options.body:JSON.stringify(options.body)):undefined});
  const data=await res.json().catch(()=>({message:'Réponse du serveur invalide.'}));
  if(!res.ok){if(res.status===401){session.user=null;session.csrf='';}throw new Error(data.message||'Une erreur est survenue.');}return data;
}
export async function restore(){try{Object.assign(session,await api('/auth/me'));}catch{session.user=null;}finally{session.ready=true;}}
export async function mutate(path,method,body,message='Enregistré.'){const r=await api(path,{method,body});ui.revision++;notify(message);return r;}
