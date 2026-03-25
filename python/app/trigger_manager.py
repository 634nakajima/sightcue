import json
import os
import time
import uuid

import numpy as np


class TriggerManager:
    def __init__(self, config, models=None):
        self.default_threshold = config["triggers"]["default_threshold"]
        self.default_cooldown = config["triggers"].get("cooldown", 5.0)
        self.persistence_file = config["triggers"]["persistence_file"]
        self.models = models
        self._triggers = {}
        self._load()

    def set_models(self, models):
        self.models = models
        for t in self._triggers.values():
            if t["embedding"] is None and self.models:
                t["embedding"] = self.models.compute_embedding(t["description"], is_query=True).tolist()
        self._save()

    def _next_index(self):
        existing = [t.get("index", 0) for t in self._triggers.values()]
        return max(existing, default=0) + 1

    def add_trigger(self, description, threshold=None):
        tid = str(uuid.uuid4())[:8]
        embedding = None
        if self.models:
            embedding = self.models.compute_embedding(description).tolist()
        trigger = {
            "id": tid,
            "index": self._next_index(),
            "description": description,
            "threshold": threshold if threshold is not None else self.default_threshold,
            "enabled": True,
            "embedding": embedding,
            "cooldown": self.default_cooldown,
            "last_fired": None,
        }
        self._triggers[tid] = trigger
        self._save()
        return trigger

    def remove_trigger(self, tid):
        if tid in self._triggers:
            del self._triggers[tid]
            self._reindex()
            self._save()
            return True
        return False

    def _reindex(self):
        for i, t in enumerate(self._triggers.values(), 1):
            t["index"] = i

    def update_trigger(self, tid, **kwargs):
        if tid not in self._triggers:
            return None
        t = self._triggers[tid]
        if "description" in kwargs:
            t["description"] = kwargs["description"]
            if self.models:
                t["embedding"] = self.models.compute_embedding(kwargs["description"]).tolist()
        if "threshold" in kwargs:
            t["threshold"] = float(kwargs["threshold"])
        if "enabled" in kwargs:
            t["enabled"] = bool(kwargs["enabled"])
        if "cooldown" in kwargs:
            t["cooldown"] = float(kwargs["cooldown"])
        self._save()
        return t

    def get_all_triggers(self):
        return list(self._triggers.values())

    def check_triggers(self, caption_embedding):
        now = time.time()
        matches = []
        similarities = []
        for t in self._triggers.values():
            if not t["enabled"] or t["embedding"] is None:
                continue
            trigger_emb = np.array(t["embedding"], dtype=np.float32)
            similarity = float(np.dot(caption_embedding, trigger_emb))
            similarities.append({
                "trigger_id": t["id"],
                "description": t["description"],
                "similarity": round(similarity, 4),
                "threshold": t["threshold"],
                "fired": False,
            })
            if similarity >= t["threshold"]:
                if t["last_fired"] and (now - t["last_fired"]) < t["cooldown"]:
                    similarities[-1]["cooldown"] = True
                    continue
                t["last_fired"] = now
                similarities[-1]["fired"] = True
                matches.append({
                    "trigger_id": t["id"],
                    "trigger_index": t.get("index", 0),
                    "description": t["description"],
                    "similarity": round(similarity, 4),
                    "threshold": t["threshold"],
                })
        return matches, similarities

    def _save(self):
        os.makedirs(os.path.dirname(self.persistence_file) or ".", exist_ok=True)
        data = []
        for t in self._triggers.values():
            data.append({
                "id": t["id"],
                "index": t.get("index", 0),
                "description": t["description"],
                "threshold": t["threshold"],
                "enabled": t["enabled"],
                "cooldown": t["cooldown"],
                "embedding": t["embedding"],
            })
        with open(self.persistence_file, "w") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)

    def _load(self):
        if not os.path.exists(self.persistence_file):
            return
        with open(self.persistence_file) as f:
            data = json.load(f)
        for i, item in enumerate(data):
            self._triggers[item["id"]] = {
                "id": item["id"],
                "index": item.get("index") or (i + 1),
                "description": item["description"],
                "threshold": item.get("threshold", self.default_threshold),
                "enabled": item.get("enabled", True),
                "embedding": item.get("embedding"),
                "cooldown": item.get("cooldown", self.default_cooldown),
                "last_fired": None,
            }
        # Fix duplicate or zero indices
        indices = [t["index"] for t in self._triggers.values()]
        if len(indices) != len(set(indices)) or 0 in indices:
            for i, t in enumerate(self._triggers.values(), 1):
                t["index"] = i
            self._save()
