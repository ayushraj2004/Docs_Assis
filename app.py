import os
import json
import time
import uuid
from pathlib import Path
from functools import lru_cache
from typing import List, Dict

from flask import Flask, request, jsonify, render_template, session
from flask_cors import CORS
from werkzeug.utils import secure_filename
from dotenv import load_dotenv

from rag_engine import (
    FAISSDocumentStore,
    extract_text,
    chunk_pages,
    hash_file,
    format_context,
    build_prompt,
)

load_dotenv()

app = Flask(__name__)
app.secret_key = os.getenv("SECRET_KEY", "rag-secret-key-change-in-production")
CORS(app)

UPLOAD_FOLDER = os.getenv("UPLOAD_FOLDER", "uploads")
FAISS_FOLDER = os.getenv("FAISS_FOLDER", "faiss_store")
MAX_FILE_MB = int(os.getenv("MAX_FILE_SIZE_MB", 50))
ALLOWED_EXTENSIONS = {".pdf", ".docx", ".txt"}
CHAT_HISTORY_FILE = "chat_history.json"
PINS_FILE = "pins.json"
FAVORITES_FILE = "favorites.json"
NOTES_FILE = "notes.json"
ANALYTICS_FILE = "analytics.json"
TAGS_FILE = "tags.json"

Path(UPLOAD_FOLDER).mkdir(exist_ok=True)
Path(FAISS_FOLDER).mkdir(exist_ok=True)

# Global document store (persisted to disk)
doc_store = FAISSDocumentStore(FAISS_FOLDER)

# In-memory chat sessions: {session_id: [{"role": ..., "content": ...}]}
chat_sessions: Dict[str, List[Dict]] = {}


# ──────────────────────────── LLM CLIENT ─────────────────────────────────────

def get_llm_response(messages: List[Dict]) -> str:
    provider = os.getenv("LLM_PROVIDER", "groq").lower()
    try:
        if provider == "groq":
            from groq import Groq
            client = Groq(api_key=os.getenv("GROQ_API_KEY"))
            model = os.getenv("GROQ_MODEL", "llama3-70b-8192")
            resp = client.chat.completions.create(
                model=model,
                messages=messages,
                temperature=0.1,
                max_tokens=1024,
            )
            return resp.choices[0].message.content
        elif provider == "openai":
            from openai import OpenAI
            client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
            model = os.getenv("OPENAI_MODEL", "gpt-3.5-turbo")
            resp = client.chat.completions.create(
                model=model,
                messages=messages,
                temperature=0.1,
                max_tokens=1024,
            )
            return resp.choices[0].message.content
        else:
            return f"Unknown LLM provider: {provider}. Set LLM_PROVIDER to 'groq' or 'openai'."
    except Exception as e:
        return f"LLM Error: {str(e)}"


# ──────────────────────────── HELPERS ────────────────────────────────────────

def allowed_file(filename: str) -> bool:
    return Path(filename).suffix.lower() in ALLOWED_EXTENSIONS


def load_chat_history() -> Dict:
    if os.path.exists(CHAT_HISTORY_FILE):
        with open(CHAT_HISTORY_FILE, "r") as f:
            return json.load(f)
    return {}


def save_chat_history(history: Dict):
    with open(CHAT_HISTORY_FILE, "w") as f:
        json.dump(history, f, indent=2)


# ──────────────────────────── ROUTES ─────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/upload", methods=["POST"])
def upload_document():
    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400

    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "No filename"}), 400
    if not allowed_file(file.filename):
        return jsonify({"error": f"Unsupported file type. Use PDF, DOCX, or TXT."}), 400

    filename = secure_filename(file.filename)
    filepath = os.path.join(UPLOAD_FOLDER, filename)
    file.save(filepath)

    # Check file size
    size_mb = os.path.getsize(filepath) / (1024 * 1024)
    if size_mb > MAX_FILE_MB:
        os.remove(filepath)
        return jsonify({"error": f"File too large. Max {MAX_FILE_MB}MB."}), 400

    # Check for duplicates via hash
    file_hash = hash_file(filepath)
    if doc_store.file_exists(file_hash):
        os.remove(filepath)
        return jsonify({"message": "Document already indexed.", "filename": filename, "duplicate": True}), 200

    try:
        pages = extract_text(filepath)
        chunks = chunk_pages(pages, filename)
        if not chunks:
            os.remove(filepath)
            return jsonify({"error": "No text could be extracted from the document."}), 400

        doc_store.add_document(chunks, file_hash, filename, filepath)
        return jsonify({
            "message": "Document uploaded and indexed successfully.",
            "filename": filename,
            "pages": len(pages),
            "chunks": len(chunks),
            "file_hash": file_hash,
        }), 200
    except Exception as e:
        import traceback
        traceback.print_exc()
        if os.path.exists(filepath):
            os.remove(filepath)
        return jsonify({"error": f"Processing failed: {str(e)}"}), 500


