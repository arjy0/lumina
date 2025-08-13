import { textToSpeech, groqChatCompletion } from '../modules/groq';
import { groqTextChat } from '../modules/groqVision';

export async function testGroqIntegration() {
    console.log('🧪 Testing Groq integration...');
    
    try {
        // Test 1: Chat completion with new model
        console.log('Testing Groq moonshotai/kimi-k2-instruct...');
        const chatResponse = await groqTextChat(
            "You are a helpful assistant.",
            "Say hello in a funny way!"
        );
        console.log('✅ Groq chat response:', chatResponse);
        
        // Test 2: Text-to-speech
        console.log('Testing Groq TTS...');
        await textToSpeech("Hello! This is a test of Groq text to speech with the new Kimi model.");
        console.log('✅ Groq TTS test completed');
        
        return { success: true, chatResponse };
    } catch (error) {
        console.error('❌ Groq test failed:', error);
        return { success: false, error };
    }
}
