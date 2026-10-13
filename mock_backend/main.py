
from datetime import datetime
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="NEM Machine Monitor API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

now = lambda: datetime.now().strftime("%Y-%m-%d %H:%M:%S")


ASSETS = [
    {"id": "edge", "name": "edge", "parent": None, "status": "idle"},
    {"id": "mixer", "name": "Mixer Dashboard", "parent": "edge", "status": "online"},
]

RULES = [
    {"id": 1, "name": "Motor temperature limit", "description": "Warn when the motor runs too hot", "severity": "warning",
     "asset_id": "mixer", "state": "activated", "status": "ok"},
    {"id": 2, "name": "Vibration threshold", "description": "", "severity": "alert",
     "asset_id": "edge", "state": "not_activated", "status": "ok"},
    {"id": 3, "name": "Pressure drop check", "description": "", "severity": "warning",
     "asset_id": "mixer", "state": "not_activated", "status": "ok"},
]
COLLECTIONS = [{"id": 1, "name": "Mixer machines", "description": "Rules for mixer type machines"}]
DOCUMENTS = [{"id": 1, "title": "Mixer inspection steps", "kind": "Instruction", "description": "Daily checks for the mixer"}]
LOGBOOK = [{"id": 1, "asset_id": "mixer", "text": "Initial setup completed", "time": now()}]
EVENTS = [{"id": 1, "asset_id": "mixer", "text": "Asset connected", "time": now()}]
BACKUPS: list[dict] = []
SETTINGS = {
    "user": {"name": "admin", "role": "Administrator", "email": "admin@example.com", "phone": ""},
    "email": {"host": "", "port": "587", "username": "", "password": "", "sender": ""},
    "analytics": {"databus_host": "", "databus_port": "", "enabled": "false"},
}
_next = {"rule": 4, "col": 2, "doc": 2, "log": 2, "event": 2, "backup": 1}


def nid(k: str) -> int:
    v = _next[k]
    _next[k] += 1
    return v


def asset_name(aid):
    return next((a["name"] for a in ASSETS if a["id"] == aid), "-")


def need(value: str, label: str) -> str:
    """Reject empty required fields with a clear 422 message."""
    if not value or not value.strip():
        raise HTTPException(422, f"{label} is required")
    return value.strip()


def new_rule(body, asset_id):
    if body.severity not in ("warning", "alert"):
        raise HTTPException(422, "Severity must be warning or alert")
    return {
        "id": nid("rule"), "name": need(body.name, "Name"), "description": body.description.strip(),
        "severity": body.severity, "asset_id": asset_id or None, "state": "not_activated", "status": body.status,
    }


def add_event(aid, text):
    EVENTS.insert(0, {"id": nid("event"), "asset_id": aid, "text": text, "time": now()})



class RuleIn(BaseModel):
    name: str
    description: str = ""
    asset_id: Optional[str] = None
    severity: str = "warning"
    status: str = "ok"        


class StateIn(BaseModel):
    state: str


class CollectionIn(BaseModel):
    name: str
    description: str = ""


class DocumentIn(BaseModel):
    title: str
    kind: str = "Document"
    description: str = ""


class BackupIn(BaseModel):
    name: Optional[str] = None
    note: str = ""


class LogIn(BaseModel):
    text: str


class ProfileIn(BaseModel):
  
    name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None



def get_current_user() -> dict:
    """The user who is using the app right now.

    TODAY  : returns one demo user kept in SETTINGS["user"].
    LATER  : when you add login, change ONLY this function. Read the token / session
             from the request, look the user up in your database and return that user
             as {"name": ..., "role": ..., "email": ..., "phone": ...}.
             The frontend, /api/me and the Profile page need no change.
    """
    return SETTINGS["user"]



@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/summary")
def summary():
    act = [r for r in RULES if r["state"] == "activated"]
    alert = [r for r in act if r["status"] == "alert"]
    warn = [r for r in act if r["status"] == "warning"]
    monitored = {r["asset_id"] for r in act if r["asset_id"]}
    count = lambda s: len([r for r in RULES if r["state"] == s])
    return {
        "rules_alert": len(alert),
        "rules_warning": len(warn),
        "assets_alert": len({r["asset_id"] for r in alert}),
        "assets_warning": len({r["asset_id"] for r in warn}),
        "monitored_assets": len(monitored),
        "total_assets": len(ASSETS),
        "stats": {
            "activated": count("activated"),
            "suspended": count("suspended"),
            "finished": count("finished"),
            "not_activated": count("not_activated"),
        },
    }


@app.get("/api/assets")
def list_assets():
    return ASSETS


@app.get("/api/assets/{asset_id}")
def get_asset(asset_id: str):
    a = next((a for a in ASSETS if a["id"] == asset_id), None)
    if not a:
        raise HTTPException(404, "Asset not found")
    return a


@app.get("/api/assets/{asset_id}/rules")
def asset_rules(asset_id: str, include_children: bool = False):
    ids = {asset_id}
    if include_children:
        ids |= {a["id"] for a in ASSETS if a["parent"] == asset_id}
    return [{**r, "asset_name": asset_name(r["asset_id"])} for r in RULES if r["asset_id"] in ids]


@app.post("/api/assets/{asset_id}/rules")
def add_asset_rule(asset_id: str, body: RuleIn):
    r = new_rule(body, asset_id)
    RULES.append(r)
    add_event(asset_id, f"Rule '{r['name']}' added")
    return r


