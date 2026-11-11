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
    { name: 'Items', headers: ['item_id','barcode','item_code','item_name','unit','category','is_active','updated_at'] },
    { name: 'InventorySessions', headers: ['session_id','branch_id','warehouse_id','session_name','status','created_by','created_at'] },
    { name: 'InventoryLines', headers: ['line_id','session_id','item_id','item_code','item_name','counted_qty','unit_price','expiry_date','branch_name','employee_username','counted_at','notes'] },
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
      if (sh.getLastRow() === 0) { sh.getRange(1,1,1,d.headers.length).setValues([d.headers]); sh.setFrozenRows(1); }
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
function hmac_(key, message) { return Utilities.computeHmacSha256Signature(message, key); }
function passwordHash_(password, salt) {
  const iterations = APP_CONFIG.PBKDF2_ITERATIONS;
  let u = hmac_(salt, String(password) + '\u0001');
  let out = u.slice();
  for (let i=1;i<iterations;i++) { u = hmac_(salt,u); for(let j=0;j<out.length;j++) out[j] = (out[j] ^ u[j]); }
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
  audit_(s.username,'CHANGE_PASSWORD','Users',u.id,''); return {ok:true};
}
function requireRole_(s,roles) { if(roles.indexOf(s.role)<0) throw new Error('ليس لديك صلاحية لتنفيذ هذه العملية.'); }
function getAppData(token) {
  const s=session_(token);
  const ss=db_();
  const branches=ss.getSheetByName('Branches').getDataRange().getValues().slice(1).filter(r=>r[0] && (r[2]===true||String(r[2]).toLowerCase()==='true')).map(r=>({id:r[0],name:r[1]}));
  const items=ss.getSheetByName('Items').getDataRange().getValues().slice(1).filter(r=>r[0] && (r[6]===true||String(r[6]).toLowerCase()==='true')).map(r=>({id:r[0],barcode:r[1],code:r[2],name:r[3],unit:r[4]}));
  return {user:s,branches,items};
}
function saveCount(token,data) {
  const s=session_(token); requireRole_(s,['admin','supervisor','employee']); if(s.mustChange) throw new Error('يجب تغيير كلمة المرور أولاً.');
  data=data||{}; const code=String(data.code||'').trim(), name=String(data.name||'').trim(), branch=String(data.branch||'').trim();
  const qty=Number(data.qty), price=Number(data.price||0);
  if(!code||!name||!branch||!Number.isFinite(qty)||qty<0||!Number.isFinite(price)||price<0) throw new Error('راجع الكود والاسم والفرع والكمية والسعر.');
  const lock=LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const sh=db_().getSheetByName('InventoryLines');
    const id=Utilities.getUuid();
    sh.appendRow([id,'', '',code,name,qty,price,String(data.expiry||''),branch,s.username,new Date(),String(data.notes||'').slice(0,300)]);
    audit_(s.username,'CREATE','InventoryLines',id,'code='+code+'; qty='+qty);
    return {ok:true,id};
  } finally {lock.releaseLock();}
}
function listCounts(token) {
  const s=session_(token); const rows=db_().getSheetByName('InventoryLines').getDataRange().getValues().slice(1);
  return rows.filter(r=>r[0]).slice(-500).reverse().map(r=>({id:r[0],code:r[3],name:r[4],qty:r[5],price:r[6],expiry:r[7],branch:r[8],employee:r[9],time:r[10]}));
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
