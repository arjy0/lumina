import axios from "axios";
import { keys } from "../keys";

const headers = {
    'Authorization': `Bearer ${keys.groq}`,
    'Content-Type': 'application/json'
};

// Direct vision + chat with Groq's vision model
export async function groqVisionChat(question: string, images: Uint8Array[]): Promise<string> {
    try {
        console.log("🧠 Using Groq Llama 4 Scout for direct image analysis");
        
        // Convert images to base64 with proper image type detection
        const imageMessages = images.map((imageData, index) => {
            try {
                console.log(`🔍 Processing image ${index}: ${imageData.length} bytes`);
                
                // Validate JPEG signature
                const isValidJPEG = imageData[0] === 0xFF && imageData[1] === 0xD8;
                const isValidPNG = imageData[0] === 0x89 && imageData[1] === 0x50 && imageData[2] === 0x4E && imageData[3] === 0x47;
                const isValidWebP = imageData.length > 12 && 
                    imageData[8] === 0x57 && imageData[9] === 0x45 && imageData[10] === 0x42 && imageData[11] === 0x50;
                
                console.log(`🔍 Image ${index} signature check:`, {
                    'first8bytes': Array.from(imageData.slice(0, 8)).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' '),
                    'last8bytes': Array.from(imageData.slice(-8)).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' '),
                    isValidJPEG,
                    isValidPNG,
                    isValidWebP
                });
                
                if (!isValidJPEG && !isValidPNG && !isValidWebP) {
                    console.error(`❌ Image ${index} has invalid signature - but sending anyway for debugging`);
                }
                
                // Check if JPEG is complete (should end with FF D9)
                if (isValidJPEG) {
                    const hasJPEGEndMarker = imageData.length > 2 && 
                        imageData[imageData.length - 2] === 0xFF && 
                        imageData[imageData.length - 1] === 0xD9;
                    
                    console.log(`🔍 Image ${index} JPEG completeness:`, { hasJPEGEndMarker });
                    
                    if (!hasJPEGEndMarker) {
                        console.warn(`⚠️ Image ${index} JPEG incomplete - missing FF D9 end marker`);
                    }
                }
                
                // Use proper base64 encoding for binary data
                let binaryString = '';
                for (let i = 0; i < imageData.length; i++) {
                    binaryString += String.fromCharCode(imageData[i]);
                }
                const base64 = btoa(binaryString);
                
                // Detect image type from signature
                let mimeType = 'image/jpeg'; // default
                if (isValidPNG) mimeType = 'image/png';
                else if (isValidWebP) mimeType = 'image/webp';
                
                console.log(`🖼️ Image ${index} encoded:`, {
                    mimeType,
                    originalSize: imageData.length,
                    base64Size: base64.length,
                    base64Preview: base64.substring(0, 50) + '...'
                });
                
                return {
                    type: "image_url",
                    image_url: {
                        url: `data:${mimeType};base64,${base64}`
                    }
                };
            } catch (error) {
                console.error(`❌ Error encoding image ${index}:`, error);
                return null;
            }
        }).filter(img => img !== null);
        
        if (imageMessages.length === 0) {
            console.log("❌ No valid images to process - sending anyway for debugging");
            console.log("💡 Will proceed with text-only fallback");
            return await groqTextChat(
                "You are a helpful AI assistant for smart glasses. The user is asking about their surroundings, but the image received appears to be corrupted or invalid. The image signature looked correct but the data may be incomplete.",
                question
            );
        }

        const response = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
            model: "meta-llama/llama-4-scout-17b-16e-instruct", // Use Scout model as recommended
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: question
                        },
                        ...imageMessages
                    ]
                }
            ],
            temperature: 0.7,
            max_completion_tokens: 1024,
            top_p: 1,
            stream: false
        }, { headers });
        
        console.log("🔍 Groq Vision API Response:", {
            status: response.status,
            choices: response.data.choices,
            choicesLength: response.data.choices?.length,
            firstChoice: response.data.choices?.[0],
            message: response.data.choices?.[0]?.message,
            content: response.data.choices?.[0]?.message?.content
        });
        
        const result = response.data.choices[0].message.content || "I couldn't analyze the images.";
        console.log("✅ Vision analysis result:", result);
        return result;
    } catch (error) {
        console.error("Error in Groq vision chat:", error);
        if (axios.isAxiosError(error)) {
            const errorData = error.response?.data;
            console.error("Vision API Error Details:", {
                status: error.response?.status,
                statusText: error.response?.statusText,
                data: errorData,
                message: error.message
            });
            
            // Log specific error messages
            if (error.response?.status === 400) {
                console.error("🚨 Bad Request (400) - Possible causes:");
                console.error("   - Invalid image format or encoding");
                console.error("   - Image too large (>4MB for base64)");
                console.error("   - Image resolution too high (>33 megapixels)");
                console.error("   - Too many images (>5 per request)");
                if (errorData?.error?.message) {
                    console.error("   - Server message:", errorData.error.message);
                }
            } else if (error.response?.status === 413) {
                console.error("🚨 Request Too Large (413) - Image data exceeds 4MB limit");
            }
        }
        // Fallback to text-only if vision fails
        console.log("🔄 Vision failed, falling back to text-only mode");
        return await groqTextChat(
            "You are a helpful AI assistant for smart glasses. The user is asking about their surroundings, but I cannot see the images at the moment.",
            question
        );
    }
}

// Fallback: If vision model not available, use text-based approach
export async function groqTextChat(systemPrompt: string, userPrompt: string): Promise<string> {
    try {
        console.log("🧠 Using Groq Llama 4 Maverick for text");
        
        const response = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
            model: "meta-llama/llama-4-maverick-17b-128e-instruct",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt },
            ],
            temperature: 0.7,
            max_completion_tokens: 1024,
            top_p: 1
        }, { headers });
        
        const result = response.data.choices[0].message.content || "I couldn't process your request.";
        console.log("✅ Text chat response received:", result.substring(0, 100) + "...");
        return result;
    } catch (error) {
        console.error("Error in Groq text chat:", error);
        if (axios.isAxiosError(error)) {
            console.error("Text API Error Details:", {
                status: error.response?.status,
                statusText: error.response?.statusText,
                data: error.response?.data,
                message: error.message
            });
        }
        return "I couldn't process your request at the moment. Please try again.";
    }
}
