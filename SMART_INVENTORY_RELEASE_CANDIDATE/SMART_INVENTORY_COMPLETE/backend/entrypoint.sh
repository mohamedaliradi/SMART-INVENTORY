#!/bin/sh
set -eu
mkdir -p /var/data
if [ ! -e /app/smart_inventory.db ]; then
  ln -s /var/data/smart_inventory.db /app/smart_inventory.db
fi
if [ ! -e /var/data/smart_inventory.db ] && [ -n "${ADMIN_USERNAME:-}" ] && [ -n "${ADMIN_PASSWORD:-}" ]; then
  python -c 'import json,os; json.dump({"username":os.environ["ADMIN_USERNAME"],"password":os.environ["ADMIN_PASSWORD"],"full_name":os.environ.get("ADMIN_FULL_NAME","مدير النظام")},open("/app/admin_setup.json","w",encoding="utf-8"),ensure_ascii=False)'
fi
exec uvicorn app:app --host 0.0.0.0 --port ${PORT:-10000}
