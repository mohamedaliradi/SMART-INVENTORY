from fastapi import FastAPI, HTTPException, Depends, UploadFile, File, Header
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from pathlib import Path
import hashlib, secrets, os, io, csv, json, math, re
import psycopg
from psycopg.rows import dict_row
from datetime import datetime, date
from openpyxl import load_workbook, Workbook

BASE=Path(__file__).resolve().parent
DB_URL=os.getenv('DATABASE_URL','').strip()
STATIC=BASE/'static'
app=FastAPI(title='SMART INVENTORY')
app.mount('/static',StaticFiles(directory=STATIC),name='static')

class PGConnection:
 def __init__(self, connection): self.connection=connection
 def execute(self, sql, params=()):
  sql=sql.strip()
  if sql.upper().startswith('PRAGMA '): return self.connection.execute('SELECT 1')
  if 'last_insert_rowid()' in sql.lower(): sql='SELECT lastval() AS n'
  if sql.upper().startswith('INSERT OR REPLACE INTO ITEMS'):
   m=re.match(r'INSERT OR REPLACE INTO items\s*\(([^)]+)\)\s*(.*)',sql,re.I|re.S)
   if m:
    cols=[x.strip() for x in m.group(1).split(',')]
    updates=[f'{x}=EXCLUDED.{x}' for x in cols if x not in ('session_id','code')]
    sql=f"INSERT INTO items ({', '.join(cols)}) {m.group(2)} ON CONFLICT (session_id, code) DO UPDATE SET {', '.join(updates)}"
  sql=sql.replace('?','%s')
  return self.connection.execute(sql,params)
 def commit(self): return self.connection.commit()
 def rollback(self): return self.connection.rollback()
 def close(self): return self.connection.close()

def db():
 if not DB_URL: raise RuntimeError('DATABASE_URL is required; configure a PostgreSQL connection string.')
 return PGConnection(psycopg.connect(DB_URL,row_factory=dict_row))

def init():
 migration=BASE/'migrations'/'001_initial_postgresql.sql'
 if not migration.exists(): raise RuntimeError(f'PostgreSQL migration not found: {migration}')
 c=db()
 try:
  for statement in migration.read_text(encoding='utf-8').split(';'):
   if statement.strip(): c.execute(statement)
  c.commit()
 except Exception:
  c.rollback(); raise
 finally: c.close()

def pw_hash(p):
 salt=secrets.token_hex(16); h=hashlib.pbkdf2_hmac('sha256',p.encode(),salt.encode(),240000).hex(); return salt+'$'+h

def pw_ok(p, stored):
 try:
  salt,h=stored.split('$',1); return secrets.compare_digest(hashlib.pbkdf2_hmac('sha256',p.encode(),salt.encode(),240000).hex(),h)
 except: return False

def audit(c,uid,act,details=''):
 c.execute('INSERT INTO audit(user_id,action,details,created_at) VALUES(?,?,?,?)',(uid,act,details,datetime.now().isoformat(timespec='seconds')))

@app.on_event('startup')
def startup():
 init(); c=db()
 if not c.execute('SELECT 1 FROM users LIMIT 1').fetchone():
  cfg=BASE/'admin_setup.json'
  if cfg.exists():
   try:
    data=json.loads(cfg.read_text(encoding='utf-8')); u=data['username']; p=data['password']
    c.execute('INSERT INTO users(username,full_name,password_hash,role,created_at) VALUES(?,?,?,?,?)',(u,data.get('full_name','مدير النظام'),pw_hash(p),'admin',datetime.now().isoformat()))
    cfg.unlink(missing_ok=True)
   except Exception as e: print('Admin bootstrap skipped:',e)
 c.commit(); c.close()

class Login(BaseModel): username:str; password:str
class UserIn(BaseModel): username:str; full_name:str=''; password:str=Field(min_length=8); role:str='employee'
class SessionIn(BaseModel): branch_code:str=''; branch_name:str; title:str=''; mode:str='excel'
class CountIn(BaseModel): code:str; name:str=''; barcode:str=''; qty:float; expiry:str=''; price:float=0
class CatalogIn(BaseModel): code:str; name:str; barcode:str=''; unit:str='قطعة'; price:float=0

