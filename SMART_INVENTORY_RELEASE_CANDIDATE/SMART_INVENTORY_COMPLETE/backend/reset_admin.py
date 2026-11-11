from getpass import getpass
from pathlib import Path
import sqlite3,hashlib,secrets
DB=Path(__file__).resolve().parent/'smart_inventory.db'
if not DB.exists(): print('قاعدة البيانات غير موجودة؛ شغّل setup.bat أولاً.'); raise SystemExit(1)
u=input('اسم المستخدم [admin]: ').strip() or 'admin'
while True:
 p=getpass('كلمة المرور الجديدة (10 حرفاً على الأقل): ')
 if len(p)<10: print('قصيرة جداً.'); continue
 if p!=getpass('تأكيد كلمة المرور: '): print('كلمتا المرور غير متطابقتين.'); continue
 break
salt=secrets.token_hex(16); h=hashlib.pbkdf2_hmac('sha256',p.encode(),salt.encode(),240000).hex(); c=sqlite3.connect(DB); cur=c.execute('UPDATE users SET password_hash=? WHERE username=?',(salt+'$'+h,u));
if cur.rowcount==0: print('اسم المستخدم غير موجود.'); c.close(); raise SystemExit(1)
c.commit();c.close();print('تم تحديث كلمة المرور بنجاح.')
