import { transcribeAudio } from '../modules/groq';

// Simple browser mic capture (Web Audio + MediaRecorder) to test Groq STT
export async function testGroqStt() {
  console.log('🧪 Testing Groq STT...');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    console.error('❌ getUserMedia not supported');
    return { success: false, error: 'getUserMedia unsupported' };
  }
  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks: BlobPart[] = [];
    const rec = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise<void>(resolve => rec.onstop = () => resolve());
    rec.start();
    console.log('🎙️ Recording 2s sample...');
    await new Promise(r => setTimeout(r, 2000));
    rec.stop();
    await stopped;
    const blob = new Blob(chunks, { type: 'audio/webm' });
    console.log('📦 Recorded blob size:', blob.size);

    // Convert to wav via OfflineAudioContext for consistent sample rate (16k)
    const arrayBuf = await blob.arrayBuffer();
    const audioCtx = new AudioContext();
    const decoded = await audioCtx.decodeAudioData(arrayBuf.slice(0));
    const targetRate = 16000;
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * targetRate), targetRate);
    const src = offline.createBufferSource();
    // Mixdown to mono
    const mono = offline.createBuffer(1, decoded.length, decoded.sampleRate);
    const tmp = decoded.getChannelData(0);
    mono.copyToChannel(tmp, 0);
    src.buffer = mono;
    src.connect(offline.destination);
    src.start();
    const rendered = await offline.startRendering();
    const pcm = rendered.getChannelData(0);
    // Convert float -1..1 to 16-bit PCM
    const pcm16 = new Int16Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
      let s = Math.max(-1, Math.min(1, pcm[i]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    // Build WAV header
    const wavBytes = 44 + pcm16.length * 2;
    const buffer = new ArrayBuffer(wavBytes);
    const view = new DataView(buffer);
    let offset = 0;
    const writeStr = (s: string) => { for (let i=0;i<s.length;i++) view.setUint8(offset++, s.charCodeAt(i)); };
    const numChannels = 1; const bytesPerSample = 2; const blockAlign = numChannels * bytesPerSample; const byteRate = targetRate * blockAlign;
    writeStr('RIFF'); view.setUint32(offset, wavBytes - 8, true); offset += 4; writeStr('WAVE'); writeStr('fmt ');
    view.setUint32(offset, 16, true); offset += 4; view.setUint16(offset, 1, true); offset += 2; view.setUint16(offset, numChannels, true); offset += 2;
    view.setUint32(offset, targetRate, true); offset += 4; view.setUint32(offset, byteRate, true); offset += 4; view.setUint16(offset, blockAlign, true); offset += 2;
    view.setUint16(offset, bytesPerSample * 8, true); offset += 2; writeStr('data'); view.setUint32(offset, pcm16.length * 2, true); offset += 4;
    const out = new Int16Array(buffer, 44); out.set(pcm16);
    const wavBlob = new Blob([buffer], { type: 'audio/wav' });
    console.log('🎵 WAV blob size:', wavBlob.size);

    const text = await transcribeAudio(wavBlob as any);
    console.log('✅ STT Result:', text);
    return { success: true, text };
  } catch (err) {
    console.error('❌ STT test failed:', err);
    return { success: false, error: err };
  } finally {
    stream?.getTracks().forEach(t => t.stop());
  }
}
