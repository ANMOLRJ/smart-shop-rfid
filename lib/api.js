'use client';
export async function api(action, payload={}, method='POST'){
 const token=typeof window!=='undefined'?localStorage.getItem('smartshop_token'):null;
 const body={action,...payload};
 const url='/api';
 const headers={'Content-Type':'application/json'};
 if(token)headers.Authorization=`Bearer ${token}`;
 let r;
 if(method==='GET'){
   const qs=new URLSearchParams();Object.entries(body).forEach(([k,v])=>qs.set(k,typeof v==='object'?JSON.stringify(v):String(v)));
   r=await fetch(`${url}?${qs.toString()}`,{cache:'no-store',headers});
 }else r=await fetch(url,{method:'POST',headers,body:JSON.stringify(body),cache:'no-store'});
 const text=await r.text();
 let data;try{data=JSON.parse(text)}catch{throw new Error(`API returned non-JSON (${r.status})`)}
 if(!r.ok||data.ok===false)throw new Error(data.error||`Request failed (${r.status})`);
 return data;
}
export async function authApi(action,payload={}){return api(action,payload,'POST')}