async def current(authorization:str|None=Header(default=None)):
 if not authorization or not authorization.startswith('Bearer '): raise HTTPException(401,'يلزم تسجيل الدخول')
 token=authorization[7:]; c=db(); r=c.execute('SELECT u.* FROM tokens t JOIN users u ON u.id=t.user_id WHERE t.token=? AND u.active=TRUE',(token,)).fetchone(); c.close()
 if not r: raise HTTPException(401,'انتهت الجلسة، سجل الدخول مرة أخرى')
 return dict(r)

def admin(u):
 if u['role']!='admin': raise HTTPException(403,'هذه العملية للمدير فقط')

@app.get('/')
def home(): return FileResponse(STATIC/'index.html')
@app.get('/manifest.webmanifest')
def manifest(): return FileResponse(STATIC/'manifest.webmanifest',media_type='application/manifest+json')
@app.get('/sw.js')
def sw(): return FileResponse(STATIC/'sw.js',media_type='application/javascript')

@app.post('/api/login')
def login(x:Login):
 c=db(); r=c.execute('SELECT * FROM users WHERE username=? AND active=1',(x.username,)).fetchone()
 if not r or not pw_ok(x.password,r['password_hash']): c.close(); raise HTTPException(401,'اسم المستخدم أو كلمة المرور غير صحيحة')
 token=secrets.token_urlsafe(36); c.execute('INSERT INTO tokens VALUES(?,?,?)',(token,r['id'],datetime.now().isoformat())); audit(c,r['id'],'login'); c.commit(); c.close()
 return {'token':token,'user':{'id':r['id'],'username':r['username'],'full_name':r['full_name'],'role':r['role']}}
@app.post('/api/logout')
def logout(u=Depends(current),authorization:str=Header()):
 c=db(); c.execute('DELETE FROM tokens WHERE token=?',(authorization[7:],)); audit(c,u['id'],'logout'); c.commit(); c.close(); return {'ok':True}
@app.get('/api/me')
def me(u=Depends(current)): return {'id':u['id'],'username':u['username'],'full_name':u['full_name'],'role':u['role']}
@app.get('/api/dashboard')
def dashboard(u=Depends(current)):
 c=db(); d={'users':c.execute('SELECT count(*) n FROM users WHERE active=1').fetchone()['n'],'sessions':c.execute('SELECT count(*) n FROM sessions').fetchone()['n'],'catalog':c.execute('SELECT count(*) n FROM catalog').fetchone()['n'],'open_sessions':c.execute("SELECT count(*) n FROM sessions WHERE status='open'").fetchone()['n']}; c.close(); return d
@app.get('/api/users')
def users(u=Depends(current)):
 admin(u); c=db(); rows=[dict(x) for x in c.execute('SELECT id,username,full_name,role,active,created_at FROM users ORDER BY id')]; c.close(); return rows
@app.post('/api/users')
def add_user(x:UserIn,u=Depends(current)):
 admin(u); c=db()
 try: c.execute('INSERT INTO users(username,full_name,password_hash,role,created_at) VALUES(?,?,?,?,?)',(x.username,x.full_name,pw_hash(x.password),x.role,datetime.now().isoformat())); audit(c,u['id'],'create_user',x.username); c.commit()
 except psycopg.IntegrityError: c.close(); raise HTTPException(409,'اسم المستخدم مستخدم بالفعل')
 c.close(); return {'ok':True}
@app.post('/api/users/{uid}/toggle')
def toggle_user(uid:int,u=Depends(current)):
 admin(u); c=db(); c.execute('UPDATE users SET active=NOT active WHERE id=? AND id<>?',(uid,u['id'])); c.commit(); c.close(); return {'ok':True}
@app.get('/api/catalog')
def catalog(q:str='',u=Depends(current)):
 c=db(); rows=[dict(x) for x in c.execute('SELECT * FROM catalog WHERE code LIKE ? OR name LIKE ? OR barcode LIKE ? ORDER BY name LIMIT 250',(f'%{q}%',f'%{q}%',f'%{q}%'))]; c.close(); return rows