@app.route("/api/query", methods=["POST"])
def query_documents():
    data = request.get_json()
    if not data or not data.get("query", "").strip():
        return jsonify({"error": "Query cannot be empty."}), 400

    query = data["query"].strip()
    session_id = data.get("session_id", "default")
    top_k = int(data.get("top_k", 5))
    track_query(query)

    if doc_store.index.ntotal == 0:
        return jsonify({
            "answer": "I couldn't find this information in the uploaded documents.",
            "sources": [],
            "session_id": session_id,
        }), 200

    # Retrieve relevant chunks
    chunks = doc_store.search(query, top_k=top_k)
    if not chunks:
        return jsonify({
            "answer": "I couldn't find this information in the uploaded documents.",
            "sources": [],
            "session_id": session_id,
        }), 200

    # Build context and prompt
    context = format_context(chunks)
    history = chat_sessions.get(session_id, [])
    messages = build_prompt(query, context, history)

    # Get LLM answer
    answer = get_llm_response(messages)

    # Update session memory
    if session_id not in chat_sessions:
        chat_sessions[session_id] = []
    chat_sessions[session_id].append({"role": "user", "content": query})
    chat_sessions[session_id].append({"role": "assistant", "content": answer})

    # Deduplicate sources
    seen = set()
    sources = []
    for c in chunks:
        key = (c["filename"], c["page"])
        if key not in seen:
            seen.add(key)
            sources.append({"filename": c["filename"], "page": c["page"], "score": round(c["score"], 4)})

    return jsonify({
        "answer": answer,
        "sources": sources,
        "session_id": session_id,
        "chunks_used": len(chunks),
    }), 200


@app.route("/api/documents", methods=["GET"])
def list_documents():
    return jsonify(doc_store.get_stats()), 200


@app.route("/api/documents/clear", methods=["DELETE"])
def clear_documents():
    for fh, info in list(doc_store.files.items()):
        fp = info.get("filepath", "")
        if fp and os.path.exists(fp):
            os.remove(fp)
    doc_store.clear()
    return jsonify({"message": "All documents cleared."}), 200


@app.route("/api/documents/<file_hash>", methods=["DELETE"])
def delete_document(file_hash: str):
    stats = doc_store.get_stats()
    doc = next((d for d in stats["documents"] if d["file_hash"] == file_hash), None)
    if not doc:
        return jsonify({"error": "Document not found."}), 404
    filepath = doc_store.files.get(file_hash, {}).get("filepath", "")
    if filepath and os.path.exists(filepath):
        os.remove(filepath)
    doc_store.remove_document(file_hash)
    return jsonify({"message": f"Document '{doc['filename']}' removed."}), 200


@app.route("/api/session/new", methods=["POST"])
def new_session():
    session_id = str(uuid.uuid4())
    chat_sessions[session_id] = []
    return jsonify({"session_id": session_id}), 200


@app.route("/api/session/<session_id>/clear", methods=["DELETE"])
def clear_session(session_id: str):
    chat_sessions.pop(session_id, None)
    return jsonify({"message": "Session cleared."}), 200


@app.route("/api/history", methods=["GET"])
def get_history():
    """Return persisted chat history sessions."""
    return jsonify(load_chat_history()), 200


@app.route("/api/history", methods=["POST"])
def save_history():
    """Persist a chat session to disk."""
    data = request.get_json()
    history = load_chat_history()
    session_id = data.get("session_id", str(uuid.uuid4()))
    history[session_id] = data
    save_chat_history(history)
    return jsonify({"message": "Saved.", "session_id": session_id}), 200


@app.route("/api/history/<session_id>", methods=["DELETE"])
def delete_history_session(session_id: str):
    history = load_chat_history()
    history.pop(session_id, None)
    save_chat_history(history)
    return jsonify({"message": "Deleted."}), 200


@app.route("/api/stats", methods=["GET"])
def get_stats():
    stats = doc_store.get_stats()
    return jsonify({
        "total_documents": stats["total_documents"],
        "total_chunks": stats["total_chunks"],
        "total_sessions": len(chat_sessions),
        "index_size": doc_store.index.ntotal,
    }), 200


# ──────────────────────────── GENERIC JSON STORE HELPERS ─────────────────────

def load_json(path): return json.load(open(path)) if os.path.exists(path) else {}
def save_json(path, data):
    with open(path, "w") as f: json.dump(data, f, indent=2)


# ──────────────────────────── ANALYTICS TRACKING ─────────────────────────────

