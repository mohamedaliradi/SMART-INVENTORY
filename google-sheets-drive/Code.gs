/**
 * SMART INVENTORY - Google Sheets backed web app.
 * Deploy as Apps Script Web App: Execute as owner; access according to your organization.
 * Passwords use PBKDF2-HMAC-SHA256; sessions are short-lived server-side cache tokens.
 */
const APP_CONFIG = Object.freeze({
  SPREADSHEET_NAME: 'SMART INVENTORY - Central Database',
  DRIVE_FOLDER_NAME: 'SMART INVENTORY - Reports and Backups',
  SESSION_TTL_SECONDS: 21600,
  PBKDF2_ITERATIONS: 12000,
  SHEETS: [
    { name: 'Users', headers: ['user_id','username','password_hash','password_salt','role','is_active','must_change_password','created_at','updated_at'] },
    { name: 'Branches', headers: ['branch_id','branch_name','is_active'] },
    { name: 'Warehouses', headers: ['warehouse_id','branch_id','warehouse_name','is_active'] },
    { name: 'Items', headers: ['item_id','barcode','item_code','item_name','unit','category','is_active','updated_at'] },
    { name: 'InventorySessions', headers: ['session_id','branch_id','warehouse_id','session_name','status','created_by','created_at'] },
    { name: 'InventoryLines', headers: ['line_id','session_id','item_id','item_code','item_name','counted_qty','unit_price','expiry_date','branch_name','employee_username','counted_at','notes','warehouse_id','warehouse_name'] },
    { name: 'AuditLog', headers: ['event_id','actor','action','entity','entity_id','event_time','details'] },
    { name: 'Settings', headers: ['setting_key','setting_value','updated_at'] }
  ]
});
function db_() {
  const id = PropertiesService.getScriptProperties().getProperty('SMART_INVENTORY_SPREADSHEET_ID');
  if (!id) throw new Error('لم يتم إعداد قاعدة البيانات. شغّل setupDatabase أولاً.');
  return SpreadsheetApp.openById(id);
}
function setupDatabase() {
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    const props = PropertiesService.getScriptProperties();
    let id = props.getProperty('SMART_INVENTORY_SPREADSHEET_ID');
    let ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.create(APP_CONFIG.SPREADSHEET_NAME);
    props.setProperty('SMART_INVENTORY_SPREADSHEET_ID', ss.getId());
    APP_CONFIG.SHEETS.forEach(d => {
      let sh = ss.getSheetByName(d.name);
      if (!sh) sh = ss.insertSheet(d.name);
      if (sh.getLastRow() <= 1) { sh.getRange(1,1,1,d.headers.length).setValues([d.headers]); sh.setFrozenRows(1); } else { const existing=sh.getRange(1,1,1,d.headers.length).getValues()[0]; const mismatch=existing.findIndex((h,i)=>h && h!==d.headers[i]); if (mismatch>=0) throw new Error('تعارض في أعمدة '+d.name+'؛ أوقفنا الإعداد لحماية البيانات الموجودة.'); const firstMissing=existing.findIndex(h=>!h); if(firstMissing>=0){ if(existing.slice(firstMissing).some(Boolean)) throw new Error('يوجد فراغ داخل عناوين '+d.name+'؛ أوقفنا الإعداد لحماية البيانات.'); sh.getRange(1,firstMissing+1,1,d.headers.length-firstMissing).setValues([d.headers.slice(firstMissing)]); } sh.setFrozenRows(1); }
    });
    const blank = ss.getSheetByName('Sheet1');
    if (blank && ss.getSheets().length > APP_CONFIG.SHEETS.length) ss.deleteSheet(blank);
    let folderId = props.getProperty('SMART_INVENTORY_DRIVE_FOLDER_ID');
    let folder = folderId ? DriveApp.getFolderById(folderId) : DriveApp.createFolder(APP_CONFIG.DRIVE_FOLDER_NAME);
    props.setProperty('SMART_INVENTORY_DRIVE_FOLDER_ID', folder.getId());
    let bootstrap = null;
    const users = ss.getSheetByName('Users');
    if (users.getLastRow() < 2) {
      const temp = randomToken_().slice(0,18) + 'A9!';
      const salt = randomToken_();
      users.appendRow([Utilities.getUuid(),'admin',passwordHash_(temp,salt),salt,'admin',true,true,new Date(),new Date()]);
      bootstrap = { username:'admin', temporaryPassword:temp, note:'غيّر كلمة المرور فور أول دخول.' };
      console.log('SMART INVENTORY INITIAL ADMIN: ' + JSON.stringify(bootstrap));
    }
    const result = { status:'created_or_verified', spreadsheetUrl:ss.getUrl(), driveFolderUrl:folder.getUrl(), bootstrapAdmin:bootstrap };
    console.log(JSON.stringify(result)); return result;
  } finally { lock.releaseLock(); }
}
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('SMART INVENTORY – نظام الجرد الذكي')
    .addMetaTag('viewport','width=device-width, initial-scale=1');
}
function randomToken_() { return Utilities.getUuid().replace(/-/g,'') + Utilities.getUuid().replace(/-/g,''); }
function bytesToHex_(bytes) { return bytes.map(b => ('0'+((b+256)%256).toString(16)).slice(-2)).join(''); }
function hmac_(key, message) {
  // Apps Script requires matching byte-array overloads when the message is bytes.
  const keyBytes = Array.isArray(key) ? key : Utilities.newBlob(String(key)).getBytes();
  const messageBytes = Array.isArray(message) ? message : Utilities.newBlob(String(message)).getBytes();
  return Utilities.computeHmacSha256Signature(messageBytes, keyBytes);
}
function passwordHash_(password, salt) {
  // PBKDF2-HMAC-SHA256, one 256-bit block.
  const iterations = APP_CONFIG.PBKDF2_ITERATIONS;
  const block = Utilities.newBlob(salt).getBytes().concat([0,0,0,1]);
  let u = hmac_(String(password), block);
  let out = u.slice();
  for (let i=1;i<iterations;i++) {
    u = hmac_(String(password),u);
    for(let j=0;j<out.length;j++) out[j] = out[j] ^ u[j];
  }
  return bytesToHex_(out);
}
function userRows_() {
  const sh=db_().getSheetByName('Users'), values=sh.getDataRange().getValues();
  return values.slice(1).map((r,i)=>({row:i+2,id:r[0],username:String(r[1]),hash:String(r[2]),salt:String(r[3]),role:String(r[4]),active:r[5]===true||String(r[5]).toLowerCase()==='true',mustChange:r[6]===true||String(r[6]).toLowerCase()==='true'}));
}
function audit_(actor,action,entity,entityId,details) {
  db_().getSheetByName('AuditLog').appendRow([Utilities.getUuid(),actor,action,entity,entityId,new Date(),String(details||'').slice(0,500)]);
}
function login(username,password) {
  username=String(username||'').trim().toLowerCase(); password=String(password||'');
  if (!username || !password) throw new Error('أدخل اسم المستخدم وكلمة المرور.');
  const cache=CacheService.getScriptCache(), key='login_fail_'+username, attempts=Number(cache.get(key)||0);
  if (attempts>=8) throw new Error('محاولات كثيرة. انتظر 15 دقيقة ثم حاول مجدداً.');
  const user=userRows_().find(u=>u.username.toLowerCase()===username && u.active);
  if (!user || passwordHash_(password,user.salt)!==user.hash) { cache.put(key,String(attempts+1),900); throw new Error('اسم المستخدم أو كلمة المرور غير صحيحة.'); }
  cache.remove(key);
  const token=randomToken_(), session={username:user.username,role:user.role,mustChange:user.mustChange,issued:Date.now()};
  cache.put('session_'+token,JSON.stringify(session),APP_CONFIG.SESSION_TTL_SECONDS);
  audit_(user.username,'LOGIN','Users',user.id,'تسجيل دخول ناجح');
  return {token,username:user.username,role:user.role,mustChangePassword:user.mustChange};
}
function session_(token) {
  const raw=CacheService.getScriptCache().get('session_'+String(token||''));
  if (!raw) throw new Error('انتهت الجلسة. سجّل الدخول مرة أخرى.');
  return JSON.parse(raw);
}
function logout(token) { const s=session_(token); CacheService.getScriptCache().remove('session_'+token); audit_(s.username,'LOGOUT','Users',s.username,''); return true; }
function changePassword(token,currentPassword,newPassword) {
  const s=session_(token); if(String(newPassword||'').length<10) throw new Error('كلمة المرور الجديدة يجب ألا تقل عن 10 أحرف.');
  const u=userRows_().find(x=>x.username===s.username); if(!u || passwordHash_(String(currentPassword||''),u.salt)!==u.hash) throw new Error('كلمة المرور الحالية غير صحيحة.');
  const salt=randomToken_(), sh=db_().getSheetByName('Users');
  sh.getRange(u.row,3,1,2).setValues([[passwordHash_(newPassword,salt),salt]]);
  sh.getRange(u.row,7).setValue(false); sh.getRange(u.row,9).setValue(new Date());
  const updated={username:s.username,role:s.role,mustChange:false,issued:s.issued};
  CacheService.getScriptCache().put('session_'+token,JSON.stringify(updated),APP_CONFIG.SESSION_TTL_SECONDS);
  audit_(s.username,'CHANGE_PASSWORD','Users',u.id,''); return {ok:true};
}
function requireRole_(s,roles) { if(roles.indexOf(s.role)<0) throw new Error('ليس لديك صلاحية لتنفيذ هذه العملية.'); }
function getAppData(token) {
  const s=session_(token);
  const ss=db_();
  const branches=ss.getSheetByName('Branches').getDataRange().getValues().slice(1).filter(r=>r[0] && (r[2]===true||String(r[2]).toLowerCase()==='true')).map(r=>({id:r[0],name:r[1]}));
  const items=ss.getSheetByName('Items').getDataRange().getValues().slice(1).filter(r=>r[0] && (r[6]===true||String(r[6]).toLowerCase()==='true')).map(r=>({id:r[0],barcode:r[1],code:r[2],name:r[3],unit:r[4]}));
  const warehouses=ss.getSheetByName('Warehouses').getDataRange().getValues().slice(1).filter(r=>r[0] && (r[3]===true||String(r[3]).toLowerCase()==='true')).map(r=>({id:r[0],branchId:r[1],name:r[2]}));
  return {user:s,branches,warehouses,items};
}
function saveCount(token,data) {
  const s=session_(token); requireRole_(s,['admin','supervisor','employee']); if(s.mustChange) throw new Error('يجب تغيير كلمة المرور أولاً.');
  data=data||{}; const code=String(data.code||'').trim(), name=String(data.name||'').trim(), branch=String(data.branch||'').trim();
  const qty=Number(data.qty), price=Number(data.price||0), warehouseId=String(data.warehouseId||'').trim();
  const ss=db_(), branches=ss.getSheetByName('Branches').getDataRange().getValues().slice(1), warehouses=ss.getSheetByName('Warehouses').getDataRange().getValues().slice(1);
  const branchRow=branches.find(r=>String(r[0])===branch && (r[2]===true||String(r[2]).toLowerCase()==='true'));
  const warehouseRow=warehouses.find(r=>String(r[0])===warehouseId && String(r[1])===branch && (r[3]===true||String(r[3]).toLowerCase()==='true'));
  if(!code||!name||!branch||!branchRow||!warehouseRow||!Number.isFinite(qty)||!Number.isFinite(price)||price<0) throw new Error('راجع الصنف والفرع والمخزن والكمية والسعر.');
  const lock=LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const sh=db_().getSheetByName('InventoryLines');
    const id=Utilities.getUuid();
    sh.appendRow([id,'', '',code,name,qty,price,String(data.expiry||''),String(branchRow[1]),s.username,new Date(),String(data.notes||'').slice(0,300),warehouseId,String(warehouseRow[2])]);
    audit_(s.username,'CREATE','InventoryLines',id,'code='+code+'; qty='+qty);
    return {ok:true,id};
  } finally {lock.releaseLock();}
}
function listCounts(token) {
  const s=session_(token); const rows=db_().getSheetByName('InventoryLines').getDataRange().getValues().slice(1);
  return rows.filter(r=>r[0]).slice(-500).reverse().map(r=>({id:r[0],code:r[3],name:r[4],qty:r[5],price:r[6],expiry:r[7],branch:r[8],employee:r[9],time:r[10],warehouseId:r[12]||'',warehouse:r[13]||''}));
}
function adminCreateUser(token,username,password,role) {
  const s=session_(token); requireRole_(s,['admin']);
  username=String(username||'').trim(); role=String(role||'employee');
  if(!/^[a-zA-Z0-9_.-]{3,30}$/.test(username)) throw new Error('اسم المستخدم يجب أن يكون 3 إلى 30 حرفاً إنجليزياً أو رقماً.');
  if(String(password||'').length<10) throw new Error('كلمة المرور يجب ألا تقل عن 10 أحرف.');
  if(['admin','supervisor','employee','viewer'].indexOf(role)<0) throw new Error('الصلاحية غير صحيحة.');
  if(userRows_().some(u=>u.username.toLowerCase()===username.toLowerCase())) throw new Error('اسم المستخدم مستخدم بالفعل.');
  const salt=randomToken_(),id=Utilities.getUuid();
  db_().getSheetByName('Users').appendRow([id,username,passwordHash_(password,salt),salt,role,true,false,new Date(),new Date()]);
  audit_(s.username,'CREATE','Users',id,'username='+username+'; role='+role); return {ok:true};
}
function adminListUsers(token) {
  const s=session_(token); requireRole_(s,['admin']);
  return userRows_().map(u=>({id:u.id,username:u.username,role:u.role,active:u.active,mustChangePassword:u.mustChange}));
}
function adminSetUserActive(token,userId,active) {
  const s=session_(token); requireRole_(s,['admin']);
  const u=userRows_().find(x=>x.id===userId); if(!u) throw new Error('المستخدم غير موجود.');
  if(u.username===s.username && !active) throw new Error('لا يمكن إيقاف حساب المدير الحالي.');
  db_().getSheetByName('Users').getRange(u.row,6).setValue(Boolean(active));
  audit_(s.username,active?'ENABLE_USER':'DISABLE_USER','Users',userId,''); return {ok:true};
}


