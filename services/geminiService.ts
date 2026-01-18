
import { GoogleGenAI, Type, Modality, GenerateContentResponse } from "@google/genai";

// Helper to create client instance
const getAiClient = () => new GoogleGenAI({ apiKey: process.env.API_KEY });

// --- PROMPT STRATEGIES ---

// 1. General Negative Prompt: For 3D assets, Stickers, and general visuals where we want pure art, no text.
const NEGATIVE_PROMPT_ART = "text, watermark, labels, ui interface, distorted details, blur, low quality, cartoon, sketch, ugly, messy, clutter, deformed, bad anatomy, crop, cutoff, realistic photo of mundane object";

// 2. Infographic/Slide Negative Prompt: Allows for text-like structures, charts, and layouts, but bans messiness.
// Added specific bans for footer text, borders, and template artifacts.
const NEGATIVE_PROMPT_INFO = "photorealistic, 3d render, messy, clutter, blurry, low resolution, distorted text, bad layout, sketch, hand drawn, organic textures, grunge, footer text, copyright notice, watermark, template borders, frame, mock-up, padding, margins";

// Limit input size to prevent "Unterminated string" errors caused by model truncating massive inputs
const MAX_INPUT_CHARS = 20000;

export interface GeneratedImageResult {
  imageUrl: string;
  sectionTitle: string;
  mode: GenerationMode;
}

interface ContentPagePlan {
  title: string;
  content: string; 
  visualConcept: string; 
  visualPromptSuggestion: string; 
  requiresSearch: boolean;
}

interface GenerationPlan {
  slides: ContentPagePlan[];
  globalVisualStyle: string;
}

export type GenerationMode = 'infographic' | 'presentation' | 'visual-asset' | 'vector-svg' | 'sticker';

// Robust JSON Extractor
const extractJson = (text: string): string => {
  if (!text) return "{}";
  
  let content = text;
  
  // 1. Try to extract from markdown code block first
  const jsonBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (jsonBlockMatch && jsonBlockMatch[1]) {
    content = jsonBlockMatch[1]; 
  }

  // 2. Find the first '{' and the last '}'
  const firstBrace = content.indexOf('{');
  const lastBrace = content.lastIndexOf('}');
  
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return content.substring(firstBrace, lastBrace + 1);
  }
  
  // If we cannot find a valid JSON envelope, return empty object.
  return "{}";
};

