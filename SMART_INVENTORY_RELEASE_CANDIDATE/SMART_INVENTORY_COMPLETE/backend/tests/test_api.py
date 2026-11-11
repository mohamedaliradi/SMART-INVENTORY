import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app as system
from fastapi.testclient import TestClient


def setup_client():
    # CI supplies an isolated PostgreSQL service database for this test run.
    system.init()
    c = system.db()
    c.execute("TRUNCATE TABLE sync_events, tokens, audit, items, sessions, branches, catalog, users RESTART IDENTITY CASCADE")
    c.execute(
        'INSERT INTO users(username,full_name,password_hash,role,created_at) VALUES(?,?,?,?,?)',
        ('admin-test', 'Admin', system.pw_hash('StrongPassword123'), 'admin', 'now'),
    )
    c.commit()
    c.close()
    client = TestClient(system.app)
    client.__enter__()
    token_response = client.post('/api/login', json={'username':'admin-test','password':'StrongPassword123'})
    assert token_response.status_code == 200, token_response.text
    return client, {'Authorization': 'Bearer ' + token_response.json()['token']}


def test_login_create_session_and_idempotent_sync():
    client, headers = setup_client()
    sid = client.post('/api/sessions', headers=headers, json={'branch_code':'T1','branch_name':'Test Branch','mode':'direct'}).json()['id']
    event = {'client_id':'offline-event-1','session_id':sid,'code':'SKU-1','name':'Test item','qty':7,'price':12.5}
    first = client.post('/api/sync', headers=headers, json=[event])
    second = client.post('/api/sync', headers=headers, json=[event])
    assert first.status_code == 200 and first.json()['count'] == 1
    assert second.status_code == 200 and second.json()['count'] == 1
    rows = client.get(f'/api/sessions/{sid}/items', headers=headers).json()
    assert len(rows) == 1 and float(rows[0]['counted_qty']) == 7
    client.__exit__(None, None, None)


def test_closed_session_rejects_new_count():
    client, headers = setup_client()
    sid = client.post('/api/sessions', headers=headers, json={'branch_code':'T2','branch_name':'Test Branch 2','mode':'direct'}).json()['id']
    assert client.post(f'/api/sessions/{sid}/close', headers=headers).status_code == 200
    r = client.post(f'/api/sessions/{sid}/count', headers=headers, json={'code':'SKU-2','qty':2})
    assert r.status_code == 409
    client.__exit__(None, None, None)


def test_negative_quantity_and_report_export():
    client, headers = setup_client()
    sid = client.post('/api/sessions', headers=headers, json={'branch_code':'T3','branch_name':'Test Branch 3','mode':'direct'}).json()['id']
    r = client.post(f'/api/sessions/{sid}/count', headers=headers, json={'code':'SKU-NEG','name':'Negative balance','qty':-3,'price':4})
    assert r.status_code == 200
    report = client.get(f'/api/reports/{sid}', headers=headers).json()
    assert report['summary']['shortage'] == 1
    assert float(report['rows'][0]['diff']) == -3
    xlsx = client.get(f'/api/reports/{sid}/xlsx', headers=headers)
    assert xlsx.status_code == 200
    assert 'spreadsheetml' in xlsx.headers['content-type']
    client.__exit__(None, None, None)