/** Master catalog: non-destructive upsert by item code. */
function listCatalog(token) {
  session_(token);
  const rows=db_().getSheetByName('Items').getDataRange().getValues().slice(1);
  return rows.filter(r=>r[0] && (r[6]===true || String(r[6]).toLowerCase()==='true'))
    .map(r=>({id:String(r[0]),barcode:String(r[1]||''),code:String(r[2]||''),name:String(r[3]||''),unit:String(r[4]||''),category:String(r[5]||'')}));
}
function adminSaveItem(token,item) {
  const s=session_(token); requireRole_(s,['admin']);
  item=item||{};
  const code=String(item.code||'').trim(), name=String(item.name||'').trim();
  if(!code || !name) throw new Error('كود الصنف واسمه مطلوبان.');
  const sh=db_().getSheetByName('Items'), values=sh.getDataRange().getValues();
  const idx=values.findIndex((r,i)=>i>0 && String(r[2]||'').trim().toLowerCase()===code.toLowerCase());
  const row=[idx>0?values[idx][0]:Utilities.getUuid(),String(item.barcode||'').trim(),code,name,String(item.unit||'').trim(),String(item.category||'').trim(),true,new Date()];
  if(idx>0) sh.getRange(idx+1,1,1,row.length).setValues([row]); else sh.appendRow(row);
  audit_(s.username,idx>0?'UPDATE':'CREATE','Items',row[0],'code='+code);
  return {ok:true,updated:idx>0};
}
function adminImportItems(token,items) {
  const s=session_(token); requireRole_(s,['admin']);
  if(!Array.isArray(items) || !items.length) throw new Error('لم يتم العثور على أصناف صالحة للاستيراد.');
  if(items.length>5000) throw new Error('الحد الأقصى للاستيراد في المرة الواحدة 5000 صنف.');
  const sh=db_().getSheetByName('Items'), lock=LockService.getScriptLock(); lock.waitLock(30000);
  try {
    const values=sh.getDataRange().getValues(), index={};
    values.slice(1).forEach((r,i)=>{const k=String(r[2]||'').trim().toLowerCase();if(k)index[k]=i+1;});
    let added=0,updated=0,skipped=0; const seen={};
    items.forEach(item=>{
      const code=String(item.code||'').trim(), name=String(item.name||'').trim();
      if(!code || !name){skipped++;return;}
      const key=code.toLowerCase(); if(seen[key]){skipped++;return;} seen[key]=true;
      const oldRow=index[key];
      const old=oldRow?values[oldRow]:[];
      const row=[oldRow?old[0]:Utilities.getUuid(),
        String(item.barcode|| (old[1]||'')).trim(),code,name,
        String(item.unit|| (old[4]||'')).trim(),String(item.category|| (old[5]||'')).trim(),
        true,new Date()];
      if(oldRow){sh.getRange(oldRow+1,1,1,row.length).setValues([row]);updated++;}
      else {sh.appendRow(row);added++;index[key]=sh.getLastRow()-1;}
    });
    audit_(s.username,'IMPORT','Items','catalog','added='+added+'; updated='+updated+'; skipped='+skipped);
    return {ok:true,added,updated,skipped,total:added+updated};
  } finally {lock.releaseLock();}
}


