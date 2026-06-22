import os
import re
import json
import pickle
import hashlib
import numpy as np
from pathlib import Path
from typing import List, Dict, Tuple, Optional

import fitz  # PyMuPDF
import docx
import faiss
from sentence_transformers import SentenceTransformer

CHUNK_SIZE = 850
CHUNK_OVERLAP = 150
TOP_K = 5
EMBEDDING_MODEL = "all-MiniLM-L6-v2"

_embedder: Optional[SentenceTransformer] = None

def get_embedder() -> SentenceTransformer:
    global _embedder
    if _embedder is None:
        _embedder = SentenceTransformer(EMBEDDING_MODEL)
    return _embedder


# ──────────────────────────── TEXT EXTRACTION ────────────────────────────────

def extract_pdf(path: str) -> List[Dict]:
    """Extract text from PDF, returning list of {text, page} dicts."""
    doc = fitz.open(path)
    pages = []
    for i, page in enumerate(doc, start=1):
        text = page.get_text("text")
        if text.strip():
            pages.append({"text": text, "page": i})
    doc.close()
    return pages


def extract_docx(path: str) -> List[Dict]:
    """Extract text from DOCX, grouping paragraphs into pseudo-pages (~50 paras)."""
    doc = docx.Document(path)
    paras = [p.text for p in doc.paragraphs if p.text.strip()]
    pages, page_num, group = [], 1, []
    for para in paras:
        group.append(para)
        if len(group) >= 50:
            pages.append({"text": "\n".join(group), "page": page_num})
            page_num += 1
            group = []
    if group:
        pages.append({"text": "\n".join(group), "page": page_num})
    return pages


def extract_txt(path: str) -> List[Dict]:
    """Extract text from TXT, splitting into pseudo-pages by line count."""
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        lines = f.readlines()
    pages, page_num, group = [], 1, []
    for line in lines:
        group.append(line)
        if len(group) >= 100:
            pages.append({"text": "".join(group), "page": page_num})
            page_num += 1
            group = []
    if group:
        pages.append({"text": "".join(group), "page": page_num})
    return pages or [{"text": "", "page": 1}]


def extract_text(path: str) -> List[Dict]:
    ext = Path(path).suffix.lower()
    if ext == ".pdf":
        return extract_pdf(path)
    elif ext == ".docx":
        return extract_docx(path)
    elif ext == ".txt":
        return extract_txt(path)
    raise ValueError(f"Unsupported file type: {ext}")


# ──────────────────────────── CLEANING & CHUNKING ────────────────────────────

def clean_text(text: str) -> str:
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"[^\x00-\x7F]+", " ", text)
    return text.strip()


def chunk_pages(pages: List[Dict], filename: str) -> List[Dict]:
    """
    Intelligently chunk pages with overlap.
    Each chunk carries: text, filename, page, chunk_id
    """
    chunks = []
    chunk_id = 0
    for page_data in pages:
        text = clean_text(page_data["text"])
        if not text:
            continue
        page_num = page_data["page"]
        start = 0
        while start < len(text):
            end = start + CHUNK_SIZE
            chunk_text = text[start:end]
            # Extend to nearest sentence boundary
            if end < len(text):
                boundary = max(
                    chunk_text.rfind(". "),
                    chunk_text.rfind("? "),
                    chunk_text.rfind("! "),
                    chunk_text.rfind("\n"),
                )
                if boundary > CHUNK_SIZE // 2:
                    chunk_text = chunk_text[: boundary + 1]
            if chunk_text.strip():
                chunks.append({
                    "text": chunk_text.strip(),
                    "filename": filename,
                    "page": page_num,
                    "chunk_id": chunk_id,
                })
                chunk_id += 1
            advance = max(len(chunk_text) - CHUNK_OVERLAP, 1)
            start += advance
            if start >= len(text):
                break
    return chunks


# ──────────────────────────── FAISS STORE ────────────────────────────────────

