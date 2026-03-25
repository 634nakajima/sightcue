from pythonosc import udp_client


class OSCSender:
    def __init__(self, config):
        self.host = config["osc"]["host"]
        self.port = config["osc"]["port"]
        self.prefix = config["osc"]["address_prefix"]
        self._client = udp_client.SimpleUDPClient(self.host, self.port)
        self.socketio = None
        print(f"[OSC] Sending to {self.host}:{self.port}")

    def set_socketio(self, sio):
        self.socketio = sio

    def send_trigger(self, match, roi_name=None):
        idx = match.get("trigger_index", 0)
        if roi_name:
            addr = f"{self.prefix}/roi/{roi_name}/trigger{idx}"
        else:
            addr = f"{self.prefix}/trigger{idx}"
        val = match["similarity"]
        self._client.send_message(addr, [val])
        self._emit_monitor(addr, [val], is_trigger=True)

    def send_caption(self, caption, roi_name=None):
        if roi_name:
            addr = f"{self.prefix}/roi/{roi_name}/caption"
        else:
            addr = f"{self.prefix}/caption"
        self._client.send_message(addr, [caption])
        self._emit_monitor(addr, [caption])

    def update_target(self, host, port):
        self.host = host
        self.port = port
        self._client = udp_client.SimpleUDPClient(host, port)

    def _emit_monitor(self, addr, args, is_trigger=False):
        if self.socketio:
            self.socketio.emit("osc:sent", {
                "address": addr,
                "args": [str(a) for a in args],
                "is_trigger": is_trigger,
            })
