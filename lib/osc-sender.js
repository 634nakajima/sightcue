// Node.js UDP OSC sender (ported from mediapipe-osc)

const dgram = require('node:dgram');
const { encodeOSCMessage, encodeFloat } = require('./osc-protocol');

const state = {
  socket: null,
  destHost: '127.0.0.1',
  destPort: 9000,
  enabled: true,
  messageCount: 0,
};

function init() {
  if (state.socket) return;
  state.socket = dgram.createSocket('udp4');
  state.socket.on('error', () => {});
}

function send(address, args) {
  if (!state.socket || !state.enabled) return;
  const buf = encodeOSCMessage(address, args);
  state.socket.send(buf, state.destPort, state.destHost);
  state.messageCount++;
}

function sendFloat(address, value) {
  if (!state.socket || !state.enabled) return;
  const buf = encodeFloat(address, value);
  state.socket.send(buf, state.destPort, state.destHost);
  state.messageCount++;
}

function sendLandmarks(type, side, landmarks) {
  for (const lm of landmarks) {
    const prefix = type === 'hand' ? `/hand/${side}/${lm.name}` : `/face/${lm.name}`;
    sendFloat(`${prefix}/x`, lm.x);
    sendFloat(`${prefix}/y`, lm.y);
    sendFloat(`${prefix}/z`, lm.z);
  }
}

function setConfig(host, port) {
  state.destHost = host;
  state.destPort = port;
}

function setEnabled(enabled) {
  state.enabled = enabled;
}

function getStatus() {
  return {
    destHost: state.destHost,
    destPort: state.destPort,
    enabled: state.enabled,
    messageCount: state.messageCount,
  };
}

function close() {
  if (state.socket) {
    state.socket.close();
    state.socket = null;
  }
}

module.exports = { init, send, sendFloat, sendLandmarks, setConfig, setEnabled, getStatus, close };
