import torch
import numpy as np
from PIL import Image


def _get_device():
    if torch.backends.mps.is_available():
        return torch.device("mps")
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


class VisionModels:
    def __init__(self, config):
        self.device = _get_device()
        self.blip_model_name = config["pipeline"]["blip_model"]
        self.embedding_model_name = config["pipeline"]["embedding_model"]
        self._blip_processor = None
        self._blip_model = None
        self._embedding_model = None
        print(f"[Models] Using device: {self.device}")

    def _load_blip(self):
        if self._blip_model is not None:
            return
        print(f"[Models] Loading BLIP: {self.blip_model_name} ...")
        from transformers import BlipProcessor, BlipForConditionalGeneration

        self._blip_processor = BlipProcessor.from_pretrained(self.blip_model_name)
        self._blip_model = BlipForConditionalGeneration.from_pretrained(
            self.blip_model_name
        ).to(self.device)
        self._blip_model.eval()
        print("[Models] BLIP loaded.")

    def _load_embedding(self):
        if self._embedding_model is not None:
            return
        print(f"[Models] Loading embedding: {self.embedding_model_name} ...")
        from sentence_transformers import SentenceTransformer

        self._embedding_model = SentenceTransformer(
            self.embedding_model_name, device=str(self.device)
        )
        print("[Models] Embedding model loaded.")

    def generate_caption(self, pil_image: Image.Image) -> str:
        self._load_blip()
        inputs = self._blip_processor(pil_image, return_tensors="pt").to(self.device)
        with torch.no_grad():
            output = self._blip_model.generate(**inputs, max_new_tokens=50)
        caption = self._blip_processor.decode(output[0], skip_special_tokens=True)
        return caption

    def compute_embedding(self, text: str, is_query: bool = False) -> np.ndarray:
        self._load_embedding()
        # e5 models require "query: " or "passage: " prefix
        if "e5" in self.embedding_model_name.lower():
            prefix = "query: " if is_query else "passage: "
            text = prefix + text
        embedding = self._embedding_model.encode(
            text, normalize_embeddings=True, show_progress_bar=False
        )
        return np.array(embedding, dtype=np.float32)

    @property
    def device_name(self) -> str:
        return str(self.device).upper()

    @property
    def is_loaded(self) -> bool:
        return self._blip_model is not None and self._embedding_model is not None