def track_query(query: str):
    analytics = load_json(ANALYTICS_FILE)
    today = __import__('datetime').date.today().isoformat()
    analytics.setdefault("daily", {})
    analytics["daily"][today] = analytics["daily"].get(today, 0) + 1
    analytics.setdefault("queries", [])
    analytics["queries"].append({"q": query[:120], "ts": int(time.time())})
    analytics["queries"] = analytics["queries"][-200:]  # keep last 200
    save_json(ANALYTICS_FILE, analytics)


# ──────────────────────────── PINS ────────────────────────────────────────────

@app.route("/api/pins", methods=["GET"])
def get_pins(): return jsonify(load_json(PINS_FILE)), 200

@app.route("/api/pins", methods=["POST"])
def add_pin():
    data = request.get_json()
    pins = load_json(PINS_FILE)
    pin_id = str(uuid.uuid4())[:8]
    pins[pin_id] = {"content": data["content"], "sources": data.get("sources", []), "ts": int(time.time())}
    save_json(PINS_FILE, pins)
    return jsonify({"pin_id": pin_id}), 200

@app.route("/api/pins/<pin_id>", methods=["DELETE"])
def delete_pin(pin_id):
    pins = load_json(PINS_FILE)
    pins.pop(pin_id, None)
    save_json(PINS_FILE, pins)
    return jsonify({"ok": True}), 200


# ──────────────────────────── FAVORITES ───────────────────────────────────────

@app.route("/api/favorites", methods=["GET"])
def get_favorites(): return jsonify(load_json(FAVORITES_FILE)), 200

@app.route("/api/favorites/<file_hash>", methods=["POST"])
def add_favorite(file_hash):
    favs = load_json(FAVORITES_FILE)
    doc = doc_store.files.get(file_hash, {})
    favs[file_hash] = {"filename": doc.get("filename", file_hash), "ts": int(time.time())}
    save_json(FAVORITES_FILE, favs)
    return jsonify({"ok": True}), 200

@app.route("/api/favorites/<file_hash>", methods=["DELETE"])
def remove_favorite(file_hash):
    favs = load_json(FAVORITES_FILE)
    favs.pop(file_hash, None)
    save_json(FAVORITES_FILE, favs)
    return jsonify({"ok": True}), 200


# ──────────────────────────── NOTES ───────────────────────────────────────────

@app.route("/api/notes", methods=["GET"])
def get_notes(): return jsonify(load_json(NOTES_FILE)), 200

@app.route("/api/notes", methods=["POST"])
def save_note():
    data = request.get_json()
    notes = load_json(NOTES_FILE)
    note_id = data.get("note_id", str(uuid.uuid4())[:8])
    notes[note_id] = {"text": data["text"], "ts": int(time.time())}
    save_json(NOTES_FILE, notes)
    return jsonify({"note_id": note_id}), 200

@app.route("/api/notes/<note_id>", methods=["DELETE"])
def delete_note(note_id):
    notes = load_json(NOTES_FILE)
    notes.pop(note_id, None)
    save_json(NOTES_FILE, notes)
    return jsonify({"ok": True}), 200


# ──────────────────────────── TAGS ────────────────────────────────────────────

@app.route("/api/tags", methods=["GET"])
def get_tags(): return jsonify(load_json(TAGS_FILE)), 200

@app.route("/api/tags/<file_hash>", methods=["POST"])
def set_tags(file_hash):
    tags = load_json(TAGS_FILE)
    tags[file_hash] = request.get_json().get("tags", [])
    save_json(TAGS_FILE, tags)
    return jsonify({"ok": True}), 200


# ──────────────────────────── ANALYTICS ───────────────────────────────────────

@app.route("/api/analytics", methods=["GET"])
def get_analytics():
    analytics = load_json(ANALYTICS_FILE)
    daily = analytics.get("daily", {})
    queries = analytics.get("queries", [])
    # top queries
    from collections import Counter
    top = Counter(q["q"] for q in queries).most_common(10)
    return jsonify({"daily": daily, "total_queries": len(queries), "top_queries": top}), 200


# ──────────────────────────── SUMMARY ─────────────────────────────────────────

@app.route("/api/summary/<file_hash>", methods=["GET"])
def summarize_document(file_hash):
    doc_info = doc_store.files.get(file_hash)
    if not doc_info:
        return jsonify({"error": "Document not found."}), 404
    chunks = [m for m in doc_store.metadata if m["filename"] == doc_info["filename"]][:10]
    combined = " ".join(c["text"] for c in chunks)[:4000]
    messages = [
        {"role": "system", "content": "Summarize the following document content in 5-7 concise bullet points."},
        {"role": "user", "content": combined}
    ]
    summary = get_llm_response(messages)
    return jsonify({"filename": doc_info["filename"], "summary": summary}), 200


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5000, threaded=True)
