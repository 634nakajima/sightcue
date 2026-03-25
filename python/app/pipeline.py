import base64
import io
import threading
import time

from PIL import Image


class VisionPipeline:
    def __init__(self, config, models, trigger_manager, osc_sender):
        self.config = config
        self.models = models
        self.trigger_manager = trigger_manager
        self.osc_sender = osc_sender
        self.socketio = None

        self._running = False
        self._processing = False
        self._latest_caption = ""
        self._inference_duration = 0

    def set_socketio(self, sio):
        self.socketio = sio

    def start(self):
        if self._running:
            return
        self._running = True
        # Pre-load models in background thread
        def _preload():
            if self.socketio:
                self.socketio.emit("loading:update", {"message": "Loading AI models... This may take a few minutes on first run."})
            self.models._load_blip()
            self.models._load_embedding()
            self.trigger_manager.set_models(self.models)
            if self.socketio:
                self.socketio.emit("status:update", self.get_status())
            print("[Pipeline] Models loaded, ready for frames.")
        threading.Thread(target=_preload, daemon=True).start()
        print("[Pipeline] Started.")

    def stop(self):
        self._running = False
        print("[Pipeline] Stopped.")

    @property
    def running(self):
        return self._running

    def get_status(self):
        return {
            "running": self._running,
            "device": self.models.device_name,
            "models_loaded": self.models.is_loaded,
            "capture_interval": self.config["pipeline"].get("capture_interval", 0.5),
            "inference_duration": round(self._inference_duration, 2),
            "latest_caption": self._latest_caption,
        }

    def process_full_frame(self, image_b64):
        """Process a single full-frame image (no ROIs)."""
        if not self._running or self._processing or not self.models.is_loaded:
            return
        self._processing = True
        try:
            pil_img = self._decode_image(image_b64)
            t0 = time.time()
            caption = self.models.generate_caption(pil_img)
            embedding = self.models.compute_embedding(caption)
            self._inference_duration = time.time() - t0
            self._latest_caption = caption
            timestamp = time.strftime("%H:%M:%S")

            self.osc_sender.send_caption(caption)

            if self.socketio:
                self.socketio.emit("caption:update", {
                    "text": caption,
                    "timestamp": timestamp,
                    "inference_time": round(self._inference_duration, 2),
                })

            matches, similarities = self.trigger_manager.check_triggers(embedding)

            if self.socketio:
                self.socketio.emit("similarities:update", similarities)

            for match in matches:
                match["timestamp"] = timestamp
                self.osc_sender.send_trigger(match)
                if self.socketio:
                    self.socketio.emit("trigger:fired", match)
                print(f"[Trigger] FIRED: {match['description']} (sim={match['similarity']})")
        finally:
            self._processing = False

    def process_roi_frames(self, roi_frames):
        """Process multiple ROI-cropped images."""
        if not self._running or self._processing or not self.models.is_loaded:
            return
        self._processing = True
        try:
            t0 = time.time()
            all_similarities = []

            for frame in roi_frames:
                roi_id = frame["roi_id"]
                roi_name = frame["roi_name"]
                pil_img = self._decode_image(frame["image_b64"])

                caption = self.models.generate_caption(pil_img)
                embedding = self.models.compute_embedding(caption)
                timestamp = time.strftime("%H:%M:%S")

                self.osc_sender.send_caption(caption, roi_name=roi_name)

                if self.socketio:
                    self.socketio.emit("roi:caption", {
                        "roi_id": roi_id,
                        "roi_name": roi_name,
                        "caption": caption,
                        "timestamp": timestamp,
                    })

                matches, similarities = self.trigger_manager.check_triggers(embedding)

                for s in similarities:
                    s["roi_id"] = roi_id
                    s["roi_name"] = roi_name
                all_similarities.extend(similarities)

                for match in matches:
                    match["timestamp"] = timestamp
                    match["roi_id"] = roi_id
                    match["roi_name"] = roi_name
                    self.osc_sender.send_trigger(match, roi_name=roi_name)
                    if self.socketio:
                        self.socketio.emit("trigger:fired", match)
                    print(f"[Trigger] FIRED ({roi_name}): {match['description']} (sim={match['similarity']})")

            self._inference_duration = time.time() - t0

            if self.socketio:
                self.socketio.emit("similarities:update", all_similarities)
                self.socketio.emit("status:update", self.get_status())

        finally:
            self._processing = False

    def _decode_image(self, b64_str):
        img_data = base64.b64decode(b64_str)
        return Image.open(io.BytesIO(img_data)).convert("RGB")
