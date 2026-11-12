"""Regression tests for report classification and sync idempotency.

Run from the backend directory with: python -m unittest discover -s tests
"""
import sys
import tempfile
import unittest
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
import app as inventory_app


class ReportAndSyncRegressionTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_db = inventory_app.DB
        inventory_app.DB = Path(self.temp_dir.name) / "test_inventory.db"
        inventory_app.init()
        c = inventory_app.db()
        c.execute(
            "INSERT INTO users(id,username,full_name,password_hash,role,active,created_at) "
            "VALUES(1,'tester','Tester','unused','admin',1,'2026-01-01')"
        )
        c.execute("INSERT INTO branches(id,code,name,created_at) VALUES(1,'B1','Branch','2026-01-01')")
        c.execute(
            "INSERT INTO sessions(id,branch_id,title,mode,status,created_by,created_at) "
            "VALUES(1,1,'Test','direct','open',1,'2026-01-01')"
        )
        c.commit()
        c.close()
        self.user = {"id": 1, "username": "tester", "role": "admin"}

    def tearDown(self):
        inventory_app.DB = self.original_db
        self.temp_dir.cleanup()

    def test_uncounted_item_is_not_reported_as_shortage(self):
        c = inventory_app.db()
        c.execute(
            "INSERT INTO items(session_id,code,name,book_qty,price,counted_qty) "
            "VALUES(1,'A','Not counted',8,5,NULL)"
        )
        c.commit()
        c.close()

        result = inventory_app.report(1, self.user)
        self.assertEqual(result["summary"]["total"], 1)
        self.assertEqual(result["summary"]["counted"], 0)
        self.assertEqual(result["summary"]["shortage"], 0)
        self.assertIsNone(result["rows"][0]["diff"])
        self.assertIsNone(result["rows"][0]["diff_value"])

    def test_counted_zero_is_shortage_and_negative_quantity_is_supported(self):
        c = inventory_app.db()
        c.execute(
            "INSERT INTO items(session_id,code,name,book_qty,price,counted_qty) "
            "VALUES(1,'ZERO','Zero count',7,2,0)"
        )
        c.execute(
            "INSERT INTO items(session_id,code,name,book_qty,price,counted_qty) "
            "VALUES(1,'NEG','Negative count',3,4,-2)"
        )
        c.commit()
        c.close()

        result = inventory_app.report(1, self.user)
        self.assertEqual(result["summary"]["counted"], 2)
        self.assertEqual(result["summary"]["shortage"], 2)
        self.assertEqual(result["rows"][0]["diff"], -7)
        self.assertEqual(result["rows"][1]["diff"], -5)

    def test_employee_can_create_session_and_add_catalog_item(self):
        employee = {"id": 2, "username": "employee", "role": "employee"}
        inventory_app.add_catalog(
            inventory_app.CatalogIn(code="EMP-1", name="Employee-added item", barcode="EMPBAR", unit="قطعة", price=3),
            employee,
        )
        created = inventory_app.new_session(
            inventory_app.SessionIn(branch_code="EMP-B", branch_name="Employee branch", title="Employee count", mode="direct"),
            employee,
        )
        self.assertTrue(created["id"])
        c = inventory_app.db()
        self.assertIsNotNone(c.execute("SELECT 1 FROM catalog WHERE code='EMP-1'").fetchone())
        self.assertIsNotNone(c.execute("SELECT 1 FROM sessions WHERE id=?", (created["id"],)).fetchone())
        c.close()

    def test_same_client_id_and_same_payload_is_idempotent(self):
        payload = [{
            "client_id": "event-1", "session_id": 1, "code": "ITEM-1",
            "name": "Item", "barcode": "123", "qty": 4, "expiry": "2027-01-01", "price": 12
        }]
        first = inventory_app.sync(payload, self.user)
        second = inventory_app.sync(payload, self.user)
        self.assertEqual(first["synced"], ["event-1"])
        self.assertEqual(second["synced"], ["event-1"])
        c = inventory_app.db()
        self.assertEqual(c.execute("SELECT count(*) n FROM items WHERE session_id=1 AND code='ITEM-1'").fetchone()["n"], 1)
        self.assertEqual(c.execute("SELECT count(*) n FROM sync_events WHERE client_id='event-1'").fetchone()["n"], 1)
        c.close()

    def test_same_client_id_with_changed_quantity_is_rejected(self):
        original = {
            "client_id": "event-2", "session_id": 1, "code": "ITEM-2",
            "name": "Item", "qty": 4, "expiry": "", "price": 12
        }
        changed = dict(original, qty=9)
        inventory_app.sync([original], self.user)
        result = inventory_app.sync([changed], self.user)
        self.assertEqual(result["synced"], [])
        self.assertEqual(len(result["rejected"]), 1)
        self.assertIn("بيانات حركة مختلفة", result["rejected"][0]["error"])
        c = inventory_app.db()
        self.assertEqual(c.execute("SELECT counted_qty FROM items WHERE code='ITEM-2'").fetchone()["counted_qty"], 4)
        c.close()

    def test_same_client_id_with_changed_expiry_or_price_is_rejected(self):
        original = {
            "client_id": "event-3", "session_id": 1, "code": "ITEM-3",
            "name": "Item", "qty": 4, "expiry": "2027-01-01", "price": 12
        }
        inventory_app.sync([original], self.user)
        for changed in (dict(original, expiry="2028-01-01"), dict(original, price=13)):
            result = inventory_app.sync([changed], self.user)
            self.assertEqual(result["synced"], [])
            self.assertEqual(len(result["rejected"]), 1)


if __name__ == "__main__":
    unittest.main()
