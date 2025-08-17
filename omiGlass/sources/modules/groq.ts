import axios from "axios";
import { keys } from "../keys";

const headers = {
    'Authorization': `Bearer ${keys.groq}`,
    'Content-Type': 'application/json'
};

let audioContext: AudioContext;

export async function startAudio() {
    audioContext = new AudioContext();
}

// Desktop TTS enabled for local audio playback
export async function textToSpeech(text: string) {
    try {
        console.log('🔊 Using Groq TTS for desktop playback:', text);
        
        // Initialize AudioContext if not already done
        if (!audioContext) {
            audioContext = new AudioContext();
        }
        
        const response = await axios.post("https://api.groq.com/openai/v1/audio/speech", {
            model: "playai-tts",
            // model: "playai-tts-arabic",
            voice: "Aaliyah-PlayAI",
            // voice: "Ahmad-PlayAI",
            response_format: "wav",
            input: text,
        }, {
            headers,
            responseType: 'arraybuffer'
        });

        // Decode the audio data asynchronously
        const audioBuffer = await audioContext.decodeAudioData(response.data);

        // Create an audio source
        const source = audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioContext.destination);
        source.start();  // Play the audio immediately

        console.log('✅ Groq TTS playback started on desktop speakers');
        return response.data;
    } catch (error) {
        console.error("Error in Groq textToSpeech:", error);
        return null;
    }
}

export async function transcribeAudio(audioBlob: Blob) {
    try {
        console.log('🎙️ Using Groq for audio transcription');
        
        const formData = new FormData();
        formData.append('file', audioBlob, 'audio.wav');
        formData.append('model', 'whisper-large-v3');
        formData.append('response_format', 'text');
        
        const response = await axios.post("https://api.groq.com/openai/v1/audio/transcriptions", formData, {
            headers: {
                'Authorization': `Bearer ${keys.groq}`,
                'Content-Type': 'multipart/form-data'
            },
        });
        
        console.log('✅ Groq transcription completed:', response.data);
        return response.data.text || response.data;
    } catch (error) {
        console.error("Error in Groq transcribeAudio:", error);
        return null;
    }
}

// Chat completion using Groq 
export async function groqChatCompletion(systemPrompt: string, userPrompt: string) {
    try {
        console.log("🧠 Using Groq chat completion");
        
        const response = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
            model: "llama3-70b-8192",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt },
            ],
        }, { headers });
        
        return response.data.choices[0].message.content;
    } catch (error) {
        console.error("Error in Groq chat completion:", error);
        return null;
    }
}

export function pcm16ToWavBlob(pcmData: Int16Array, sampleRate: number): Blob {
    const numChannels = 1;
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = pcmData.length * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    let offset = 0;
    const writeString = (s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)); offset += s.length; };

    writeString('RIFF');
    view.setUint32(offset, 36 + dataSize, true); offset += 4;
    writeString('WAVE');
    writeString('fmt ');
    view.setUint32(offset, 16, true); offset += 4;          // Subchunk1Size (16 for PCM)
    view.setUint16(offset, 1, true); offset += 2;           // AudioFormat (1=PCM)
    view.setUint16(offset, numChannels, true); offset += 2; // NumChannels
    view.setUint32(offset, sampleRate, true); offset += 4;  // SampleRate
    view.setUint32(offset, byteRate, true); offset += 4;    // ByteRate
    view.setUint16(offset, blockAlign, true); offset += 2;  // BlockAlign
    view.setUint16(offset, bytesPerSample * 8, true); offset += 2; // BitsPerSample
    writeString('data');
    view.setUint32(offset, dataSize, true); offset += 4;    // Subchunk2Size

    // PCM samples
    const out = new Int16Array(buffer, 44);
    out.set(pcmData);

    return new Blob([buffer], { type: 'audio/wav' });
}

export async function transcribePcm16(pcmData: Int16Array, sampleRate: number = 16000) {
    const wavBlob = pcm16ToWavBlob(pcmData, sampleRate);
    return transcribeAudio(wavBlob);
}
