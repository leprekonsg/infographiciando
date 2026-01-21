import { GoogleGenAI, Modality } from "@google/genai";
import { CostTracker } from "../interactionsClient";

// Helper to get AI client for image generation (still uses generateContent)
const getAiClient = () => {
    const apiKey = process.env.API_KEY;
    if (!apiKey) {
        const errorMsg = `[SLIDE AGENT ERROR] API_KEY is not configured for image generation.

To fix this:
1. Create a .env file in the project root
2. Add: GEMINI_API_KEY=your_api_key_here
3. Get your key from: https://aistudio.google.com/app/apikey
4. Restart the dev server`;
        console.error(errorMsg);
        throw new Error('API_KEY is required for image generation. Check console for setup instructions.');
    }
    return new GoogleGenAI({ apiKey });
};

// --- IMAGE GENERATION (Still uses generateContent for image modality) ---

// CRITICAL: Background images must NOT contain any content elements.
// Text, icons, diagrams, charts are rendered separately by SpatialLayoutEngine.
const NEGATIVE_PROMPT_INFO = `
photorealistic, 3d render, messy, clutter, blurry, low resolution, 
distorted text, bad layout, sketch, hand drawn, organic textures, grunge,
footer text, copyright notice, watermark, template borders, frame, mock-up, 
padding, margins,
TEXT, WORDS, LETTERS, LABELS, NUMBERS, CAPTIONS, TITLES, HEADINGS,
DIAGRAMS, CHARTS, GRAPHS, PIE CHARTS, BAR CHARTS, FLOWCHARTS, ARROWS,
ICONS, SYMBOLS, LOGOS, UI ELEMENTS, BUTTONS, BOXES, RECTANGLES WITH TEXT,
INFOGRAPHICS, DATA VISUALIZATIONS, PROCESS FLOWS, TIMELINES,
PEOPLE, FACES, HANDS, HUMANS, FIGURES
`.trim().replace(/\n/g, ' ');

// Image model configuration:
// - Default to 2.5 Flash Image: 71% cheaper ($0.039 vs $0.134 per image)
// - Visual prompts are short (no long text generation), Flash is sufficient
// - Pro is fallback for quota/quality issues
const IMAGE_MODELS = {
    DEFAULT: 'gemini-2.5-flash-image',      // 71% cheaper, sufficient for visual prompts
    FALLBACK: 'gemini-3-pro-image-preview'  // Higher quality fallback
};

interface ImageGenerationError {
    type: 'quota' | 'content_filter' | 'timeout' | 'network' | 'unknown';
    model: string;
    message: string;
    retryable: boolean;
}

function classifyImageError(error: any, model: string): ImageGenerationError {
    const message = error?.message || String(error);
    const status = error?.status;

    // Quota/Rate limit
    if (status === 429 || message.includes('429') || message.includes('quota') || message.includes('RESOURCE_EXHAUSTED')) {
        return { type: 'quota', model, message: 'Rate limit exceeded', retryable: true };
    }

    // Content filter (safety)
    if (message.includes('SAFETY') || message.includes('blocked') || message.includes('content filter')) {
        return { type: 'content_filter', model, message: 'Content blocked by safety filter', retryable: false };
    }

    // Timeout
    if (status === 499 || message.includes('timeout') || message.includes('cancelled') || message.includes('DEADLINE')) {
        return { type: 'timeout', model, message: 'Request timed out', retryable: true };
    }

    // Network issues
    if (status === 503 || message.includes('503') || message.includes('Overloaded') || message.includes('UNAVAILABLE')) {
        return { type: 'network', model, message: 'Service temporarily unavailable', retryable: true };
    }

    return { type: 'unknown', model, message: message.slice(0, 100), retryable: false };
}

export async function generateImageFromPrompt(
    prompt: string,
    aspectRatio: string = "16:9",
    costTracker?: CostTracker
): Promise<{ imageUrl: string, model: string } | null> {
    const ai = getAiClient();

    // Order: 2.5 Flash first (cheaper), Pro as fallback
    const models = [IMAGE_MODELS.DEFAULT, IMAGE_MODELS.FALLBACK];

    // Background-only prompt: NO text, diagrams, icons, or content elements
    // All content is rendered separately by SpatialLayoutEngine
    const richPrompt = `
TASK: Generate an ABSTRACT BACKGROUND IMAGE only.

SUBJECT THEME: ${prompt}

STRICT RULES:
- This is a BACKGROUND TEXTURE/GRADIENT only
- Text, icons, charts, and diagrams will be overlaid SEPARATELY by another system
- DO NOT generate any readable text, words, letters, or numbers
- DO NOT generate any diagrams, flowcharts, arrows, or process flows
- DO NOT generate any icons, symbols, logos, or UI elements
- ONLY generate: gradients, lighting effects, abstract shapes, textures, color fields

STYLE: Cinematic lighting, subtle gradients, professional corporate aesthetic.
COMPOSITION: Large areas of low contrast or dark tones for text overlay.
MOOD: Modern, premium, sophisticated.

NEGATIVE (DO NOT INCLUDE): ${NEGATIVE_PROMPT_INFO}
`.trim();

    // Log prompt length to verify it's short
    console.log(`[IMAGE GEN] Prompt length: ${richPrompt.length} chars, starting with ${models[0]}...`);

    const errors: ImageGenerationError[] = [];

    for (const modelName of models) {
        try {
            console.log(`[IMAGE GEN] Attempting ${modelName}...`);

            const response = await ai.models.generateContent({
                model: modelName,
                contents: { parts: [{ text: richPrompt }] },
                config: {
                    imageConfig: { aspectRatio },
                    responseModalities: [Modality.IMAGE]
                }
            });

            if (response.candidates?.[0]?.content?.parts) {
                for (const part of response.candidates[0].content.parts) {
                    if (part.inlineData?.data) {
                        if (costTracker) {
                            costTracker.addImageCost(modelName);
                        }
                        console.log(`[IMAGE GEN] ✅ Success with ${modelName}`);
                        return {
                            imageUrl: `data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}`,
                            model: modelName
                        };
                    }
                }
            }

            // No image data in response
            console.warn(`[IMAGE GEN] ${modelName} returned no image data`);
            errors.push({ type: 'unknown', model: modelName, message: 'No image data in response', retryable: true });

        } catch (e: any) {
            const classifiedError = classifyImageError(e, modelName);
            errors.push(classifiedError);

            console.warn(`[IMAGE GEN] ${modelName} failed: ${classifiedError.type} - ${classifiedError.message}`);

            // For retryable errors, try next model
            if (classifiedError.retryable && modelName !== models[models.length - 1]) {
                console.log(`[IMAGE GEN] Falling back to ${models[models.indexOf(modelName) + 1]}...`);
                continue;
            }

            // Content filter: Don't try other models (same prompt will fail)
            if (classifiedError.type === 'content_filter') {
                console.error(`[IMAGE GEN] ⚠️ Content blocked by safety filter. Prompt may need adjustment.`);
                break;
            }

            // Last model failed
            if (modelName === models[models.length - 1]) {
                console.error(`[IMAGE GEN] ❌ All models failed. Errors:`, errors.map(e => `${e.model}: ${e.type}`));
                break;
            }
        }
    }

    // Graceful null return - caller will handle missing image
    console.warn(`[IMAGE GEN] Returning null. Slide will render without background image.`);
    return null;
}
