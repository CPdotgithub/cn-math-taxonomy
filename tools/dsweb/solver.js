#!/usr/bin/env node
/* DeepSeek PoW 求解器（DeepSeekHashV1）。
   从 deepseek-free-api 的 src/lib/challenge.ts 移植，去掉 TypeScript 依赖。

   用法：node solver.js '<{"challenge":"..","salt":"..","difficulty":144000,"expire_at":..}>'
   输出：纯数字 nonce（answer），失败则退出码 1。
*/
const fs = require('fs');
const path = require('path');

class DeepSeekHash {
  constructor() {
    this.inst = null;
    this.offset = 0;
    this.mem = null;
    this.enc = new TextEncoder();
  }

  get memory() {
    if (!this.mem || this.mem.byteLength === 0) {
      this.mem = new Uint8Array(this.inst.memory.buffer);
    }
    return this.mem;
  }

  encodeString(text, reallocate) {
    const enc = new TextEncoder().encode(text);
    const n = text.length;
    let ptr = this.inst.__wbindgen_export_0(n, 1) >>> 0;
    const mem = this.memory;

    let ascii = 0;
    for (; ascii < n; ascii++) {
      const c = text.charCodeAt(ascii);
      if (c > 127) break;
      mem[ptr + ascii] = c;
    }
    if (ascii !== n) {
      let rest = ascii > 0 ? text.slice(ascii) : text;
      ptr = reallocate(ptr, n, ascii + rest.length * 3, 1) >>> 0;
      const r = this.enc.encodeInto(
        rest,
        this.memory.subarray(ptr + ascii, ptr + ascii + rest.length * 3)
      );
      ascii += r.written;
      ptr = reallocate(ptr, ascii + rest.length * 3, ascii, 1) >>> 0;
    } else {
      // 纯 ASCII：上面 allocate 已按字符数分配，编码长度相同，无需 realloc
      void enc;
    }
    this.offset = ascii;
    return ptr;
  }

  solve(algorithm, challenge, salt, difficulty, expireAt) {
    if (algorithm !== 'DeepSeekHashV1') {
      throw new Error('Unsupported algorithm: ' + algorithm);
    }
    const prefix = `${salt}_${expireAt}_`;
    const retptr = this.inst.__wbindgen_add_to_stack_pointer(-16);
    try {
      const p0 = this.encodeString(challenge, this.inst.__wbindgen_export_1);
      const l0 = this.offset;
      const p1 = this.encodeString(prefix, this.inst.__wbindgen_export_1);
      const l1 = this.offset;
      this.inst.wasm_solve(retptr, p0, l0, p1, l1, difficulty);
      const dv = new DataView(this.inst.memory.buffer);
      const status = dv.getInt32(retptr + 0, true);
      const value = dv.getFloat64(retptr + 8, true);
      if (status === 0) return null;
      return Math.round(value);
    } finally {
      this.inst.__wbindgen_add_to_stack_pointer(16);
    }
  }

  init(wasmPath) {
    const buf = fs.readFileSync(wasmPath);
    const mod = new WebAssembly.Module(buf);
    const inst = new WebAssembly.Instance(mod, { wbg: {} });
    this.inst = inst.exports;
    this.mem = null;
  }
}

function main() {
  const raw = process.argv[2];
  if (!raw) {
    console.error('usage: node solver.js \'{"challenge":..,"salt":..,"difficulty":..,"expire_at":..}\'');
    process.exit(2);
  }
  const ch = JSON.parse(raw);
  // 依次找可用的 wasm
  const cands = [
    process.env.POW_WASM,
    path.join(__dirname, 'sha3_wasm_bg.wasm'),
    path.join(__dirname, 'sha3_wasm_bg.7b9ca65ddd.wasm'),
  ].filter(Boolean);
  const wasmPath = cands.find(function (p) { return fs.existsSync(p); });
  if (!wasmPath) {
    console.error('wasm not found, tried: ' + cands.join(', '));
    process.exit(3);
  }

  const h = new DeepSeekHash();
  h.init(wasmPath);
  const t0 = Date.now();
  const ans = h.solve(ch.algorithm || 'DeepSeekHashV1', ch.challenge, ch.salt,
    Number(ch.difficulty), Number(ch.expire_at));
  if (ans === null || ans === undefined) {
    console.error('solve failed');
    process.exit(1);
  }
  console.error(`[pow] answer=${ans} in ${Date.now() - t0}ms`);
  process.stdout.write(String(ans));
}

main();