/** Warehouse administration: stable IDs tied to an existing branch. */
function adminListWarehouses(token) {
  const s=session_(token); requireRole_(s,['admin']);
  const rows=db_().getSheetByName('Warehouses').getDataRange().getValues().slice(1);
  return rows.filter(r=>r[0]).map(r=>({id:String(r[0]),branchId:String(r[1]||''),name:String(r[2]||''),active:r[3]===true||String(r[3]).toLowerCase()==='true'}));
}
function adminSaveWarehouse(token,warehouse) {
  const s=session_(token); requireRole_(s,['admin']); warehouse=warehouse||{};
  const branchId=String(warehouse.branchId||'').trim(), name=String(warehouse.name||'').trim();
  if(!branchId||!name) throw new Error('اختر الفرع واكتب اسم المخزن.');
  const ss=db_(), branch=ss.getSheetByName('Branches').getDataRange().getValues().slice(1).find(r=>String(r[0])===branchId && (r[2]===true||String(r[2]).toLowerCase()==='true'));
  if(!branch) throw new Error('الفرع غير موجود أو غير نشط.');
  const sh=ss.getSheetByName('Warehouses'), values=sh.getDataRange().getValues(), existingId=String(warehouse.id||'').trim();
  const idx=existingId?values.findIndex((r,i)=>i>0&&String(r[0])===existingId):-1;
  if(idx>0 && String(values[idx][1])!==branchId) throw new Error('لا يمكن نقل مخزن مرتبط بحركات جرد؛ أنشئ مخزناً جديداً للفرع الآخر.');
  const id=idx>0?existingId:Utilities.getUuid(), row=[id,branchId,name,true];
  if(idx>0) sh.getRange(idx+1,1,1,4).setValues([row]); else sh.appendRow(row);
  audit_(s.username,idx>0?'UPDATE':'CREATE','Warehouses',id,'branch='+branchId+'; name='+name);
  return {ok:true,id,updated:idx>0};
}


