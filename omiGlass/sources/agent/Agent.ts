import * as React from 'react';
import { AsyncLock } from "../utils/lock";
import { startAudio } from '../modules/groq';
import { groqVisionChat, groqTextChat } from '../modules/groqVision';

type AgentState = {
    answer?: string;
    loading: boolean;
}

export class Agent {
    #lock = new AsyncLock();
    #photos: Uint8Array[] = [];
    #state: AgentState = { loading: false };
    #stateCopy: AgentState = { loading: false };
    #stateListeners: (() => void)[] = [];

    async addPhoto(photos: Uint8Array[]) {
        await this.#lock.inLock(async () => {
            // Clear previous photos and add new ones
            console.log('Adding photos:', photos.length, '(clearing previous', this.#photos.length, 'photos)');
            this.#photos = [...photos]; // Replace instead of append
            this.#notify();
        });
    }

    async answer(question: string): Promise<string> {
        try {
            startAudio()
        } catch(error) {
            console.log("Failed to start audio")
        }
        if (this.#state.loading) {
            return this.#state.answer || "I'm still processing your previous question.";
        }
        this.#state.loading = true;
        this.#notify();
        
        let answer: string = "";
        
        await this.#lock.inLock(async () => {
            if (this.#photos.length > 0) {
                // Use direct vision model with images
                console.log('🖼️ Using vision model with', this.#photos.length, 'images');
                answer = await groqVisionChat(question, this.#photos);
                console.log('🎯 Vision model returned:', answer);
            } else {
                // Fallback to text-only model
                console.log('💬 Using text model (no images)');
                answer = await groqTextChat(
                    "You are a helpful AI assistant for smart glasses.",
                    question
                );
                console.log('🎯 Text model returned:', answer);
            }
            
            console.log('📝 Setting agent state answer to:', answer);
            this.#state.answer = answer;
            this.#state.loading = false;
            console.log('📊 Agent state after update:', { 
                answer: this.#state.answer, 
                loading: this.#state.loading 
            });
            this.#notify();
        });
        
        return answer;
    }

    #notify = () => {
        this.#stateCopy = { ...this.#state };
        for (let l of this.#stateListeners) {
            l();
        }
    }


    use() {
        const [state, setState] = React.useState(this.#stateCopy);
        React.useEffect(() => {
            const listener = () => setState(this.#stateCopy);
            this.#stateListeners.push(listener);
            return () => {
                this.#stateListeners = this.#stateListeners.filter(l => l !== listener);
            }
        }, []);
        return state;
    }
}