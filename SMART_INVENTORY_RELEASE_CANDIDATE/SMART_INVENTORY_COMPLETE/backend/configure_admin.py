from getpass import getpass
from pathlib import Path
import json, sqlite3
BASE=Path(__file__).resolve().parent
DB=BASE/'smart_inventory.db'
while True:
 username=input('اسم مستخدم المدير [admin]: ').strip() or 'admin'
 full=input('اسم المدير [مدير النظام]: ').strip() or 'مدير النظام'
 p=getpass('كلمة مرور المدير (10 حرفاً على الأقل): ')
 if len(p)<10: print('كلمة المرور يجب أن تكون 10 حرفاً على الأقل.'); continue
 p2=getpass('تأكيد كلمة المرور: ')
 if p!=p2: print('كلمتا المرور غير متطابقتين. أعد المحاولة.'); continue
 break
cfg=BASE/'admin_setup.json';cfg.write_text(json.dumps({'username':username,'full_name':full,'password':p},ensure_ascii=False),encoding='utf-8')
print('تم حفظ إعداد المدير. عند أول تشغيل سيتم إنشاء الحساب.')
