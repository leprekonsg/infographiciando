import { ResearchFact } from "../../types/slideTypes";
import { runAgentLoop, CostTracker, Tool, ToolDefinition, ThinkingLevel, MODEL_AGENTIC } from "../interactionsClient";

// --- TOOL DEFINITIONS (Following Phil Schmid's Ergonomics Guidelines) ---

const webSearchTool: ToolDefinition = {
    name: "web_search",
    description: "Search the web for current, verified information about a topic. Use this when you need real-time data, statistics, market trends, or facts that require up-to-date sources. Returns structured search results with URLs and snippets.",
    parameters: {
        type: "object",
        properties: {
            query: {
                type: "string",
                description: "The search query to execute. Be specific and include relevant keywords for better results."
            }
        },
        required: ["query"]
    }
};

const extractFactsTool: ToolDefinition = {
    name: "extract_facts",
    description: "Extract and structure verified facts from search results or provided text. Use this after web_search to organize raw information into validated, citable facts with confidence scores.",
    parameters: {
        type: "object",
        properties: {
            raw_content: {
                type: "string",
                description: "The raw content or search results to extract facts from."
            },
            focus_area: {
                type: "string",
                description: "The specific domain or topic focus for fact extraction (e.g., 'market statistics', 'technical specifications')."
            }
        },
        required: ["raw_content", "focus_area"]
    }
};

// --- AGENT 1: RESEARCHER (with Tool Execution Loop) ---

export async function runResearcher(topic: string, costTracker: CostTracker): Promise<ResearchFact[]> {
    console.log("[RESEARCHER] Starting research agent with Interactions API...");

    // Define tool implementations
    const tools: Record<string, Tool> = {
        web_search: {
            definition: webSearchTool,
            execute: async (args: { query: string }) => {
                // In production, this would call a real search API
                // For now, we use Google Search grounding in the model call
                return {
                    status: "delegated_to_model",
                    query: args.query,
                    note: "Search executed via Google Search grounding in model call"
                };
            }
        }
    };

    try {
        const result = await runAgentLoop(
            `Perform deep research on "${topic}".
      
      RESEARCH OBJECTIVES:
      1. Find 8-12 verified, high-impact facts and statistics
      2. Focus on: Market data, technical specifications, trends, and expert insights
      3. Prioritize recent information (last 2 years) when available
      
      OUTPUT REQUIREMENTS:
      Return a JSON array of research facts with this structure:
      [
        {
          "id": "fact-1",
          "category": "Market Trend | Technical Spec | Statistic | Expert Opinion",
          "claim": "The main factual claim",
          "value": "Specific numeric value if applicable",
          "source": "Source name or URL",
          "confidence": "high | medium | low"
        }
      ]
      
      CRITICAL: Return ONLY the JSON array. No preamble or markdown.`,
            {
                model: MODEL_AGENTIC,
                systemInstruction: `You are a Lead Technical Researcher with expertise in finding and validating information.
        
        Your research must be:
        - ACCURATE: Only include verified facts from reliable sources
        - CURRENT: Prefer recent data when possible
        - SPECIFIC: Include concrete numbers, not vague claims
        - ATTRIBUTABLE: Always note the source
        
        Use Google Search grounding when you need current information.`,
                tools: {}, // Using built-in Google Search via grounding instead
                maxIterations: 5,
                thinkingLevel: 'low' as ThinkingLevel,
                temperature: 0.3,
                onToolCall: (name, args, result) => {
                    console.log(`[RESEARCHER] Tool called: ${name}`, args);
                }
            },
            costTracker
        );

        // Parse the JSON response
        try {
            const parsed = JSON.parse(result.text);
            if (Array.isArray(parsed)) return parsed;
            if (parsed.facts && Array.isArray(parsed.facts)) return parsed.facts;
            return [];
        } catch (parseErr) {
            console.warn("[RESEARCHER] JSON parse failed, attempting extraction...");
            // Try to extract JSON from the response
            const jsonMatch = result.text.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
                try {
                    return JSON.parse(jsonMatch[0]);
                } catch {
                    console.error("[RESEARCHER] Extraction failed");
                }
            }
            return [];
        }
    } catch (e: any) {
        console.error("[RESEARCHER] Agent failed:", e.message);
        return [];
    }
}

// Keep export to avoid unused lint for future tooling
export const _unusedExtractFactsTool = extractFactsTool;
