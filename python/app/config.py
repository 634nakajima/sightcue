import os
import yaml

DEFAULT_CONFIG = {
    "camera": {"device": 0, "width": 640, "height": 480},
    "pipeline": {
        "capture_interval": 2.0,
        "blip_model": "Salesforce/blip-image-captioning-large",
        "embedding_model": "all-MiniLM-L6-v2",
    },
    "triggers": {
        "default_threshold": 0.45,
        "cooldown": 5.0,
        "persistence_file": "data/triggers.json",
    },
    "osc": {"host": "127.0.0.1", "port": 8000, "address_prefix": "/blip"},
    "server": {"host": "0.0.0.0", "port": 5555},
}


def _deep_merge(base, override):
    result = base.copy()
    for k, v in override.items():
        if k in result and isinstance(result[k], dict) and isinstance(v, dict):
            result[k] = _deep_merge(result[k], v)
        else:
            result[k] = v
    return result


def load_config(path="config.yaml"):
    config = DEFAULT_CONFIG.copy()
    abs_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), path)
    if os.path.exists(abs_path):
        with open(abs_path) as f:
            user_config = yaml.safe_load(f) or {}
        config = _deep_merge(config, user_config)
    return config
