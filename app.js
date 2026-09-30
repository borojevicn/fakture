/* Fakture Borojević — aplikacija (Supabase + jsPDF) */
(function(){
"use strict";

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const nf = new Intl.NumberFormat("sr-RS",{minimumFractionDigits:2,maximumFractionDigits:2});
const fmt = n => nf.format(Math.round((Number(n)||0)*100)/100);
const fmtQty = q => nf.format(Number(q)||0).replace(",00","");
const fmtDate = s => { if(!s) return ""; const [y,m,d]=String(s).slice(0,10).split("-"); return `${d}.${m}.${y}.`; };
const iso = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
const todayISO = () => iso(new Date());
const addDays = (s,n) => { if(!s) return ""; const d=new Date(s+"T00:00:00"); d.setDate(d.getDate()+Number(n||0)); return iso(d); };

const sb = window.supabase.createClient(window.APP_CONFIG.SUPABASE_URL, window.APP_CONFIG.SUPABASE_KEY);

/* ---------- state ---------- */
let settings = {}, clients = [], services = [], invoices = [];
let items = [];              // stavke fakture koja se uređuje
let editingId = null;        // id fakture ako se uređuje postojeća
let editingStatus = "izdata";
let clEditId = null, svEditId = null;

/* ---------- toast ---------- */
let toastT;
function toast(t, err){ let el=document.querySelector(".toast"); if(!el){ el=document.createElement("div"); document.body.appendChild(el);} el.className="toast"+(err?" err":""); el.textContent=t; clearTimeout(toastT); toastT=setTimeout(()=>el.remove(), err?6000:3500); }
function showMsg(id, t, cls){ const m=$(id); m.textContent=t; m.className="msg "+cls; if(cls==="ok") setTimeout(()=>{ m.className="msg"; }, 5000); }

/* ---------- auth ---------- */
async function boot(){
  const { data:{ session } } = await sb.auth.getSession();
  if(session) await enterApp(session); else showLogin();
  sb.auth.onAuthStateChange((ev, s) => { if(ev==="SIGNED_OUT") showLogin(); });
}
function showLogin(){ $("viewApp").classList.add("hidden"); $("viewLogin").classList.remove("hidden"); }
$("loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  const btn=$("loginBtn"); btn.disabled=true; btn.textContent="Prijavljivanje…";
  const { data, error } = await sb.auth.signInWithPassword({ email:$("loginEmail").value.trim(), password:$("loginPass").value });
  btn.disabled=false; btn.textContent="Prijavi se";
  if(error){ showMsg("loginMsg", "Pogrešan e-mail ili lozinka.", "err"); return; }
  $("loginMsg").className="msg"; $("loginPass").value="";
  await enterApp(data.session);
});
$("btnLogout").onclick = async () => { await sb.auth.signOut(); showLogin(); };

async function enterApp(session){
  $("whoami").textContent = session.user.email;
  $("viewLogin").classList.add("hidden"); $("viewApp").classList.remove("hidden");
  try{ await loadAll(); newInvoice(); }
  catch(e){ toast("Greška pri učitavanju podataka: "+(e.message||e)+". Da li je pokrenut schema.sql?", true); console.error(e); }
}

/* ---------- data ---------- */
async function loadAll(){
  const [s, c, v, i] = await Promise.all([
    sb.from("settings").select("data").eq("id",1).maybeSingle(),
    sb.from("clients").select("*").order("name"),
    sb.from("services").select("*").order("sort").order("name"),
    sb.from("invoices").select("*").order("issue_date",{ascending:false}).order("number",{ascending:false})
  ]);
  for(const r of [s,c,v,i]) if(r.error) throw r.error;
  settings = (s.data && s.data.data) || {};
  clients = c.data || []; services = v.data || []; invoices = i.data || [];
  renderClientPick(); renderClients(); renderServices(); renderInvoices(); loadSettingsForm();
}
async function reloadClients(){ const r = await sb.from("clients").select("*").order("name"); if(r.error) throw r.error; clients=r.data; renderClientPick(); renderClients(); }
async function reloadServices(){ const r = await sb.from("services").select("*").order("sort").order("name"); if(r.error) throw r.error; services=r.data; renderServices(); renderItems(); }
async function reloadInvoices(){ const r = await sb.from("invoices").select("*").order("issue_date",{ascending:false}).order("number",{ascending:false}); if(r.error) throw r.error; invoices=r.data; renderInvoices(); }

/* ---------- tabs ---------- */
$("tabs").addEventListener("click", e => { const b=e.target.closest("[data-tab]"); if(b) showTab(b.dataset.tab); });
function showTab(name){
  document.querySelectorAll("#tabs button").forEach(b=>b.classList.toggle("active", b.dataset.tab===name));
  document.querySelectorAll(".tab").forEach(t=>t.classList.toggle("hidden", t.id!=="tab-"+name));
  window.scrollTo({top:0});
}

/* ---------- nova faktura ---------- */
function nextInvoiceNo(year){
  const nums = invoices.filter(v=>v.year===year).map(v=>v.number);
  return (nums.length? Math.max(...nums):0) + 1;
}
function newInvoice(){
  editingId = null; editingStatus = "izdata";
  const y = new Date().getFullYear();
  $("invTitle").textContent = "Nova faktura";
  $("invNo").value = `${nextInvoiceNo(y)}/${y}`;
  $("invPlace").value = settings.place || "Kupinovo";
  $("invDate").value = todayISO(); $("svcDate").value = todayISO();
  $("dueDays").value = settings.due_days ?? 8; $("dueDate").value = addDays(todayISO(), settings.due_days ?? 8);
  $("bPick").value=""; $("bName").value=""; $("bAddr").value=""; $("bPib").value=""; $("bMb").value="";
  $("noteVat").value = settings.note_vat || ""; $("noteExtra").value = "";
  items = [blankItem()];
  renderItems(); render();
  $("btnSave").textContent = "Sačuvaj i preuzmi PDF";
}
function blankItem(){ const s=services[0]; return {svc:s?s.name:"", desc:"", unit:s?s.unit:"usluga", qty:1, price:s&&s.default_price?Number(s.default_price):""}; }
function openInvoice(v, asCopy){
  editingId = asCopy ? null : v.id; editingStatus = asCopy ? "izdata" : v.status;
  const y = new Date().getFullYear();
  $("invTitle").textContent = asCopy ? "Nova faktura (kopija "+v.full_no+")" : "Izmena fakture "+v.full_no;
  $("invNo").value = asCopy ? `${nextInvoiceNo(y)}/${y}` : v.full_no;
  $("invPlace").value = v.place||""; $("invDate").value = asCopy? todayISO() : v.issue_date; $("svcDate").value = asCopy? todayISO() : (v.service_date||"");
  const dd = v.due_date && v.issue_date ? Math.round((new Date(v.due_date)-new Date(v.issue_date))/86400000) : (settings.due_days??8);
  $("dueDays").value = dd; $("dueDate").value = addDays($("invDate").value, dd);
  const c = v.client||{};
  $("bPick").value = v.client_id||""; $("bName").value=c.name||""; $("bAddr").value=c.addr||""; $("bPib").value=c.pib||""; $("bMb").value=c.mb||"";
  $("noteVat").value = v.note_vat||""; $("noteExtra").value = v.note_extra||"";
  items = (v.items||[]).map(it=>({svc:it.svc, desc:it.desc||"", unit:it.unit||"usluga", qty:it.qty, price:it.price}));
  if(!items.length) items=[blankItem()];
  renderItems(); render();
  $("btnSave").textContent = asCopy ? "Sačuvaj i preuzmi PDF" : "Sačuvaj izmene i preuzmi PDF";
  showTab("nova");
}

function renderClientPick(){
  const sel=$("bPick"); const cur=sel.value;
  sel.innerHTML = '<option value="">— novi kupac —</option>' + clients.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join("");
  sel.value = cur;
}
$("bPick").addEventListener("change", () => {
  const c = clients.find(x=>x.id===$("bPick").value);
  if(c){ $("bName").value=c.name; $("bAddr").value=c.addr||""; $("bPib").value=c.pib||""; $("bMb").value=c.mb||""; }
  else { $("bName").value=""; $("bAddr").value=""; $("bPib").value=""; $("bMb").value=""; }
  render();
});

function lineTotal(it){ return (Number(it.qty)||0)*(Number(it.price)||0); }
function total(){ return items.reduce((s,it)=>s+lineTotal(it),0); }
function renderItems(){
  const host=$("items"); host.innerHTML="";
  items.forEach((it,i)=>{
    const names = services.map(s=>s.name); if(it.svc && !names.includes(it.svc)) names.unshift(it.svc);
    const opts = names.map(n=>`<option value="${esc(n)}"${n===it.svc?" selected":""}>${esc(n)}</option>`).join("");
    const el=document.createElement("div"); el.className="item";
    el.innerHTML=`
      <div class="item-head"><span class="n">Stavka ${i+1}</span><button class="icon" type="button" title="Ukloni stavku" data-del="${i}" ${items.length===1?"disabled":""}>✕</button></div>
      <div><label for="svc${i}">Usluga</label><select id="svc${i}" data-f="svc" data-i="${i}">${opts}</select></div>
      <div><label for="desc${i}">Opis (opciono)</label><input id="desc${i}" type="text" data-f="desc" data-i="${i}" value="${esc(it.desc)}" placeholder="npr. Kupinovo – Beograd, 2 palete"></div>
      <div class="row">
        <div><label for="unit${i}">Jed. mere</label><input id="unit${i}" type="text" data-f="unit" data-i="${i}" value="${esc(it.unit)}"></div>
        <div><label for="qty${i}">Količina</label><input id="qty${i}" type="number" min="0" step="any" data-f="qty" data-i="${i}" value="${it.qty}"></div>
        <div><label for="price${i}">Cena (RSD)</label><input id="price${i}" type="number" min="0" step="0.01" data-f="price" data-i="${i}" value="${it.price}" placeholder="0,00"></div>
      </div>
      <div class="sum"><span>Iznos stavke</span><b class="mono">${fmt(lineTotal(it))} RSD</b></div>`;
    host.appendChild(el);
  });
}
$("items").addEventListener("input", e => {
  const f=e.target.dataset.f; if(!f) return; const i=+e.target.dataset.i;
  items[i][f]=e.target.value;
  if(f==="svc"){ const s=services.find(x=>x.name===e.target.value); if(s){ items[i].unit=s.unit||"usluga"; $("unit"+i).value=items[i].unit; if(s.default_price && !items[i].price){ items[i].price=Number(s.default_price); $("price"+i).value=items[i].price; } } }
  e.target.closest(".item").querySelector(".sum b").textContent = fmt(lineTotal(items[i]))+" RSD";
  render();
});
$("items").addEventListener("click", e => { const b=e.target.closest("[data-del]"); if(!b) return; items.splice(+b.dataset.del,1); renderItems(); render(); });
$("btnAddItem").onclick = () => { items.push(blankItem()); renderItems(); render(); $("price"+(items.length-1)).focus(); };

document.querySelector("#tab-nova .panel").addEventListener("input", e => {
  if(e.target.id==="dueDays" || e.target.id==="invDate") $("dueDate").value = addDays($("invDate").value, $("dueDays").value);
  render();
});

function data(){
  return {
    no:$("invNo").value.trim(), place:$("invPlace").value.trim(), date:$("invDate").value, svcDate:$("svcDate").value, due:$("dueDate").value, dueDays:$("dueDays").value,
    b:{name:$("bName").value.trim(), addr:$("bAddr").value.trim(), pib:$("bPib").value.trim(), mb:$("bMb").value.trim()},
    noteVat:$("noteVat").value.trim(), noteExtra:$("noteExtra").value.trim(),
    items: items.map(it=>({svc:it.svc, desc:it.desc, unit:it.unit, qty:Number(it.qty)||0, price:Number(it.price)||0, total:lineTotal(it)})),
    total: total(), co: settings, status: editingStatus
  };
}
function render(){ renderSheet(data()); }
function renderSheet(d){
  $("pCName").textContent=d.co.name||""; $("pCAddr").textContent=d.co.addr||"";
  $("pCIds").textContent=["PIB: "+(d.co.pib||""),"MB: "+(d.co.mb||""),d.co.code?"Šifra delatnosti: "+d.co.code:""].filter(Boolean).join("  ·  ");
  $("pCContact").textContent=[d.co.phone?"Tel: "+d.co.phone:"", d.co.email].filter(Boolean).join("  ·  ");
  $("pNo").textContent=d.no||"—"; $("pStorno").classList.toggle("hidden", d.status!=="storno");
  $("pBName").textContent=d.b.name||"—"; $("pBAddr").textContent=d.b.addr;
  $("pBIds").innerHTML=(d.b.pib?`<span>PIB</span><span class="mono">${esc(d.b.pib)}</span>`:"")+(d.b.mb?`<span>MB</span><span class="mono">${esc(d.b.mb)}</span>`:"");
  $("pPlace").textContent=d.place; $("pDate").textContent=fmtDate(d.date); $("pSvcDate").textContent=fmtDate(d.svcDate);
  $("pDue").textContent=d.due?`${fmtDate(d.due)} (${d.dueDays} dana)`:"";
  $("pRows").innerHTML=d.items.map((it,i)=>`<tr><td>${i+1}.</td><td>${esc(it.svc)}${it.desc?`<div class="desc">${esc(it.desc)}</div>`:""}</td><td>${esc(it.unit)}</td><td class="r">${fmtQty(it.qty)}</td><td class="r">${fmt(it.price)}</td><td class="r">${fmt(it.total)}</td></tr>`).join("");
  $("pTotal").textContent=fmt(d.total)+" RSD"; $("totalUi").textContent=fmt(d.total)+" RSD";
  $("pNoteVat").textContent=d.noteVat; $("pNoteExtra").textContent=d.noteExtra;
  $("pAcc").textContent=d.co.acc||""; $("pBank").textContent=d.co.bank||""; $("pRef").textContent=(d.no||"").replace("/","-"); $("pPurpose").textContent="Uplata po fakturi br. "+d.no;
  $("pIssuer").textContent=d.co.owner||""; $("pSigName").textContent=d.co.owner||"";
}
function validate(d){
  const errs=[];
  if(!/^\d+\/\d{4}$/.test(d.no)) errs.push("broj fakture u obliku 12/2026");
  if(!d.date) errs.push("datum izdavanja");
  if(!d.b.name) errs.push("naziv kupca");
  if(!d.items.length || d.items.some(it=>!it.svc || it.qty<=0 || it.price<=0)) errs.push("stavke (usluga, količina i cena)");
  return errs;
}

/* ---------- čuvanje fakture ---------- */
async function ensureClient(b){
  const picked = clients.find(c=>c.id===$("bPick").value);
  const payload = {name:b.name, addr:b.addr, pib:b.pib, mb:b.mb};
  if(picked){
    const changed = ["name","addr","pib","mb"].some(k=>(picked[k]||"")!==payload[k]);
    if(changed){ const r = await sb.from("clients").update(payload).eq("id",picked.id); if(r.error) throw r.error; }
    return picked.id;
  }
  const existing = clients.find(c=>c.name.toLowerCase()===b.name.toLowerCase());
  if(existing){ const r = await sb.from("clients").update(payload).eq("id",existing.id); if(r.error) throw r.error; return existing.id; }
  const r = await sb.from("clients").insert(payload).select().single(); if(r.error) throw r.error;
  return r.data.id;
}
async function saveInvoice(d){
  const [num, year] = d.no.split("/").map(Number);
  const client_id = await ensureClient(d.b);
  const row = { year, number:num, full_no:d.no, issue_date:d.date, service_date:d.svcDate||null, due_date:d.due||null, place:d.place,
    client_id, client:d.b, items:d.items, total:d.total, note_vat:d.noteVat, note_extra:d.noteExtra, updated_at:new Date().toISOString() };
  let r;
  if(editingId){ r = await sb.from("invoices").update(row).eq("id",editingId).select().single(); }
  else { r = await sb.from("invoices").insert(row).select().single(); }
  if(r.error){ if(String(r.error.code)==="23505") throw new Error("Faktura sa brojem "+d.no+" već postoji. Promeni broj."); throw r.error; }
  editingId = r.data.id;
  await Promise.all([reloadClients(), reloadInvoices()]);
  $("bPick").value = client_id;
  $("invTitle").textContent = "Faktura "+d.no+" (sačuvana)";
  $("btnSave").textContent = "Sačuvaj izmene i preuzmi PDF";
  return r.data;
}
$("btnSave").onclick = async () => {
  const d=data(); const errs=validate(d); if(errs.length){ showMsg("msg","Popuni: "+errs.join(", ")+".","err"); return; }
  const btn=$("btnSave"); btn.disabled=true;
  try{ await saveInvoice(d); showMsg("msg","Faktura "+d.no+" sačuvana.","ok"); downloadPdf(d); }
  catch(e){ showMsg("msg","Nije sačuvano: "+(e.message||e),"err"); console.error(e); }
  finally{ btn.disabled=false; }
};
$("btnPdfOnly").onclick = () => { const d=data(); const errs=validate(d); if(errs.length){ showMsg("msg","Popuni: "+errs.join(", ")+".","err"); return; } downloadPdf(d); };
$("btnPrint").onclick = () => { const d=data(); const errs=validate(d); if(errs.length){ showMsg("msg","Popuni: "+errs.join(", ")+".","err"); return; } window.print(); };
$("btnNew").onclick = () => { newInvoice(); showMsg("msg","Nova faktura, broj "+$("invNo").value+".","ok"); };

/* ---------- arhiva faktura ---------- */
function invoiceToData(v){
  const dd = v.due_date && v.issue_date ? Math.round((new Date(v.due_date)-new Date(v.issue_date))/86400000) : "";
  return { no:v.full_no, place:v.place||"", date:v.issue_date, svcDate:v.service_date||"", due:v.due_date||"", dueDays:dd,
    b:v.client||{}, noteVat:v.note_vat||"", noteExtra:v.note_extra||"", items:v.items||[], total:Number(v.total)||0, co:settings, status:v.status };
}
function renderInvoices(){
  const years=[...new Set(invoices.map(v=>v.year))].sort((a,b)=>b-a); const cy=new Date().getFullYear(); if(!years.includes(cy)) years.unshift(cy);
  const ysel=$("fYear"); const cur=ysel.value || String(cy);
  ysel.innerHTML='<option value="">Sve godine</option>'+years.map(y=>`<option value="${y}">${y}</option>`).join(""); ysel.value = years.includes(+cur)?cur:"";
  const q=$("fSearch").value.trim().toLowerCase(), st=$("fStatus").value, yr=ysel.value;
  const rows = invoices.filter(v => (!yr || String(v.year)===yr) && (!st || v.status===st) && (!q || v.full_no.toLowerCase().includes(q) || (v.client&&v.client.name||"").toLowerCase().includes(q)));
  $("invRows").innerHTML = rows.length ? rows.map(v=>`<tr>
    <td class="mono">${esc(v.full_no)}</td><td>${fmtDate(v.issue_date)}</td><td>${esc(v.client&&v.client.name||"")}</td>
    <td>${fmtDate(v.due_date)}${v.status==="izdata"&&v.due_date&&v.due_date<todayISO()?' <span class="pill izdata">kasni</span>':""}</td>
    <td class="r mono">${fmt(v.total)}</td><td><span class="pill ${v.status}">${{izdata:"Izdata",placena:"Plaćena",storno:"Storno"}[v.status]}</span></td>
    <td><div class="rowact">
      <button class="small" data-act="pdf" data-id="${v.id}" type="button">PDF</button>
      <button class="small ghost" data-act="open" data-id="${v.id}" type="button">Otvori</button>
      <button class="small ghost" data-act="copy" data-id="${v.id}" type="button">Kopiraj</button>
      ${v.status==="izdata"?`<button class="small ghost" data-act="paid" data-id="${v.id}" type="button">Plaćena</button>`:""}
      ${v.status==="placena"?`<button class="small ghost" data-act="unpaid" data-id="${v.id}" type="button">Nije plaćena</button>`:""}
      ${v.status!=="storno"?`<button class="small ghost danger" data-act="storno" data-id="${v.id}" type="button">Storno</button>`:`<button class="small ghost" data-act="unstorno" data-id="${v.id}" type="button">Vrati</button>`}
    </div></td></tr>`).join("") : `<tr><td colspan="7" class="muted">Nema faktura za izabrani filter.</td></tr>`;
  const sum = s => rows.filter(v=>v.status===s).reduce((a,v)=>a+Number(v.total),0);
  $("invStat").innerHTML = `<span>Prikazano: <b>${rows.length}</b></span><span>Naplaćeno: <b>${fmt(sum("placena"))} RSD</b></span><span>Čeka uplatu: <b>${fmt(sum("izdata"))} RSD</b></span>`;
}
["fYear","fStatus","fSearch"].forEach(id=>$(id).addEventListener("input", renderInvoices));
$("invRows").addEventListener("click", async e => {
  const b=e.target.closest("[data-act]"); if(!b) return;
  const v=invoices.find(x=>x.id===b.dataset.id); if(!v) return;
  const act=b.dataset.act;
  try{
    if(act==="pdf") downloadPdf(invoiceToData(v));
    else if(act==="open") openInvoice(v,false);
    else if(act==="copy") openInvoice(v,true);
    else if(act==="paid"||act==="unpaid"||act==="storno"||act==="unstorno"){
      if(act==="storno" && !confirm("Stornirati fakturu "+v.full_no+"? Ostaje u arhivi, označena kao stornirana.")) return;
      const status = act==="paid"?"placena":act==="storno"?"storno":"izdata";
      const r = await sb.from("invoices").update({status, paid_at: status==="placena"?todayISO():null, updated_at:new Date().toISOString()}).eq("id",v.id); if(r.error) throw r.error;
      await reloadInvoices(); toast("Faktura "+v.full_no+": "+{placena:"označena kao plaćena",storno:"stornirana",izdata:"vraćena u izdate"}[status]);
    }
  }catch(err){ toast("Greška: "+(err.message||err), true); }
});

/* ---------- kupci ---------- */
function renderClients(){
  const q=$("clSearch").value.trim().toLowerCase();
  const rows=clients.filter(c=>!q || c.name.toLowerCase().includes(q) || (c.pib||"").includes(q));
  $("clRows").innerHTML = rows.length ? rows.map(c=>`<tr><td><b>${esc(c.name)}</b>${c.email?`<div class="muted" style="font-size:12px">${esc(c.email)}</div>`:""}</td><td>${esc(c.addr||"")}</td><td class="mono">${esc(c.pib||"")}</td><td class="mono">${esc(c.mb||"")}</td>
    <td><div class="rowact"><button class="small ghost" data-cl="edit" data-id="${c.id}" type="button">Izmeni</button><button class="small ghost danger" data-cl="del" data-id="${c.id}" type="button">Obriši</button></div></td></tr>`).join("")
    : `<tr><td colspan="5" class="muted">Nema sačuvanih kupaca.</td></tr>`;
}
$("clSearch").addEventListener("input", renderClients);
function clForm(c){ clEditId=c?c.id:null; $("clTitle").textContent=c?"Izmena kupca":"Novi kupac"; $("cName2").value=c?c.name:""; $("cAddr2").value=c?c.addr||"":""; $("cPib2").value=c?c.pib||"":""; $("cMb2").value=c?c.mb||"":""; $("cEmail2").value=c?c.email||"":""; }
$("btnClCancel").onclick = () => clForm(null);
$("btnClSave").onclick = async () => {
  const p={name:$("cName2").value.trim(), addr:$("cAddr2").value.trim(), pib:$("cPib2").value.trim(), mb:$("cMb2").value.trim(), email:$("cEmail2").value.trim()};
  if(!p.name){ toast("Upiši naziv kupca.", true); return; }
  try{
    const r = clEditId ? await sb.from("clients").update(p).eq("id",clEditId) : await sb.from("clients").insert(p);
    if(r.error){ if(String(r.error.code)==="23505") throw new Error("Kupac sa tim nazivom već postoji."); throw r.error; }
    await reloadClients(); clForm(null); toast("Kupac sačuvan.");
  }catch(e){ toast("Greška: "+(e.message||e), true); }
};
$("clRows").addEventListener("click", async e => {
  const b=e.target.closest("[data-cl]"); if(!b) return; const c=clients.find(x=>x.id===b.dataset.id); if(!c) return;
  if(b.dataset.cl==="edit") clForm(c);
  else if(b.dataset.cl==="del"){
    if(!confirm("Obrisati kupca "+c.name+"? Već izdate fakture ostaju netaknute.")) return;
    const r=await sb.from("clients").delete().eq("id",c.id); if(r.error){ toast("Greška: "+r.error.message, true); return; }
    await reloadClients(); toast("Kupac obrisan.");
  }
});

/* ---------- usluge ---------- */
function renderServices(){
  $("svRows").innerHTML = services.length ? services.map(s=>`<tr><td><b>${esc(s.name)}</b></td><td>${esc(s.unit)}</td><td class="r mono">${s.default_price!=null?fmt(s.default_price):"—"}</td>
    <td><div class="rowact"><button class="small ghost" data-sv="edit" data-id="${s.id}" type="button">Izmeni</button><button class="small ghost danger" data-sv="del" data-id="${s.id}" type="button">Obriši</button></div></td></tr>`).join("")
    : `<tr><td colspan="4" class="muted">Nema usluga — dodaj bar jednu.</td></tr>`;
}
function svForm(s){ svEditId=s?s.id:null; $("svTitle").textContent=s?"Izmena usluge":"Nova usluga"; $("svName").value=s?s.name:""; $("svUnit").value=s?s.unit:"usluga"; $("svPrice").value=s&&s.default_price!=null?s.default_price:""; }
$("btnSvCancel").onclick = () => svForm(null);
$("btnSvSave").onclick = async () => {
  const p={name:$("svName").value.trim(), unit:$("svUnit").value.trim()||"usluga", default_price:$("svPrice").value===""?null:Number($("svPrice").value)};
  if(!p.name){ toast("Upiši naziv usluge.", true); return; }
  try{
    if(!svEditId) p.sort = (services.length? Math.max(...services.map(s=>s.sort||0)):0)+1;
    const r = svEditId ? await sb.from("services").update(p).eq("id",svEditId) : await sb.from("services").insert(p);
    if(r.error) throw r.error;
    await reloadServices(); svForm(null); toast("Usluga sačuvana.");
  }catch(e){ toast("Greška: "+(e.message||e), true); }
};
$("svRows").addEventListener("click", async e => {
  const b=e.target.closest("[data-sv]"); if(!b) return; const s=services.find(x=>x.id===b.dataset.id); if(!s) return;
  if(b.dataset.sv==="edit") svForm(s);
  else if(b.dataset.sv==="del"){
    if(services.length===1){ toast("Mora ostati bar jedna usluga.", true); return; }
    if(!confirm("Obrisati uslugu "+s.name+"?")) return;
    const r=await sb.from("services").delete().eq("id",s.id); if(r.error){ toast("Greška: "+r.error.message, true); return; }
    await reloadServices(); toast("Usluga obrisana.");
  }
});

/* ---------- podešavanja ---------- */
const SET_FIELDS = {name:"sName",owner:"sOwner",addr:"sAddr",pib:"sPib",mb:"sMb",code:"sCode",phone:"sPhone",email:"sEmail",acc:"sAcc",bank:"sBank",place:"sPlace",due_days:"sDueDays",note_vat:"sNoteVat"};
function loadSettingsForm(){ for(const [k,id] of Object.entries(SET_FIELDS)) $(id).value = settings[k] ?? ""; }
$("btnSetSave").onclick = async () => {
  const d={}; for(const [k,id] of Object.entries(SET_FIELDS)) d[k] = k==="due_days" ? Number($(id).value)||0 : $(id).value.trim();
  const r = await sb.from("settings").upsert({id:1, data:d, updated_at:new Date().toISOString()});
  if(r.error){ showMsg("setMsg","Greška: "+r.error.message,"err"); return; }
  settings=d; render(); showMsg("setMsg","Podešavanja sačuvana.","ok");
};

/* ---------- PDF ---------- */
const FONT_URLS = {
  reg: "https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans.ttf",
  bold: "https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans-Bold.ttf"
};
let fontCache = null;
async function loadFonts(){
  if(fontCache) return fontCache;
  const toB64 = buf => { const bytes=new Uint8Array(buf); let s=""; for(let i=0;i<bytes.length;i+=0x8000) s+=String.fromCharCode.apply(null, bytes.subarray(i,i+0x8000)); return btoa(s); };
  const [r,b] = await Promise.all([fetch(FONT_URLS.reg), fetch(FONT_URLS.bold)]);
  if(!r.ok || !b.ok) throw new Error("font "+r.status+"/"+b.status);
  fontCache = { reg: toB64(await r.arrayBuffer()), bold: toB64(await b.arrayBuffer()) };
  return fontCache;
}
function buildPdf(d, fonts){
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({unit:"mm", format:"a4"});
  doc.addFileToVFS("DejaVuSans.ttf", fonts.reg); doc.addFont("DejaVuSans.ttf","DV","normal");
  doc.addFileToVFS("DejaVuSans-Bold.ttf", fonts.bold); doc.addFont("DejaVuSans-Bold.ttf","DV","bold");
  const W=210, ML=18, MR=18, CW=W-ML-MR; let y=20;
  const ink=[16,24,32], muted=[92,103,115], line=[201,207,214], red=[166,61,47];
  const T=(t,x,yy,o={})=>{ doc.setFont("DV",o.b?"bold":"normal"); doc.setFontSize(o.s||9.5); doc.setTextColor(...(o.c||ink)); doc.text(String(t??""),x,yy,{align:o.a||"left"}); };
  const wrap=(t,w,s)=>{ doc.setFont("DV","normal"); doc.setFontSize(s||9.5); return doc.splitTextToSize(String(t||""),w); };
  const co=d.co||{};

  const nameLines = wrap(co.name, 115, 11);
  doc.setFont("DV","bold"); doc.setFontSize(11); doc.setTextColor(...ink); doc.text(nameLines, ML, y);
  let hy = y + nameLines.length*4.8;
  T(co.addr, ML, hy, {s:8.5,c:muted}); hy+=4.2;
  T(["PIB: "+(co.pib||""), "MB: "+(co.mb||""), co.code?"Šifra delatnosti: "+co.code:""].filter(Boolean).join("   ·   "), ML, hy, {s:8.5,c:muted}); hy+=4.2;
  T([co.phone?"Tel: "+co.phone:"", co.email].filter(Boolean).join("   ·   "), ML, hy, {s:8.5,c:muted});
  T("FAKTURA", W-MR, y+2, {b:true,s:22,a:"right"});
  T("br. "+d.no, W-MR, y+9, {s:11,a:"right"});
  if(d.status==="storno") T("STORNIRANA", W-MR, y+15, {s:9,b:true,a:"right",c:red});
  y = Math.max(hy, y+16) + 6;
  doc.setDrawColor(...ink); doc.setLineWidth(0.6); doc.line(ML,y,W-MR,y); y+=9;

  const colR = ML + CW/2 + 6;
  T("KUPAC", ML, y, {s:7.5,c:muted,b:true}); T("PODACI O FAKTURI", colR, y, {s:7.5,c:muted,b:true});
  let by = y+5.5;
  const bn = wrap(d.b.name||"—", CW/2-6, 10.5); doc.setFont("DV","bold"); doc.setFontSize(10.5); doc.setTextColor(...ink); doc.text(bn, ML, by); by += bn.length*4.8;
  if(d.b.addr){ const ba=wrap(d.b.addr, CW/2-6, 9.5); doc.setFont("DV","normal"); doc.setFontSize(9.5); doc.text(ba, ML, by); by += ba.length*4.4; }
  if(d.b.pib){ T("PIB:  "+d.b.pib, ML, by+0.5, {s:9.5}); by+=4.4; }
  if(d.b.mb){ T("MB:  "+d.b.mb, ML, by+0.5, {s:9.5}); by+=4.4; }
  let my = y+5.5;
  [["Mesto izdavanja",d.place],["Datum izdavanja",fmtDate(d.date)],["Datum prometa",fmtDate(d.svcDate)],["Rok plaćanja", d.due?`${fmtDate(d.due)}${d.dueDays!==""?` (${d.dueDays} dana)`:""}`:""]]
    .forEach(([k,v])=>{ T(k, colR, my, {s:9.5,c:muted}); T(v, colR+34, my, {s:9.5}); my+=4.8; });
  y = Math.max(by, my) + 8;

  const cols=[{w:9,a:"left"},{w:0,a:"left"},{w:18,a:"left"},{w:18,a:"right"},{w:28,a:"right"},{w:30,a:"right"}];
  cols[1].w = CW - cols.reduce((s,c,i)=>i===1?s:s+c.w,0);
  const xs=[]; let cx=ML; cols.forEach(c=>{ xs.push(cx); cx+=c.w; });
  ["R.BR.","NAZIV USLUGE","JED. MERE","KOLIČINA","CENA","IZNOS"].forEach((h,i)=>{ const x = cols[i].a==="right"? xs[i]+cols[i].w-1.5 : xs[i]+1.5; T(h,x,y,{s:7.5,c:muted,b:true,a:cols[i].a}); });
  y+=2; doc.setDrawColor(...ink); doc.setLineWidth(0.4); doc.line(ML,y,W-MR,y); y+=5.5;
  d.items.forEach((it,i)=>{
    const nm = wrap(it.svc, cols[1].w-3, 9.5); const ds = it.desc? wrap(it.desc, cols[1].w-3, 8.5):[];
    const rowH = Math.max(5, nm.length*4.4 + ds.length*4);
    if(y+rowH > 255){ doc.addPage(); y=20; }
    T((i+1)+".", xs[0]+1.5, y, {s:9.5});
    doc.setFont("DV","normal"); doc.setFontSize(9.5); doc.setTextColor(...ink); doc.text(nm, xs[1]+1.5, y);
    if(ds.length){ doc.setFontSize(8.5); doc.setTextColor(...muted); doc.text(ds, xs[1]+1.5, y+nm.length*4.4); }
    T(it.unit, xs[2]+1.5, y, {s:9.5});
    T(fmtQty(it.qty), xs[3]+cols[3].w-1.5, y, {s:9.5,a:"right"});
    T(fmt(it.price), xs[4]+cols[4].w-1.5, y, {s:9.5,a:"right"});
    T(fmt(it.total), xs[5]+cols[5].w-1.5, y, {s:9.5,a:"right"});
    y += rowH; doc.setDrawColor(...line); doc.setLineWidth(0.2); doc.line(ML,y-1.2,W-MR,y-1.2); y+=3.2;
  });
  y+=3; const tx = W-MR-70; doc.setDrawColor(...ink); doc.setLineWidth(0.6); doc.line(tx,y,W-MR,y); y+=6.5;
  T("UKUPNO ZA UPLATU", tx, y, {s:8,b:true}); T(fmt(d.total)+" RSD", W-MR, y, {s:14,b:true,a:"right"}); y+=11;

  for(const n of [d.noteVat, d.noteExtra]){ if(!n) continue; const l=wrap(n, CW, 9); doc.setFont("DV","normal"); doc.setFontSize(9); doc.setTextColor(...ink); doc.text(l, ML, y); y+=l.length*4.2+2; }
  y+=4;
  const pay=[["Uplatu izvršiti na račun",co.acc||"",true],["Banka",co.bank||"",false],["Poziv na broj",(d.no||"").replace("/","-"),true],["Svrha uplate","Uplata po fakturi br. "+d.no,false]];
  const boxH = pay.length*5+6;
  if(y+boxH > 262){ doc.addPage(); y=20; }
  doc.setDrawColor(...line); doc.setLineWidth(0.3); doc.rect(ML,y,CW,boxH);
  let py=y+6.5; pay.forEach(([k,v,b])=>{ T(k, ML+4, py, {s:9,c:muted}); T(v, ML+52, py, {s:9,b:b}); py+=5; });

  const pages = doc.getNumberOfPages();
  for(let p=1;p<=pages;p++){
    doc.setPage(p);
    doc.setDrawColor(...line); doc.setLineWidth(0.3); doc.line(ML,272,W-MR,272);
    T("Faktura je važeća bez pečata i potpisa (čl. 9 st. 2 Zakona o računovodstvu).", ML, 277, {s:8,c:muted});
    T("Fakturisao: "+(co.owner||""), ML, 281.5, {s:8,c:muted});
    doc.setDrawColor(...ink); doc.setLineWidth(0.3); doc.line(W-MR-55,279,W-MR,279);
    T(co.owner||"", W-MR-27.5, 283, {s:8,a:"center"});
    if(pages>1) T(`Strana ${p}/${pages}`, W-MR, 288, {s:7.5,c:muted,a:"right"});
  }
  return doc;
}
async function downloadPdf(d){
  if(!window.jspdf || !window.jspdf.jsPDF){ toast("Biblioteka za PDF nije učitana — proveri internet, ili koristi Štampaj → Sačuvaj kao PDF.", true); return; }
  try{
    let fonts; try{ fonts = await loadFonts(); }catch(e){ toast("Font za PDF nije učitan ("+e.message+") — proveri internet, ili koristi Štampaj → Sačuvaj kao PDF.", true); return; }
    const doc = buildPdf(d, fonts);
    const fname = `Faktura-${d.no.replace("/","-")}-${(d.b.name||"kupac").replace(/[^\p{L}\p{N}]+/gu,"_").slice(0,40)}.pdf`;
    doc.save(fname);
  }catch(e){ toast("PDF nije napravljen: "+(e.message||e), true); console.error(e); }
}

boot();
})();