@app.post('/api/catalog')
def add_catalog(x:CatalogIn,u=Depends(current)):
 c=db()
 try: c.execute('INSERT INTO catalog(code,barcode,name,unit,price) VALUES(?,?,?,?,?)',(x.code,x.barcode,x.name,x.unit,x.price)); c.commit()
 except sqlite3.IntegrityError: c.close(); raise HTTPException(409,'كود الصنف موجود بالفعل')
 c.close(); return {'ok':True}
@app.post('/api/sessions')
def new_session(x:SessionIn,u=Depends(current)):
 c=db(); cur=c.execute('INSERT INTO branches(code,name,created_at) VALUES(?,?,?) RETURNING id',(x.branch_code,x.branch_name,datetime.now().isoformat())); bid=cur.fetchone()['id']
 cur=c.execute('INSERT INTO sessions(branch_id,title,mode,created_by,created_at) VALUES(?,?,?,?,?) RETURNING id',(bid,x.title or x.branch_name,x.mode,u['id'],datetime.now().isoformat())); sid=cur.fetchone()['id']; audit(c,u['id'],'create_session',str(sid)); c.commit(); c.close(); return {'id':sid}
@app.get('/api/sessions')
def sessions(u=Depends(current)):
 c=db(); rows=[dict(x) for x in c.execute('SELECT s.*,b.code branch_code,b.name branch_name,(SELECT count(*) FROM items i WHERE i.session_id=s.id) total,(SELECT count(*) FROM items i WHERE i.session_id=s.id AND i.counted_qty IS NOT NULL) counted FROM sessions s JOIN branches b ON b.id=s.branch_id ORDER BY s.id DESC')]; c.close(); return rows
@app.post('/api/sessions/{sid}/import')
async def import_excel(sid:int,file:UploadFile=File(...),u=Depends(current)):
 data=await file.read(); name=file.filename.lower()
 c=db()
 session=c.execute('SELECT status FROM sessions WHERE id=?',(sid,)).fetchone()
 if not session: c.close(); raise HTTPException(404,'عملية الجرد غير موجودة')
 if session['status']!='open': c.close(); raise HTTPException(409,'عملية الجرد مغلقة ولا تقبل استيراداً')
 try:
  if name.endswith('.csv'):
   text=data.decode('utf-8-sig'); rows=list(csv.DictReader(io.StringIO(text)))
   def get(row,*keys):
    for k in keys:
     for rk in row:
      if rk and rk.strip().lower() in [z.lower() for z in keys] and row[rk] not in (None,''): return row[rk]
    return ''
   for r in rows:
    code=str(get(r,'code','item_code','كود الصنف','الكود')).strip(); nm=str(get(r,'name','item_name','اسم الصنف','الصنف')).strip()
    if code: c.execute('INSERT OR REPLACE INTO items(session_id,code,name,book_qty,price) VALUES(?,?,?,?,?)',(sid,code,nm,float(get(r,'qty','quantity','الرصيد','الكمية') or 0),float(get(r,'price','unit_price','السعر') or 0)))
  else:
   wb=load_workbook(io.BytesIO(data),read_only=True,data_only=True); ws=wb.active; rows=list(ws.iter_rows(values_only=True)); headers=[str(x or '').strip().lower() for x in rows[0]]
   def col(*aliases): return next((headers.index(a.lower()) for a in aliases if a.lower() in headers),None)
   ci=col('code','item_code','كود الصنف','الكود'); ni=col('name','item_name','اسم الصنف','الصنف'); qi=col('qty','quantity','الرصيد','الرصيد الحالي','الكمية'); pi=col('price','unit_price','السعر','سعر الوحده','سعر الوحدة'); bi=col('barcode','باركود')
   if ci is None: raise ValueError('لم أجد عمود كود الصنف في الملف')
   for row in rows[1:]:
    code=str(row[ci] or '').strip()
    if code: c.execute('INSERT OR REPLACE INTO items(session_id,code,barcode,name,book_qty,price) VALUES(?,?,?,?,?,?)',(sid,code,str(row[bi] or '') if bi is not None else '',str(row[ni] or '') if ni is not None else '',float(row[qi] or 0) if qi is not None else 0,float(row[pi] or 0) if pi is not None else 0))
   wb.close()
 except Exception as e: c.rollback(); c.close(); raise HTTPException(400,f'تعذر قراءة الملف: {e}')
 audit(c,u['id'],'import_excel',f'session={sid}; file={file.filename}'); c.commit(); n=c.execute('SELECT count(*) n FROM items WHERE session_id=?',(sid,)).fetchone()['n']; c.close(); return {'ok':True,'items':n}