/* ===== Restored full inventory workflow APIs (additive; existing rows are preserved) ===== */
function ensureInventoryExtraColumns_() {
  const sh=db_().getSheetByName('InventoryLines');
  const headers=sh.getRange(1,1,1,16).getValues()[0];
  const expected=[['batch_number',15],['expiry_month_year',16]];
  expected.forEach(([name,col])=>{
    const current=String(headers[col-1]||'').trim();
    if(current && current!==name) throw new Error('تعارض في عنوان العمود '+col+' بورقة InventoryLines؛ لم نغيّر البيانات.');
    if(!current) sh.getRange(1,col).setValue(name);
  });
  return sh;
}
function listInventorySessions(token) {
  session_(token);
  const ss=db_();
  const sessionSheet=ss.getSheetByName('InventorySessions');
  const branchSheet=ss.getSheetByName('Branches');
  const warehouseSheet=ss.getSheetByName('Warehouses');
  const lineSheet=ss.getSheetByName('InventoryLines');
  if(!sessionSheet || !branchSheet || !warehouseSheet || !lineSheet) {
    throw new Error('إحدى أوراق بيانات الجرد غير موجودة: InventorySessions / Branches / Warehouses / InventoryLines');
  }
  const readTable = sh => {
    const values=sh.getDataRange().getValues();
    const headers=(values[0]||[]).map(v=>String(v||'').trim());
    const index={}; headers.forEach((h,i)=>{if(h)index[h]=i;});
    return {rows:values.slice(1),index,lastRow:sh.getLastRow(),headers};
  };
  const sessions=readTable(sessionSheet), branches=readTable(branchSheet);
  const warehouses=readTable(warehouseSheet), lines=readTable(lineSheet);
  const col=(table,name,fallback)=>Object.prototype.hasOwnProperty.call(table.index,name)?table.index[name]:fallback;
  const sid=col(sessions,'session_id',0), sb=col(sessions,'branch_id',1), sw=col(sessions,'warehouse_id',2);
  const sn=col(sessions,'session_name',3), st=col(sessions,'status',4), su=col(sessions,'created_by',5), sd=col(sessions,'created_at',6);
  const bid=col(branches,'branch_id',0), bn=col(branches,'branch_name',1);
  const wid=col(warehouses,'warehouse_id',0), wb=col(warehouses,'branch_id',1), wn=col(warehouses,'warehouse_name',2);
  const lid=col(lines,'session_id',1);
  const branchRows=branches.rows, warehouseRows=warehouses.rows, lineRows=lines.rows;
  const result=sessions.rows.filter(r=>String(r[sid]||'').trim()).map(r=>{
    const id=String(r[sid]).trim(), branchId=String(r[sb]||'').trim(), warehouseId=String(r[sw]||'').trim();
    const br=branchRows.find(x=>String(x[bid]||'').trim()===branchId);
    const wh=warehouseRows.find(x=>String(x[wid]||'').trim()===warehouseId && String(x[wb]||'').trim()===branchId);
    return {
      id,branchId,branchName:br?String(br[bn]||''):'',
      warehouseId,warehouseName:wh?String(wh[wn]||''):'',
      name:String(r[sn]||''),status:String(r[st]||'open'),
      createdBy:String(r[su]||''),createdAt:r[sd] instanceof Date ? Utilities.formatDate(r[sd],ss.getSpreadsheetTimeZone()||Session.getScriptTimeZone(),'yyyy-MM-dd HH:mm:ss') : String(r[sd]||''),
      count:lineRows.filter(x=>String(x[lid]||'').trim()===id).length
    };
  }).reverse();
  console.log('SMART INVENTORY listInventorySessions:',JSON.stringify({
    spreadsheetId:ss.getId(),sheet:sessionSheet.getName(),lastRow:sessions.lastRow,
    headers:sessions.headers,returned:result.length,sessionIds:result.map(x=>x.id)
  }));
  return result;
}
function getInventorySessionsDiagnostics(token) {
  const s=session_(token); requireRole_(s,['admin']);
  const ss=db_(), sh=ss.getSheetByName('InventorySessions');
  if(!sh) return {ok:false,spreadsheetId:ss.getId(),sheetExists:false};
  const values=sh.getDataRange().getDisplayValues();
  return {
    ok:true,spreadsheetId:ss.getId(),sheetExists:true,sheetName:sh.getName(),
    lastRow:sh.getLastRow(),headers:values.length?values[0]:[],
    dataRows:Math.max(0,values.length-1),
    sessions:values.slice(1).filter(r=>String(r[0]||'').trim()).map(r=>({
      id:String(r[0]),branchId:String(r[1]||''),warehouseId:String(r[2]||''),
      name:String(r[3]||''),status:String(r[4]||'')
    }))
  };
}
function adminCreateInventorySession(token, data) {
  const s=session_(token); requireRole_(s,['admin','supervisor']);
  data=data||{};
  const branchId=String(data.branchId||''), warehouseId=String(data.warehouseId||''), name=String(data.name||'').trim();
  if(!branchId||!warehouseId||!name) throw new Error('اختر الفرع والمخزن واكتب اسم عملية الجرد.');
  if(name.length>150) throw new Error('اسم عملية الجرد يجب ألا يزيد عن 150 حرفاً.');
  const ss=db_(), br=ss.getSheetByName('Branches').getDataRange().getValues().slice(1).find(r=>String(r[0])===branchId&&(r[2]===true||String(r[2]).toLowerCase()==='true'));
  const wh=ss.getSheetByName('Warehouses').getDataRange().getValues().slice(1).find(r=>String(r[0])===warehouseId&&String(r[1])===branchId&&(r[3]===true||String(r[3]).toLowerCase()==='true'));
  if(!br||!wh) throw new Error('الفرع أو المخزن غير صحيح.');
  const id=Utilities.getUuid();
  ss.getSheetByName('InventorySessions').appendRow([id,branchId,warehouseId,name,'open',s.username,new Date()]);
  audit_(s.username,'CREATE','InventorySessions',id,'name='+name);
  return {ok:true,id};
}
function adminSetInventorySessionStatus(token, sessionId, status) {
  const s=session_(token); requireRole_(s,['admin','supervisor']);
  status=String(status||'');
  if(['open','closed'].indexOf(status)<0) throw new Error('حالة العملية غير صحيحة.');
  const sh=db_().getSheetByName('InventorySessions'), values=sh.getDataRange().getValues();
  const idx=values.findIndex((r,i)=>i>0&&String(r[0])===String(sessionId));
  if(idx<1) throw new Error('عملية الجرد غير موجودة.');
  sh.getRange(idx+1,5).setValue(status);
  audit_(s.username,status==='closed'?'CLOSE':'REOPEN','InventorySessions',sessionId,'');
  return {ok:true};
}
function saveSessionCount(token, data) {
  const s=session_(token); requireRole_(s,['admin','supervisor','employee']);
  if(s.mustChange) throw new Error('يجب تغيير كلمة المرور أولاً.');
  data=data||{};
  const sessionId=String(data.sessionId||''), code=String(data.code||'').trim();
  if(data.qty===null||typeof data.qty==='undefined'||String(data.qty).trim()==='') throw new Error('أدخل الكمية الفعلية.');
  const qty=Number(data.qty), price=Number(data.price||0);
  if(!sessionId||!code||!Number.isFinite(qty)||!Number.isFinite(price)||price<0) throw new Error('راجع العملية والكود والكمية والسعر.');
  const ss=db_(), sessions=ss.getSheetByName('InventorySessions').getDataRange().getValues().slice(1);
  const inv=sessions.find(r=>String(r[0])===sessionId);
  if(!inv) throw new Error('عملية الجرد غير موجودة.');
  if(String(inv[4])!=='open') throw new Error('عملية الجرد مغلقة ولا تقبل حركات جديدة.');
  const catalog=ss.getSheetByName('Items').getDataRange().getValues().slice(1);
  const item=catalog.find(r=>(r[6]===true||String(r[6]).toLowerCase()==='true')&&(String(r[2]||'').trim().toLowerCase()===code.toLowerCase()||String(r[1]||'').trim().toLowerCase()===code.toLowerCase()));
  if(!item) throw new Error('الصنف غير موجود في الملف الرئيسي.');
  const lock=LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const sh=ensureInventoryExtraColumns_(), id=Utilities.getUuid();
    const expiry=String(data.expiry||'').trim(), batch=String(data.batch||'').trim();
    const branch=ss.getSheetByName('Branches').getDataRange().getValues().slice(1).find(r=>String(r[0])===String(inv[1]));
    const warehouse=ss.getSheetByName('Warehouses').getDataRange().getValues().slice(1).find(r=>String(r[0])===String(inv[2]));
    const row=[id,sessionId,item[0],item[2],item[3],qty,price,expiry,branch?String(branch[1]):String(inv[1]),s.username,new Date(),String(data.notes||'').slice(0,300),String(inv[2]),warehouse?String(warehouse[2]):'',batch,expiry];
    sh.appendRow(row);
    audit_(s.username,'CREATE','InventoryLines',id,'session='+sessionId+'; code='+item[2]+'; qty='+qty);
    return {ok:true,id,itemName:String(item[3])};
  } finally { lock.releaseLock(); }
}
function listSessionLines(token, sessionId) {
  session_(token);
  const rows=db_().getSheetByName('InventoryLines').getDataRange().getValues().slice(1);
  return rows.filter(r=>r[0]&&String(r[1])===String(sessionId)).map(r=>({id:String(r[0]),code:String(r[3]||''),name:String(r[4]||''),qty:Number(r[5]||0),price:Number(r[6]||0),expiry:String(r[15]||r[7]||''),batch:String(r[14]||''),employee:String(r[9]||''),time:r[10]})).reverse();
}
function adminDeleteInventoryLine(token, lineId) {
  const s=session_(token); requireRole_(s,['admin','supervisor']);
  const sh=db_().getSheetByName('InventoryLines'), values=sh.getDataRange().getValues();
  const idx=values.findIndex((r,i)=>i>0&&String(r[0])===String(lineId));
  if(idx<1) throw new Error('حركة الجرد غير موجودة.');
  sh.deleteRow(idx+1); audit_(s.username,'DELETE','InventoryLines',lineId,''); return {ok:true};
}
function getDashboardStats(token) {
  const s=session_(token), ss=db_();
  const countRows=ss.getSheetByName('InventorySessions').getDataRange().getValues().slice(1).filter(r=>r[0]);
  const users=userRows_().filter(u=>u.active&&u.role!=='admin').length;
  const items=ss.getSheetByName('Items').getDataRange().getValues().slice(1).filter(r=>r[0]&&(r[6]===true||String(r[6]).toLowerCase()==='true')).length;
  const lines=ss.getSheetByName('InventoryLines').getDataRange().getValues().slice(1).filter(r=>r[0]);
  return {username:s.username,sessions:countRows.length,employees:users,items,counts:lines.length};
}
function getInventoryReport(token, sessionId) {
  session_(token);
  const ss=db_(), sessions=ss.getSheetByName('InventorySessions').getDataRange().getValues().slice(1);
  const inv=sessions.find(r=>String(r[0])===String(sessionId));
  if(!inv) throw new Error('عملية الجرد غير موجودة.');
  const rows=ss.getSheetByName('InventoryLines').getDataRange().getValues().slice(1).filter(r=>String(r[1])===String(sessionId));
  // Keep each batch/expiry combination separate so traceability is not lost.
  const map={};
  rows.forEach(r=>{
    const code=String(r[3]||''), expiry=String(r[15]||r[7]||''), batch=String(r[14]||'');
    const key=[code,expiry,batch].join('\\u001f');
    if(!map[key]) map[key]={code,name:String(r[4]||''),expiry,batch,qty:0,value:0,lines:0};
    map[key].qty+=Number(r[5]||0);
    map[key].value+=Number(r[5]||0)*Number(r[6]||0);
    map[key].lines++;
  });
  return {session:{id:String(inv[0]),name:String(inv[3]),status:String(inv[4])},rows:Object.keys(map).map(k=>map[k]),totalLines:rows.length,totalValue:rows.reduce((a,r)=>a+Number(r[5]||0)*Number(r[6]||0),0)};
}
function listAuditLog(token) {
  const s=session_(token); requireRole_(s,['admin']);
  const rows=db_().getSheetByName('AuditLog').getDataRange().getValues().slice(1);
  return rows.filter(r=>r[0]).slice(-500).reverse().map(r=>({actor:String(r[1]),action:String(r[2]),entity:String(r[3]),entityId:String(r[4]),time:r[5],details:String(r[6]||'')}));
}
function adminDeleteUser(token, userId) {
  const s=session_(token); requireRole_(s,['admin']);
  const users=userRows_(), u=users.find(x=>String(x.id)===String(userId));
  if(!u) throw new Error('المستخدم غير موجود.');
  if(u.username===s.username) throw new Error('لا يمكن حذف حساب المدير المستخدم حالياً.');
  if(u.role==='admin'&&users.filter(x=>x.role==='admin'&&x.active).length<=1) throw new Error('لا يمكن حذف آخر مدير نشط.');
  db_().getSheetByName('Users').deleteRow(u.row);
  audit_(s.username,'DELETE','Users',userId,'username='+u.username); return {ok:true};
}
function adminResetUserPassword(token, userId, newPassword) {
  const s=session_(token); requireRole_(s,['admin']);
  if(String(newPassword||'').length<10) throw new Error('كلمة المرور يجب ألا تقل عن 10 أحرف.');
  const u=userRows_().find(x=>String(x.id)===String(userId));
  if(!u) throw new Error('المستخدم غير موجود.');
  const salt=randomToken_(), sh=db_().getSheetByName('Users');
  sh.getRange(u.row,3,1,2).setValues([[passwordHash_(newPassword,salt),salt]]);
  sh.getRange(u.row,7).setValue(true); sh.getRange(u.row,9).setValue(new Date());
  audit_(s.username,'RESET_PASSWORD','Users',userId,'username='+u.username); return {ok:true};
}
