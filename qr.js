const VERSION = 4;
const SIZE = 17 + VERSION * 4;
const DATA_CODEWORDS = 64;
const ECC_CODEWORDS_PER_BLOCK = 18;

function appendBits(target, value, length) {
  for (let bit = length - 1; bit >= 0; bit -= 1) target.push((value >>> bit) & 1);
}

function makeDataCodewords(text) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > 62) throw new Error("二维码链接过长，无法使用当前本地编码器。");
  const bits = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, bytes.length, 8);
  bytes.forEach(byte => appendBits(bits, byte, 8));
  appendBits(bits, 0, Math.min(4, DATA_CODEWORDS * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const result = [];
  for (let index = 0; index < bits.length; index += 8) {
    result.push(bits.slice(index, index + 8).reduce((value, bit) => (value << 1) | bit, 0));
  }
  for (let pad = 0; result.length < DATA_CODEWORDS; pad += 1) result.push(pad % 2 ? 0x11 : 0xec);
  return result;
}

function gfMultiply(left, right) {
  let result = 0;
  for (let value = right, factor = left; value; value >>>= 1) {
    if (value & 1) result ^= factor;
    factor <<= 1;
    if (factor & 0x100) factor ^= 0x11d;
  }
  return result;
}

function reedSolomonDivisor(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let index = 0; index < degree; index += 1) {
    for (let offset = 0; offset < result.length; offset += 1) {
      result[offset] = gfMultiply(result[offset], root);
      if (offset + 1 < result.length) result[offset] ^= result[offset + 1];
    }
    root = gfMultiply(root, 2);
  }
  return result;
}

function reedSolomonRemainder(data, divisor) {
  const result = new Uint8Array(divisor.length);
  data.forEach(byte => {
    const factor = byte ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    divisor.forEach((coefficient, index) => { result[index] ^= gfMultiply(coefficient, factor); });
  });
  return [...result];
}

function makeCodewords(text) {
  const data = makeDataCodewords(text);
  const divisor = reedSolomonDivisor(ECC_CODEWORDS_PER_BLOCK);
  const blocks = [data.slice(0, 32), data.slice(32, 64)];
  const eccBlocks = blocks.map(block => reedSolomonRemainder(block, divisor));
  const result = [];
  for (let index = 0; index < 32; index += 1) blocks.forEach(block => result.push(block[index]));
  for (let index = 0; index < ECC_CODEWORDS_PER_BLOCK; index += 1) eccBlocks.forEach(block => result.push(block[index]));
  return result;
}

function createMatrix() {
  const modules = Array.from({ length: SIZE }, () => Array(SIZE).fill(false));
  const functional = Array.from({ length: SIZE }, () => Array(SIZE).fill(false));
  const setFunction = (x, y, dark) => {
    if (x >= 0 && y >= 0 && x < SIZE && y < SIZE) {
      modules[y][x] = dark;
      functional[y][x] = true;
    }
  };
  const finder = (left, top) => {
    for (let y = -1; y <= 7; y += 1) for (let x = -1; x <= 7; x += 1) {
      const inside = x >= 0 && x <= 6 && y >= 0 && y <= 6;
      const dark = inside && (x === 0 || x === 6 || y === 0 || y === 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4));
      setFunction(left + x, top + y, dark);
    }
  };
  finder(0, 0); finder(SIZE - 7, 0); finder(0, SIZE - 7);
  for (let index = 8; index < SIZE - 8; index += 1) {
    setFunction(6, index, index % 2 === 0);
    setFunction(index, 6, index % 2 === 0);
  }
  for (let y = -2; y <= 2; y += 1) for (let x = -2; x <= 2; x += 1) {
    setFunction(26 + x, 26 + y, Math.max(Math.abs(x), Math.abs(y)) !== 1);
  }
  const formatData = 0; // Error correction M and mask 0.
  let remainder = formatData;
  for (let index = 0; index < 10; index += 1) remainder = (remainder << 1) ^ (((remainder >>> 9) & 1) * 0x537);
  const formatBits = ((formatData << 10) | remainder) ^ 0x5412;
  const formatBit = index => ((formatBits >>> index) & 1) !== 0;
  for (let index = 0; index <= 5; index += 1) setFunction(8, index, formatBit(index));
  setFunction(8, 7, formatBit(6)); setFunction(8, 8, formatBit(7)); setFunction(7, 8, formatBit(8));
  for (let index = 9; index < 15; index += 1) setFunction(14 - index, 8, formatBit(index));
  for (let index = 0; index < 8; index += 1) setFunction(SIZE - 1 - index, 8, formatBit(index));
  for (let index = 8; index < 15; index += 1) setFunction(8, SIZE - 15 + index, formatBit(index));
  setFunction(8, SIZE - 8, true);
  return { modules, functional };
}

export function qrMatrix(text) {
  const codewords = makeCodewords(text);
  const dataBits = [];
  codewords.forEach(byte => appendBits(dataBits, byte, 8));
  const { modules, functional } = createMatrix();
  let bitIndex = 0;
  let upwards = true;
  for (let right = SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < SIZE; vertical += 1) {
      const y = upwards ? SIZE - 1 - vertical : vertical;
      for (let offset = 0; offset < 2; offset += 1) {
        const x = right - offset;
        if (functional[y][x]) continue;
        const raw = bitIndex < dataBits.length ? dataBits[bitIndex] === 1 : false;
        modules[y][x] = raw !== ((x + y) % 2 === 0);
        bitIndex += 1;
      }
    }
    upwards = !upwards;
  }
  return modules;
}

export function qrSvg(text) {
  const modules = qrMatrix(text);
  const quiet = 4;
  const path = [];
  modules.forEach((row, y) => row.forEach((dark, x) => { if (dark) path.push(`M${x + quiet},${y + quiet}h1v1h-1z`); }));
  const viewSize = modules.length + quiet * 2;
  return `<svg class="notion-qr" viewBox="0 0 ${viewSize} ${viewSize}" role="img" aria-label="Notion 页面二维码" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${path.join("")}" fill="#000"/></svg>`;
}
