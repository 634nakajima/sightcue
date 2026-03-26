#!/usr/bin/env python3
"""SightCue - Python Backend"""

import sys

from app.config import load_config
from app.models import VisionModels
from app.trigger_manager import TriggerManager
from app.osc_sender import OSCSender
from app.pipeline import VisionPipeline
from app.server import create_app


def main():
    print("=" * 50)
    print("  SightCue - Backend")
    print("=" * 50)

    config = load_config("config.yaml")

    print("[Init] Initializing models (lazy load on first inference)...")
    models = VisionModels(config)

    trigger_manager = TriggerManager(config, models)
    osc_sender = OSCSender(config)
    pipeline = VisionPipeline(config, models, trigger_manager, osc_sender)

    app, socketio = create_app(config, pipeline, trigger_manager, osc_sender)
    pipeline.set_socketio(socketio)
    osc_sender.set_socketio(socketio)

    host = "127.0.0.1"
    port = config["server"]["port"]
    print(f"[Server] Starting on http://localhost:{port}")
    print(f"[OSC] Sending to {config['osc']['host']}:{config['osc']['port']}")
    print("READY")  # Signal to Electron that server is up
    sys.stdout.flush()

    socketio.run(app, host=host, port=port, allow_unsafe_werkzeug=True)


if __name__ == "__main__":
    main()