@app.post("/api/assets/{asset_id}/rules/bulk")
def bulk_state(asset_id: str, body: StateIn):
    n = 0
    for r in RULES:
        if r["asset_id"] == asset_id:
            r["state"] = body.state
            n += 1
    add_event(asset_id, f"{n} rule(s) set to {body.state}")
    return {"updated": n}


@app.get("/api/assets/{asset_id}/logbook")
def get_logbook(asset_id: str):
    return [l for l in LOGBOOK if l["asset_id"] == asset_id]


@app.post("/api/assets/{asset_id}/logbook")
def add_logbook(asset_id: str, body: LogIn):
    e = {"id": nid("log"), "asset_id": asset_id, "text": body.text, "time": now()}
    LOGBOOK.insert(0, e)
    return e


@app.get("/api/assets/{asset_id}/events")
def get_events(asset_id: str):
    return [e for e in EVENTS if e["asset_id"] == asset_id]


@app.get("/api/events")
def recent_events():
    return [{**e, "asset_name": asset_name(e["asset_id"])} for e in EVENTS[:8]]


@app.get("/api/rules")
def all_rules():
    return [{**r, "asset_name": asset_name(r["asset_id"])} for r in RULES]


@app.get("/api/rules/status/{kind}")
def rules_by_status(kind: str):
    return [
        {**r, "asset_name": asset_name(r["asset_id"])}
        for r in RULES
        if r["state"] == "activated" and r["status"] == kind
    ]


@app.post("/api/rules")
def create_rule(body: RuleIn):
    r = new_rule(body, body.asset_id)
    RULES.append(r)
    return r


@app.patch("/api/rules/{rule_id}")
def set_rule_state(rule_id: int, body: StateIn):
    r = next((r for r in RULES if r["id"] == rule_id), None)
    if not r:
        raise HTTPException(404, "Rule not found")
    r["state"] = body.state
    add_event(r["asset_id"], f"Rule '{r['name']}' set to {body.state}")
    return r


@app.delete("/api/rules/{rule_id}")
def delete_rule(rule_id: int):
    global RULES
    RULES = [r for r in RULES if r["id"] != rule_id]
    return {"deleted": rule_id}


@app.get("/api/collections")
def list_collections():
    return COLLECTIONS


@app.post("/api/collections")
def create_collection(body: CollectionIn):
    c = {"id": nid("col"), "name": need(body.name, "Name"), "description": body.description.strip()}
    COLLECTIONS.append(c)
    return c


@app.delete("/api/collections/{cid}")
def delete_collection(cid: int):
    global COLLECTIONS
    COLLECTIONS = [c for c in COLLECTIONS if c["id"] != cid]
    return {"deleted": cid}


@app.get("/api/documents")
def list_documents():
    return DOCUMENTS


@app.post("/api/documents")
def create_document(body: DocumentIn):
    d = {"id": nid("doc"), "title": need(body.title, "Title"), "kind": body.kind, "description": body.description.strip()}
    DOCUMENTS.append(d)
    return d


@app.delete("/api/documents/{did}")
def delete_document(did: int):
    global DOCUMENTS
    DOCUMENTS = [d for d in DOCUMENTS if d["id"] != did]
    return {"deleted": did}


@app.post("/api/import")
def import_config(payload: dict):
    """Accepts {"rules": [{"name": ...}], "collections": [{"name": ...}]}"""
    for r in payload.get("rules", []):
        RULES.append({"id": nid("rule"), "name": r.get("name", "Imported rule"), "description": r.get("description", ""),
                      "severity": r.get("severity", "warning"), "asset_id": None, "state": "not_activated", "status": "ok"})
    for c in payload.get("collections", []):
        COLLECTIONS.append({"id": nid("col"), "name": c.get("name", "Imported"), "description": c.get("description", "")})
    return {"rules": len(payload.get("rules", [])), "collections": len(payload.get("collections", []))}


@app.get("/api/me")
def read_me(user: dict = Depends(get_current_user)):
    return user


@app.put("/api/me")
def update_me(body: ProfileIn, user: dict = Depends(get_current_user)):
    data = body.model_dump(exclude_none=True)
    if "name" in data and not data["name"].strip():
        raise HTTPException(422, "Name cannot be empty")
    if "email" in data and data["email"] and "@" not in data["email"]:
        raise HTTPException(422, "Email is not valid")
    user.update({k: v.strip() for k, v in data.items()})
    return user


@app.get("/api/settings/{section}")
def get_settings(section: str):
    if section not in SETTINGS:
        raise HTTPException(404, "Unknown settings section")
    return SETTINGS[section]


@app.put("/api/settings/{section}")
def put_settings(section: str, payload: dict):
    if section not in SETTINGS:
        raise HTTPException(404, "Unknown settings section")
    SETTINGS[section].update({k: str(v) for k, v in payload.items()})
    return SETTINGS[section]


@app.get("/api/usage")
def usage():
    return {
        "assets": len(ASSETS),
        "rules": len(RULES),
        "rule_collections": len(COLLECTIONS),
        "documents": len(DOCUMENTS),
        "events": len(EVENTS),
    }


@app.get("/api/backups")
def list_backups():
    return BACKUPS


@app.post("/api/backups")
def create_backup(body: Optional[BackupIn] = None):
    name = (body.name or "").strip() if body else ""
    b = {"id": nid("backup"), "name": name or f"nem-backup-{len(BACKUPS) + 1}",
         "note": body.note.strip() if body else "", "created": now()}
    BACKUPS.insert(0, b)
    return b


@app.post("/api/backups/{bid}/restore")
def restore_backup(bid: int):
    if not any(b["id"] == bid for b in BACKUPS):
        raise HTTPException(404, "Backup not found")
    return {"restored": bid}