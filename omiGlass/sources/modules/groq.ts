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

export async function textToSpeech(text: string) {
    try {
        console.log('🔊 Using Groq TTS for:', text);
        
        // Initialize AudioContext if not already done
        if (!audioContext) {
            audioContext = new AudioContext();
        }
        
        const response = await axios.post("https://api.groq.com/openai/v1/audio/speech", {
            model: "playai-tts-arabic",
            voice: "Ahmad-PlayAI",
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

        console.log('✅ Groq TTS playback started');
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
