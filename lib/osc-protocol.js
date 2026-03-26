// OSC 1.0 protocol encoder/decoder (ported from mediapipe-osc)
// Supports float (f), int (i), and string (s) types

function padString(s) {
  const buf = Buffer.from(s + '\0');
  const padLen = 4 - (buf.length % 4);
  return padLen < 4 ? Buffer.concat([buf, Buffer.alloc(padLen)]) : buf;
}

/**
 * Encode an OSC message with multiple typed arguments.
 * @param {string} address - OSC address (e.g. "/hand/left/wrist/x")
 * @param {Array<{type: string, value: any}>} args - Array of {type, value}
 *   type 'f' = float, 'i' = int32, 's' = string
 * @returns {Buffer}
 */
function encodeOSCMessage(address, args) {
  const addressBuf = padString(address);
  const typeTag = ',' + args.map(a => a.type).join('');
  const typeBuf = padString(typeTag);

  const dataBufs = [];
  for (const arg of args) {
    if (arg.type === 'f') {
      const buf = Buffer.alloc(4);
      buf.writeFloatBE(arg.value, 0);
      dataBufs.push(buf);
    } else if (arg.type === 'i') {
      const buf = Buffer.alloc(4);
      buf.writeInt32BE(arg.value, 0);
      dataBufs.push(buf);
    } else if (arg.type === 's') {
      dataBufs.push(padString(String(arg.value)));
    }
  }

  return Buffer.concat([addressBuf, typeBuf, ...dataBufs]);
}

/**
 * Shorthand: encode a single float message.
 */
function encodeFloat(address, value) {
  return encodeOSCMessage(address, [{ type: 'f', value }]);
}

/**
 * Decode an OSC message buffer.
 */
function decodeOSCMessage(buf) {
  try {
    let i = 0;
    const nullIdx = buf.indexOf(0, i);
    if (nullIdx < 0) return null;
    const address = buf.toString('ascii', i, nullIdx);
    i = nullIdx + 1;
    i = Math.ceil(i / 4) * 4;

    if (i >= buf.length || buf[i] !== 0x2c) return null;
    const typeNullIdx = buf.indexOf(0, i);
    if (typeNullIdx < 0) return null;
    const typeTag = buf.toString('ascii', i + 1, typeNullIdx);
    i = typeNullIdx + 1;
    i = Math.ceil(i / 4) * 4;

    const args = [];
    for (const t of typeTag) {
      if (t === 'f' && i + 4 <= buf.length) {
        args.push({ type: 'f', value: buf.readFloatBE(i) });
        i += 4;
      } else if (t === 'i' && i + 4 <= buf.length) {
        args.push({ type: 'i', value: buf.readInt32BE(i) });
        i += 4;
      } else if (t === 's') {
        const sNull = buf.indexOf(0, i);
        if (sNull < 0) break;
        args.push({ type: 's', value: buf.toString('ascii', i, sNull) });
        i = sNull + 1;
        i = Math.ceil(i / 4) * 4;
      }
    }

    return { address, args };
  } catch {
    return null;
  }
}

module.exports = { encodeOSCMessage, encodeFloat, decodeOSCMessage };
