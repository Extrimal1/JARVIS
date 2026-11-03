// Generates tests/fixtures/sample.wav: 0.25 s 440 Hz sine, 8 kHz 16-bit mono PCM.
import { writeFileSync } from "node:fs";

const sampleRate = 8000;
const samples = 2000;
const data = Buffer.alloc(samples * 2);

for (let i = 0; i < samples; i++) {
  const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12000);
  data.writeInt16LE(v, i * 2);
}

const header = Buffer.alloc(44);
header.write("RIFF", 0);
header.writeUInt32LE(36 + data.length, 4);
header.write("WAVEfmt ", 8);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(sampleRate, 24);
header.writeUInt32LE(sampleRate * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write("data", 36);
header.writeUInt32LE(data.length, 40);

const out = Buffer.concat([header, data]);
writeFileSync(new URL("./sample.wav", import.meta.url), out);
console.log(`wrote ${out.length} bytes`);