class FAISSDocumentStore:
    def __init__(self, store_dir: str):
        self.store_dir = Path(store_dir)
        self.store_dir.mkdir(parents=True, exist_ok=True)
        self.index_path = self.store_dir / "index.faiss"
        self.meta_path = self.store_dir / "metadata.pkl"
        self.files_path = self.store_dir / "files.json"
        self.dim = 384  # all-MiniLM-L6-v2 output dim
        self._load()

    def _load(self):
        if self.index_path.exists() and self.meta_path.exists():
            self.index = faiss.read_index(str(self.index_path))
            with open(self.meta_path, "rb") as f:
                self.metadata: List[Dict] = pickle.load(f)
        else:
            self.index = faiss.IndexFlatIP(self.dim)  # Inner Product for cosine sim
            self.metadata: List[Dict] = []

        if self.files_path.exists():
            with open(self.files_path, "r") as f:
                self.files: Dict[str, Dict] = json.load(f)
        else:
            self.files: Dict[str, Dict] = {}

    def _save(self):
        faiss.write_index(self.index, str(self.index_path))
        with open(self.meta_path, "wb") as f:
            pickle.dump(self.metadata, f)
        with open(self.files_path, "w") as f:
            json.dump(self.files, f, indent=2)

    def file_exists(self, file_hash: str) -> bool:
        return file_hash in self.files

    def add_document(self, chunks: List[Dict], file_hash: str, filename: str, filepath: str):
        """Embed chunks and add to FAISS index."""
        embedder = get_embedder()
        texts = [c["text"] for c in chunks]
        embeddings = embedder.encode(texts, normalize_embeddings=True, show_progress_bar=False)
        embeddings = np.array(embeddings, dtype="float32")
        self.index.add(embeddings)
        self.metadata.extend(chunks)
        self.files[file_hash] = {
            "filename": filename,
            "filepath": filepath,
            "chunks": len(chunks),
            "pages": max(c["page"] for c in chunks),
        }
        self._save()

    def remove_document(self, file_hash: str):
        """Remove a document and rebuild index (FAISS flat index rebuild)."""
        if file_hash not in self.files:
            return
        filename = self.files[file_hash]["filename"]
        remaining = [m for m in self.metadata if m["filename"] != filename]
        self.files.pop(file_hash)

        self.index = faiss.IndexFlatIP(self.dim)
        self.metadata = []
        if remaining:
            embedder = get_embedder()
            texts = [c["text"] for c in remaining]
            embeddings = embedder.encode(texts, normalize_embeddings=True, show_progress_bar=False)
            embeddings = np.array(embeddings, dtype="float32")
            self.index.add(embeddings)
            self.metadata = remaining
        self._save()

    def search(self, query: str, top_k: int = TOP_K) -> List[Dict]:
        if self.index.ntotal == 0:
            return []
        embedder = get_embedder()
        q_emb = embedder.encode([query], normalize_embeddings=True)
        q_emb = np.array(q_emb, dtype="float32")
        k = min(top_k, self.index.ntotal)
        scores, indices = self.index.search(q_emb, k)
        results = []
        for score, idx in zip(scores[0], indices[0]):
            if idx == -1:
                continue
            chunk = dict(self.metadata[idx])
            chunk["score"] = float(score)
            results.append(chunk)
        return results

    def get_stats(self) -> Dict:
        return {
            "total_documents": len(self.files),
            "total_chunks": len(self.metadata),
            "documents": [
                {
                    "filename": v["filename"],
                    "file_hash": k,
                    "chunks": v["chunks"],
                    "pages": v["pages"],
                }
                for k, v in self.files.items()
            ],
        }

    def clear(self):
        self.index = faiss.IndexFlatIP(self.dim)
        self.metadata = []
        self.files = {}
        self._save()


# ──────────────────────────── UTILITIES ──────────────────────────────────────

def hash_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def format_context(chunks: List[Dict]) -> str:
    parts = []
    for i, c in enumerate(chunks, 1):
        parts.append(
            f"[Source {i}: {c['filename']}, Page {c['page']}]\n{c['text']}"
        )
    return "\n\n---\n\n".join(parts)


def build_prompt(query: str, context: str, history: List[Dict]) -> List[Dict]:
    system = (
        "You are a precise document assistant. Answer questions ONLY based on the provided document context.\n"
        "Rules:\n"
        "1. Use ONLY the information from the provided context.\n"
        "2. If the answer is not in the context, respond EXACTLY: "
        "\"I couldn't find this information in the uploaded documents.\"\n"
        "3. Always cite your sources using [Source N] notation.\n"
        "4. Be concise and accurate.\n"
        "5. Do NOT hallucinate or add external knowledge."
    )
    messages = [{"role": "system", "content": system}]
    # Add last 6 turns of history for conversational memory
    for turn in history[-6:]:
        messages.append({"role": turn["role"], "content": turn["content"]})
    user_message = f"Context from documents:\n\n{context}\n\nQuestion: {query}"
    messages.append({"role": "user", "content": user_message})
    return messages
