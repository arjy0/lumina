import axios from "axios";
import { keys } from "../keys";

const headers = {
    'Authorization': `Bearer ${keys.groq}`
};

export async function groqRequest(systemPrompt: string, userPrompt: string) {
    try {
        console.info("Calling Groq moonshotai/kimi-k2-instruct")
        const response = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
            model: "moonshotai/kimi-k2-instruct",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt },
            ],
            temperature: 0.6,
            max_tokens: 4096,
            top_p: 1
        }, { headers });
        return response.data.choices[0].message.content;
    } catch (error) {
        console.error("Error in groqRequest:", error);
        return null; // or handle error differently
    }
}