@app.get('/api/sessions/{sid}/items')
def session_items(sid:int,q:str='',u=Depends(current)):
 c=db(); rows=[dict(x) for x in c.execute('SELECT * FROM items WHERE session_id=? AND (code LIKE ? OR name LIKE ? OR barcode LIKE ?) ORDER BY name LIMIT 500',(sid,f'%{q}%',f'%{q}%',f'%{q}%'))]; c.close(); return rows
@app.post('/api/sessions/{sid}/count')
def count_item(sid:int,x:CountIn,u=Depends(current)):
 if not math.isfinite(x.qty) or not math.isfinite(x.price) or x.price < 0: raise HTTPException(422,'الكمية والسعر يجب أن يكونا أرقاماً صحيحة، والسعر لا يمكن أن يكون سالباً')
 c=db(); session=c.execute('SELECT status FROM sessions WHERE id=?',(sid,)).fetchone()
 if not session: c.close(); raise HTTPException(404,'عملية الجرد غير موجودة')
 if session['status']!='open': c.close(); raise HTTPException(409,'عملية الجرد مغلقة ولا تقبل حركات جديدة')
 r=c.execute('SELECT * FROM items WHERE session_id=? AND (code=? OR barcode=?)',(sid,x.code,x.code)).fetchone()
 if r:
  c.execute('UPDATE items SET counted_qty=?,expiry=?,counted_by=?,counted_at=? WHERE id=?',(x.qty,x.expiry,u['id'],datetime.now().isoformat(),r['id'])); iid=r['id']
 else:
  c.execute('INSERT INTO items(session_id,code,barcode,name,book_qty,price,counted_qty,expiry,counted_by,counted_at) VALUES(?,?,?,?,0,?,?,?,?,?)',(sid,x.code,x.barcode or x.code,x.name,x.price,x.qty,x.expiry,u['id'],datetime.now().isoformat())); iid=c.execute('SELECT lastval() n').fetchone()['n']
 audit(c,u['id'],'count',f'session={sid}; code={x.code}; qty={x.qty}'); c.commit(); c.close(); return {'ok':True,'id':iid}
