import threading

from flask import Flask
from flask_socketio import SocketIO


def create_app(config, pipeline, trigger_manager, osc_sender):
    app = Flask(__name__)
    app.config["SECRET_KEY"] = "vision-trigger-dev"
    socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

    # --- Frame reception from Electron ---
    @socketio.on("frame:full")
    def handle_frame_full(data):
        image_b64 = data.get("image_b64")
        if image_b64:
            threading.Thread(
                target=pipeline.process_full_frame, args=(image_b64,), daemon=True
            ).start()

    @socketio.on("frame:rois")
    def handle_frame_rois(data):
        roi_frames = data.get("rois", [])
        if roi_frames:
            threading.Thread(
                target=pipeline.process_roi_frames, args=(roi_frames,), daemon=True
            ).start()

    # --- Trigger management ---
    @socketio.on("trigger:add")
    def handle_trigger_add(data):
        desc = data.get("description", "").strip()
        threshold = data.get("threshold")
        if not desc:
            return
        if threshold is not None:
            threshold = float(threshold)
        trigger = trigger_manager.add_trigger(desc, threshold)
        trigger_safe = {k: v for k, v in trigger.items() if k != "embedding"}
        socketio.emit("trigger:added", trigger_safe)

    @socketio.on("trigger:remove")
    def handle_trigger_remove(data):
        tid = data.get("id")
        if tid and trigger_manager.remove_trigger(tid):
            # Send full list with reindexed triggers
            triggers = trigger_manager.get_all_triggers()
            safe = [{k: v for k, v in t.items() if k != "embedding"} for t in triggers]
            socketio.emit("trigger:list", safe)

    @socketio.on("trigger:update")
    def handle_trigger_update(data):
        tid = data.get("id")
        if not tid:
            return
        kwargs = {}
        if "threshold" in data:
            kwargs["threshold"] = data["threshold"]
        if "enabled" in data:
            kwargs["enabled"] = data["enabled"]
        trigger_manager.update_trigger(tid, **kwargs)

    @socketio.on("trigger:list")
    def handle_trigger_list():
        triggers = trigger_manager.get_all_triggers()
        safe = [{k: v for k, v in t.items() if k != "embedding"} for t in triggers]
        socketio.emit("trigger:list", safe)

    @socketio.on("pipeline:start")
    def handle_pipeline_start():
        pipeline.start()
        socketio.emit("status:update", pipeline.get_status())

    @socketio.on("pipeline:stop")
    def handle_pipeline_stop():
        pipeline.stop()
        socketio.emit("status:update", pipeline.get_status())

    @socketio.on("status:request")
    def handle_status_request():
        socketio.emit("status:update", pipeline.get_status())

    @socketio.on("config:update")
    def handle_config_update(data):
        if "osc_host" in data or "osc_port" in data:
            host = data.get("osc_host", osc_sender.host)
            port = int(data.get("osc_port", osc_sender.port))
            osc_sender.update_target(host, port)
        socketio.emit("status:update", pipeline.get_status())

    @socketio.on("connect")
    def handle_connect():
        triggers = trigger_manager.get_all_triggers()
        safe = [{k: v for k, v in t.items() if k != "embedding"} for t in triggers]
        socketio.emit("trigger:list", safe)
        socketio.emit("status:update", pipeline.get_status())

    return app, socketio