// SVG Extractor
const extractSvg = (text: string): string => {
  if (!text) return "";
  
  const firstTag = text.indexOf('<svg');
  const lastTag = text.lastIndexOf('</svg>');
  
  if (firstTag !== -1 && lastTag !== -1) {
    return text.substring(firstTag, lastTag + 6);
  }
  
  // Fallback
  return text.replace(/```(?:xml|svg)?/g, "").trim();
};

// --- IMAGE PROCESSING UTILITIES ---
// Client-side background removal for "Sticker" mode
const removeWhiteBackground = (base64Data: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "Anonymous";
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(base64Data);
        return;
      }
      
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;
      
      // Threshold for "White" (0-255)
      // Since we prompt for "pure white", we can be aggressive.
      const threshold = 240; 
      
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        
        // If pixel is significantly white
        if (r > threshold && g > threshold && b > threshold) {
           data[i + 3] = 0; // Set Alpha to 0 (Transparent)
        }
      }
      
      ctx.putImageData(imageData, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = (e) => {
      console.warn("Background removal failed, returning original.", e);
      resolve(base64Data);
    };
    img.src = base64Data;
  });
};

// Retry utility for transient errors
const callWithRetry = async <T>(
  operation: () => Promise<T>, 
  onRetry: (attempt: number, delayMs: number) => void
): Promise<T> => {
  const MAX_RETRIES = 3;
  let lastError: any;
  
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      return await operation();
    } catch (err: any) {
      lastError = err;
      // Check for transient errors
      const isTransient = 
        err.status === 503 || 
        err.status === 429 || 
        (err.message && err.message.toLowerCase().includes('overloaded'));
      
      if (attempt <= MAX_RETRIES && isTransient) {
        // Exponential backoff: 2s, 4s, 8s
        const delayMs = 2000 * Math.pow(2, attempt - 1);
        onRetry(attempt, delayMs);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
};

// --- SINGLE IMAGE GENERATOR (EXPORTED FOR AGENTIC BUILDER) ---
export const generateImageFromPrompt = async (
  prompt: string,
  aspectRatio: string = "16:9"
): Promise<{ imageUrl: string, model: string } | null> => {
  const ai = getAiClient();
  const models = ['gemini-3-pro-image-preview', 'gemini-2.5-flash-image'];

  // Enrich prompt to ensure high quality background for slides
  const richPrompt = `
  SUBJECT: ${prompt}
  CONTEXT: Professional Presentation Slide Background.
  STYLE: High-fidelity, cinematic lighting, corporate aesthetic.
  CONSTRAINT: Ensure substantial negative space or low contrast areas for overlay text. 
  NEGATIVE: ${NEGATIVE_PROMPT_INFO}
  `;

  for (const modelName of models) {
      try {
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
                    return {
                      imageUrl: `data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}`,
                      model: modelName
                    };
                }
            }
        }
      } catch (e: any) {
          const isQuota = e.status === 429 || (e.message && (e.message.includes('429') || e.message.includes('quota')));
          if (isQuota && modelName !== models[models.length - 1]) {
             console.warn(`Quota exceeded for ${modelName}, switching to ${models[models.indexOf(modelName)+1]}`);
             continue; 
          }
          console.error(`Failed to generate single image with ${modelName}`, e);
          if (modelName === models[models.length - 1]) return null;
      }
  }
  return null;
};


// --- RLM CORE: THE ROOT ARCHITECT ---
const analyzeAndPlanContent = async (markdown: string, mode: GenerationMode): Promise<GenerationPlan> => {
  const ai = getAiClient();

  // Truncate input to avoid huge contexts that might cause response truncation
  const safeMarkdown = markdown.length > MAX_INPUT_CHARS 
    ? markdown.substring(0, MAX_INPUT_CHARS) + "\n...(truncated source)..."
    : markdown;

  const generatePlanWithModel = async (modelName: string, enableThinking: boolean) => {
    
    // RLM STRATEGY: HIERARCHICAL PROMPTING (Using System Instructions)
    let systemInstruction = "";
    
    const baseRole = `You are a world-class Visual Information Architect.`;

    if (mode === 'presentation') {
      systemInstruction = `${baseRole} You are acting as a Presentation Designer.
      
      GOAL: Create polished, high-fidelity presentation slides.
      
      STRATEGY:
      1. [DECOMPOSE]: Split the content into 3-5 key slides.
      2. [SLIDE COMPOSITION]: For each slide, determine the visual composition.
         - Is it a "Title Slide" (Impactful visual)?
         - Is it a "Content Slide" (Clean background with side visual)?
         - Is it a "Data Slide" (Chart focus)?
      3. [VISUALIZE]: The 'visualPromptSuggestion' must describe the FULL SLIDE IMAGE.
         - Describe a professional background with integrated graphical elements representing the concept.
         - Example: "A sleek dark mode slide background with a glowing abstract data stream on the right side, space for text on the left."`;
    } else if (mode === 'infographic') {
      systemInstruction = `${baseRole} You are acting as a Senior Data Journalist.
      
      GOAL: Transform text into structured, informative visual layouts.
      
      STRATEGY:
      1. [STRUCTURAL ANALYSIS]: Determine the best information architecture (Timeline, Process Flow, Comparison, Hierarchy, or Statistics).
      2. [LAYOUT DESIGN]: Imagine a vertical infographic layout (full bleed, no margins).
      3. [VISUALIZE]: The 'visualPromptSuggestion' must describe the LAYOUT and DIAGRAMS.
         - Use terms like: "Vertical flowchart", "Split screen comparison", "Step-by-step roadmap".
         - Style: "Flat vector style, clean lines, professional business aesthetic".`;
    } else if (mode === 'vector-svg') {
      systemInstruction = `${baseRole} You are acting as a Master Iconographer.
      
      GOAL: Simplify complex ideas into elegant, geometric vector symbols.
      
      STRATEGY:
      1. [REDUCTION]: Reduce the paragraph to a single noun or action.
      2. [GEOMETRY]: Imagine the concept using basic shapes (circles, lines, rounded rects).
      3. [VISUALIZE]: The 'visualPromptSuggestion' must describe the geometry and composition of an icon.
         - Focus on: "Monoline style", "Geometric shapes", "Symmetry", "Negative space".`;
    } else if (mode === 'sticker') {
      systemInstruction = `${baseRole} You are acting as a Corporate Identity Designer.
      
      GOAL: Create professional, cohesive die-cut stickers.
      
      STRATEGY:
      1. [DEEP UNDERSTANDING]: Analyze specific business concepts for centrality and consistency.
      2. [METAPHOR SELECTION]: Select a physical object that embodies this specific nuance (e.g., Central Hub, Master Key, Prism).
      3. [VISUALIZATION]: Describe this object as a high-quality die-cut sticker.
         - Mandatory keywords: "Die-cut sticker, flat vector style, white border, professional, isolated on pure white background".`;
    } else {
      // Visual Asset (3D)
      systemInstruction = `${baseRole} You are acting as a Conceptual 3D Artist.
      
      GOAL: Translate abstract business concepts into sophisticated 3D illustrations.
      
      STRATEGY:
      1. [SYNTHESIS]: Identify the core abstract concept.
      2. [METAPHOR]: Create a clever visual metaphor (e.g., "Glowing crystalline data block" instead of "document").
      3. [VISUALIZE]: The 'visualPromptSuggestion' must be a polished, abstract 3D composition.
         - Mandatory keywords: "Abstract 3D render, glassmorphism, subsurface scattering, minimalist high-tech, soft studio lighting, on pure white background".`;
    }

    const taskPrompt = `
      INPUT SOURCE:
      ${safeMarkdown}

      OUTPUT FORMAT:
      Return a JSON object conforming to the schema, containing 'globalVisualStyle' and a list of 'slides'.
    `;

    const config: any = {
      systemInstruction: systemInstruction,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          globalVisualStyle: { type: Type.STRING },
          slides: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                content: { type: Type.STRING },
                visualConcept: { type: Type.STRING },
                visualPromptSuggestion: { type: Type.STRING },
                requiresSearch: { type: Type.BOOLEAN }
              },
              required: ["title", "content", "visualConcept", "visualPromptSuggestion", "requiresSearch"]
            }
          }
        },
        required: ["globalVisualStyle", "slides"]
      }
    };

    if (enableThinking) {
       config.thinkingConfig = { thinkingBudget: 4096 }; // High budget for deep metaphor/structure analysis
    }

    try {
      const response = await callWithRetry<GenerateContentResponse>(
        () => ai.models.generateContent({
          model: modelName,
          contents: taskPrompt, 
          config
        }),
        (attempt, delay) => console.log(`Planning retry attempt ${attempt}...`)
      );

      if (!response.text) throw new Error("Empty response from AI model");

      const cleanedJson = extractJson(response.text);
      try {
        return JSON.parse(cleanedJson) as GenerationPlan;
      } catch (e) {
        console.error("JSON Parse Error. Input length:", cleanedJson.length);
        throw new Error("Failed to parse AI response. The output may have been truncated or malformed.");
      }

    } catch (error) {
      console.error("Planning Error:", error);
      throw new Error("Failed to plan content structure. Please try again.");
    }
  };

  return await generatePlanWithModel('gemini-3-flash-preview', true);
};

// --- RLM CORE: THE EXECUTOR ---
export const generateVisualContent = async (
  markdown: string, 
  mode: GenerationMode,
  onResult: (result: GeneratedImageResult) => void,
  onStatus: (status: string) => void
): Promise<void> => {
  
  const ai = getAiClient();
  onStatus(`Analyzing for ${mode}...`);
  
  let plan: GenerationPlan;
  try {
    plan = await analyzeAndPlanContent(markdown, mode);
  } catch (e: any) {
    throw e;
  }

  const globalStyle = plan.globalVisualStyle;

  for (let i = 0; i < plan.slides.length; i++) {
    const page = plan.slides[i];
    onStatus(`Rendering ${mode} component ${i + 1}/${plan.slides.length}: ${page.title}...`);

    if (mode === 'vector-svg') {
      // --- SVG CODE GENERATION PATH ---
      const svgSystemInstruction = `You are an expert SVG artist and coder.
        Your goal is to create high-quality, modern, flat vector illustrations.
        
        CONSTRAINTS:
        - Format: Provide valid <svg> code ONLY. No comments.
        - Style: Minimalist, Tech-focused, Geometric, Professional.
        - Colors: Use Emerald (#10b981), White (#ffffff), Slate (#94a3b8), and Amber (#f59e0b). 
        - Background: TRANSPARENT. Do not include a background rectangle.
        - Dimensions: viewBox="0 0 512 512".
        - Strokes: Use clean strokes and fills. Ensure paths are closed.`;

      const svgPrompt = `
        VISUAL CONCEPT: ${page.visualConcept}
        PROMPT: ${page.visualPromptSuggestion}
        STYLE: ${globalStyle}
        
        OUTPUT: RAW SVG STRING ONLY.
      `;

      try {
        const response = await callWithRetry<GenerateContentResponse>(
          () => ai.models.generateContent({
             model: 'gemini-3-flash-preview', 
             contents: svgPrompt,
             config: { 
               systemInstruction: svgSystemInstruction,
               thinkingConfig: { thinkingBudget: 1024 } 
             }
          }),
          (attempt, delay) => onStatus(`System overloaded. Retrying SVG ${page.title} (Attempt ${attempt})...`)
        );
        
        if (response.text) {
          const svgCode = extractSvg(response.text);
          const encodedSvg = encodeURIComponent(svgCode);
          const dataUrl = `data:image/svg+xml;charset=utf-8,${encodedSvg}`;
          
          onResult({
            imageUrl: dataUrl,
            sectionTitle: page.title,
            mode
          });
        }
      } catch (err: any) {
         console.error(`Failed to generate SVG for ${page.title}`, err);
      }
      
    } else {
      // --- RASTER IMAGE GENERATION PATH (WITH FALLBACK) ---
      
      const models = ['gemini-3-pro-image-preview', 'gemini-2.5-flash-image']; 
      let aspectRatio = "1:1";
      let finalPrompt = "";
      let tools: any[] = []; 

      // Mode-Specific Prompt Construction
      if (mode === 'visual-asset') {
        aspectRatio = "1:1";
        finalPrompt = `
        SUBJECT: ${page.visualPromptSuggestion}
        STYLE: ${globalStyle}. High-end Abstract 3D Art. Isolated on white background.
        NEGATIVE: ${NEGATIVE_PROMPT_ART}
        `;
      } else if (mode === 'presentation') {
        aspectRatio = "16:9";
        finalPrompt = `
        SUBJECT: ${page.visualPromptSuggestion}
        STYLE: ${globalStyle}. Professional Presentation Slide. High-fidelity background with abstract data elements.
        NEGATIVE: ${NEGATIVE_PROMPT_INFO}
        `;
      } else if (mode === 'infographic') {
        aspectRatio = "3:4";
        // Explicitly asking for a poster layout with charts/data
        finalPrompt = `
        DESIGN: A full-bleed vertical infographic.
        TOPIC: ${page.visualPromptSuggestion}
        STYLE: ${globalStyle}. Flat vector art, organized layout, clear sections, data visualization, flowcharts.
        LAYOUT: Edge-to-edge content. No white borders. No margins. No footer text.
        DETAILS: Use solid colors, clean geometry, and infographic elements (icons, connectors, bar charts).
        NEGATIVE: ${NEGATIVE_PROMPT_INFO}
        `;
      } else if (mode === 'sticker') {
        aspectRatio = "1:1";
        // Stickers often require higher fidelity or tools support if complex
        finalPrompt = `
        SUBJECT: ${page.visualPromptSuggestion}
        STYLE: ${globalStyle}. Die-cut sticker, clean vector finish, professional design.
        CONSTRAINT: ISOLATED ON PURE WHITE BACKGROUND (#FFFFFF).
        NEGATIVE: ${NEGATIVE_PROMPT_ART}, photo, realistic, shadow, gradient background, noise, grunge, distressed
        `;
        tools = [{googleSearch: {}}];
      } 

      // Fallback Loop for Raster Images
      let success = false;
      for (const modelName of models) {
          if (success) break;
          try {
              const generateConfig: any = {
                imageConfig: { aspectRatio },
                responseModalities: [Modality.TEXT, Modality.IMAGE]
              };

              // Only add tools if model supports it (Pro models mainly)
              if (tools.length > 0 && modelName.includes('pro')) {
                generateConfig.tools = tools;
              }

              const response = await ai.models.generateContent({
                  model: modelName,
                  contents: { parts: [{ text: finalPrompt }] },
                  config: generateConfig
              });

              if (response.candidates?.[0]?.content?.parts) {
                  let foundImage = false;
                  for (const part of response.candidates[0].content.parts) {
                    if (part.inlineData?.data) {
                      let base64Image = `data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}`;
                      
                      // Post-Processing for Stickers: Remove Background
                      if (mode === 'sticker') {
                          onStatus(`Processing transparency for ${page.title}...`);
                          base64Image = await removeWhiteBackground(base64Image);
                      }

                      onResult({ 
                        imageUrl: base64Image, 
                        sectionTitle: page.title, 
                        mode 
                      });
                      foundImage = true;
                      success = true;
                      break;
                    }
                  }
                  if (!foundImage) console.warn(`No image found for ${page.title} with ${modelName}`);
              }
          } catch (err: any) {
              const isQuota = err.status === 429 || (err.message && (err.message.includes('429') || err.message.includes('quota')));
              if (isQuota && modelName !== models[models.length - 1]) {
                  console.warn(`Quota exceeded for ${modelName}, failing over...`);
                  continue;
              }
              console.error(`Failed to generate image for ${page.title} with ${modelName}`, err);
          }
      }
    }
  }
  onStatus("Done");
};