@app.post('/api/sync')
def sync(payload:list[dict],u=Depends(current)):
 # Each client_id is an idempotency key: retrying a batch cannot duplicate a count.
 done=[]; rejected=[]
 if len(payload)>500: raise HTTPException(413,'الحد الأقصى 500 حركة في الدفعة الواحدة')
 c=db()
 for x in payload:
  client_id=str(x.get('client_id','')).strip()
  try:
   if not client_id or len(client_id)>100: raise ValueError('client_id مفقود أو غير صالح')
   prior=c.execute('SELECT user_id,session_id,item_code FROM sync_events WHERE client_id=?',(client_id,)).fetchone()
   if prior:
    if prior['user_id']!=u['id'] or prior['session_id']!=int(x['session_id']) or prior['item_code']!=str(x['code']).strip():
     raise ValueError('معرّف الحركة مستخدم لحركة أخرى')
    done.append(client_id); continue
   sid=int(x['session_id'])
   data=CountIn(code=str(x['code']).strip(),name=str(x.get('name','')),barcode=str(x.get('barcode','')),qty=float(x['qty']),expiry=str(x.get('expiry','')),price=float(x.get('price',0)))
   if not data.code: raise ValueError('كود الصنف مطلوب')
   session=c.execute('SELECT status FROM sessions WHERE id=?',(sid,)).fetchone()
   if not session: raise ValueError('عملية الجرد غير موجودة')
   if session['status']!='open': raise ValueError('عملية الجرد مغلقة')
   if not math.isfinite(data.qty) or not math.isfinite(data.price) or data.price<0: raise ValueError('الكمية أو السعر غير صالح')
   # Keep each event atomic with its idempotency record.
   c.execute('SAVEPOINT one_sync')
   r=c.execute('SELECT * FROM items WHERE session_id=? AND (code=? OR barcode=?)',(sid,data.code,data.code)).fetchone()
   now=datetime.now().isoformat(timespec='seconds')
   if r:
    c.execute('UPDATE items SET counted_qty=?,expiry=?,counted_by=?,counted_at=? WHERE id=?',(data.qty,data.expiry,u['id'],now,r['id'])); iid=r['id']
   else:
    c.execute('INSERT INTO items(session_id,code,barcode,name,book_qty,price,counted_qty,expiry,counted_by,counted_at) VALUES(?,?,?,?,0,?,?,?,?,?)',(sid,data.code,data.barcode or data.code,data.name,data.price,data.qty,data.expiry,u['id'],now)); iid=c.execute('SELECT last_insert_rowid() n').fetchone()['n']
   audit(c,u['id'],'sync_count',f'session={sid}; code={data.code}; qty={data.qty}; client_id={client_id}')
   c.execute('INSERT INTO sync_events(client_id,user_id,session_id,item_code,created_at,result_json) VALUES(?,?,?,?,?,?)',(client_id,u['id'],sid,data.code,now,json.dumps({'item_id':iid})))
   c.execute('RELEASE one_sync'); c.commit(); done.append(client_id)
  except Exception as e:
   try: c.execute('ROLLBACK TO one_sync'); c.execute('RELEASE one_sync')
   except Exception: pass
   c.rollback(); rejected.append({'client_id':client_id,'error':str(e)})
 c.close()
 return {'synced':done,'rejected':rejected,'count':len(done)}
@app.get('/api/reports/{sid}')
def report(sid:int,u=Depends(current)):
 c=db(); rows=[dict(x) for x in c.execute('SELECT *,COALESCE(counted_qty,0)-book_qty diff,(COALESCE(counted_qty,0)-book_qty)*price diff_value FROM items WHERE session_id=? ORDER BY name',(sid,))]; c.close()
 return {'rows':rows,'summary':{'total':len(rows),'counted':sum(x['counted_qty'] is not None for x in rows),'shortage':sum(x['diff']<0 for x in rows),'surplus':sum(x['diff']>0 for x in rows),'matched':sum(x['diff']==0 for x in rows),'shortage_value':sum(-x['diff_value'] for x in rows if x['diff']<0),'surplus_value':sum(x['diff_value'] for x in rows if x['diff']>0)}}
@app.get('/api/reports/{sid}/xlsx')
def report_xlsx(sid:int,u=Depends(current)):
 data=report(sid,u); wb=Workbook(); ws=wb.active; ws.title='تقرير الجرد'; ws.append(['كود الصنف','الباركود','اسم الصنف','الرصيد الدفتري','الكمية الفعلية','الفرق','سعر الوحدة','قيمة الفرق','الصلاحية'])
 for r in data['rows']: ws.append([r['code'],r['barcode'],r['name'],r['book_qty'],r['counted_qty'],r['diff'],r['price'],r['diff_value'],r['expiry']])
 for col in ws.columns:
  ws.column_dimensions[col[0].column_letter].width=min(32,max(14,max(len(str(x.value or '')) for x in col)+2))
 out=io.BytesIO(); wb.save(out); out.seek(0); return StreamingResponse(out,media_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',headers={'Content-Disposition':f'attachment; filename=inventory_{sid}.xlsx'})
@app.get('/api/audit')
def logs(u=Depends(current)):
 admin(u); c=db(); rows=[dict(x) for x in c.execute('SELECT a.*,u.username FROM audit a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 300')]; c.close(); return rows
@app.post('/api/sessions/{sid}/close')
def close_session(sid:int,u=Depends(current)):
 admin(u); c=db(); c.execute("UPDATE sessions SET status='closed' WHERE id=?",(sid,)); audit(c,u['id'],'close_session',str(sid)); c.commit(); c.close(); return {'ok':True}
