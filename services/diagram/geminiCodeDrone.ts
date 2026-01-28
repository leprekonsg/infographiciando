/**
 * Gemini Code Drone - Tier 3 Custom Diagram Generation via Code Execution
 * 
 * ARCHITECTURAL ROLE:
 * This is the ISOLATED Tier 3 engine, reserved ONLY for:
 * - Custom diagram generation requiring iterative code refinement
 * - Complex measurement algorithms that need Python execution
 * - "Graph Drone" custom visualizations in serendipitous mode
 * 
 * WHEN TO USE:
 * - complexity === 'complex' OR diagramType === 'custom-network'
 * - User explicitly requests "custom" or "novel" visualization
 * - styleMode === 'experimental' (future)
 * 
 * COST PROFILE:
 * - Latency: 3-8s (significantly slower than Qwen3-VL)
 * - Cost: ~$0.005 per call + execution time
 * - Should represent <10% of total visual validation calls
 * 
 * DO NOT USE for:
 * - Standard layout validation (use Qwen3-VL Tier 2)
 * - Overflow detection (use Qwen3-VL Tier 2)
 * - Simple diagram types (use deterministic Tier 1)
 */

import { GoogleGenAI } from '@google/genai';
import type { CostTracker } from '../interactionsClient';

// ============================================================================
// TYPES
// ============================================================================

export interface CodeDroneResult {
    svg: string;
    pythonCode: string;
    executionTime: number;
    iterations: number;
    validation: CodeDroneValidation;
}

export interface CodeDroneValidation {
    passed: boolean;
    errors: string[];
    warnings: string[];
    dimensions: { width: number; height: number };
    elementsCount: number;
}

export interface CodeDroneOptions {
    maxIterations?: number;
    targetDimensions?: { width: number; height: number };
    colorPalette?: string[];
    fontFamily?: string;
    validateBounds?: boolean;
}

// ============================================================================
// DEFAULT CONFIGURATION
// ============================================================================

const DEFAULT_OPTIONS: Required<CodeDroneOptions> = {
    maxIterations: 3,
    targetDimensions: { width: 800, height: 600 },
    colorPalette: ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6'],
    fontFamily: 'Arial, sans-serif',
    validateBounds: true
};

// ============================================================================
// GEMINI CODE DRONE CLASS
// ============================================================================

/**
 * GeminiCodeDrone - Isolated use case for Python code execution
 * 
 * Uses Gemini 3.0 Flash Preview with code execution capability
 * to generate custom diagrams iteratively.
 */
export class GeminiCodeDrone {
    private apiKey: string;
    private model: string = 'gemini-2.5-flash-preview-05-20';
    private client: GoogleGenAI | null = null;

    constructor() {
        this.apiKey = process.env.API_KEY || process.env.GEMINI_API_KEY || '';
        if (!this.apiKey) {
            console.warn('[GEMINI-CODE-DRONE] API key not configured. Code execution will be unavailable.');
        } else {
            this.client = new GoogleGenAI({ apiKey: this.apiKey });
        }
    }

    /**
     * Check if the drone is available
     */
    isAvailable(): boolean {
        return !!this.apiKey && !!this.client;
    }

    /**
     * Generate a custom diagram using Python code execution
     * 
     * @param data - Data to visualize
     * @param visualIntent - Natural language description of desired visualization
     * @param costTracker - Cost tracking
     * @param options - Generation options
     */
    async generateCustomDiagram(
        data: any,
        visualIntent: string,
        costTracker?: CostTracker,
        options: CodeDroneOptions = {}
    ): Promise<CodeDroneResult> {
        if (!this.isAvailable() || !this.client) {
            throw new Error('Gemini Code Drone not available - API key not configured');
        }

        const opts = { ...DEFAULT_OPTIONS, ...options };
        const startTime = Date.now();
        console.log(`[GEMINI-CODE-DRONE] Starting custom diagram generation: "${visualIntent.slice(0, 50)}..."`);

        try {
            const prompt = this.buildCodeGenerationPrompt(data, visualIntent, opts);
            
            let bestResult: CodeDroneResult | null = null;
            let iterations = 0;

            // Iterative refinement loop
            for (let i = 0; i < opts.maxIterations; i++) {
                iterations++;
                console.log(`[GEMINI-CODE-DRONE] Iteration ${iterations}/${opts.maxIterations}`);

                // Use @google/genai SDK with code execution tool
                const response = await this.client.models.generateContent({
                    model: this.model,
                    contents: prompt,
                    config: {
                        tools: [{ codeExecution: {} }]  // Enable Python sandbox
                    }
                });

                // Track costs
                if (costTracker && response.usageMetadata) {
                    const inputTokens = response.usageMetadata.promptTokenCount || 0;
                    const outputTokens = response.usageMetadata.candidatesTokenCount || 0;
                    // Use Gemini Flash pricing via addUsage interface
                    costTracker.addUsage(this.model, {
                        total_input_tokens: inputTokens,
                        total_output_tokens: outputTokens,
                        total_reasoning_tokens: 0,
                        total_tokens: inputTokens + outputTokens,
                        total_tool_use_tokens: 0
                    });
                }

                // Extract execution result
                const executionResult = this.extractExecutionResult(response);
                
                if (executionResult.svg) {
                    const validation = this.validateSvgOutput(executionResult.svg, opts);
                    
                    bestResult = {
                        svg: executionResult.svg,
                        pythonCode: executionResult.code,
                        executionTime: Date.now() - startTime,
                        iterations,
                        validation
                    };

                    // If validation passes, we're done
                    if (validation.passed) {
                        console.log(`[GEMINI-CODE-DRONE] Success after ${iterations} iterations (${bestResult.executionTime}ms)`);
                        return bestResult;
                    }

                    // Otherwise, add validation feedback for next iteration
                    console.log(`[GEMINI-CODE-DRONE] Validation failed: ${validation.errors.join(', ')}`);
                }
            }

            // Return best result even if not perfect
            if (bestResult) {
                console.log(`[GEMINI-CODE-DRONE] Returning best result after ${iterations} iterations`);
                return bestResult;
            }

            throw new Error('Code execution did not produce valid SVG output');
        } catch (error: any) {
            console.error(`[GEMINI-CODE-DRONE] Error: ${error.message}`);
            throw error;
        }
    }

    /**
     * Build the code generation prompt
     */
    private buildCodeGenerationPrompt(
        data: any,
        visualIntent: string,
        opts: Required<CodeDroneOptions>
    ): string {
        const colorPaletteStr = opts.colorPalette.map(c => `'${c}'`).join(', ');
        
        return `Generate a Python script using matplotlib or plotly to create: ${visualIntent}

DATA:
${JSON.stringify(data, null, 2)}

REQUIREMENTS:
1. Script must save output to /tmp/output.svg
2. Use this color palette: [${colorPaletteStr}]
3. Ensure all labels fit within ${opts.targetDimensions.width}x${opts.targetDimensions.height} bounds
4. Use font family: ${opts.fontFamily}
5. Include proper error handling
6. Add appropriate margins/padding for readability
7. Use clear, legible font sizes (minimum 10pt)

OUTPUT FORMAT:
- Generate clean, production-ready SVG
- No external dependencies beyond matplotlib/plotly
- Include axis labels and legend if applicable

Execute the code and return the SVG content.`;
    }

    /**
     * Extract execution result from Gemini response (@google/genai SDK format)
     */
    private extractExecutionResult(response: any): { svg: string; code: string } {
        let svg = '';
        let code = '';

        try {
            // @google/genai SDK response format uses candidates array
            const candidates = response.candidates || [];
            for (const candidate of candidates) {
                const content = candidate.content || {};
                const parts = content.parts || [];
                
                for (const part of parts) {
                    // Extract code from executableCode part
                    if (part.executableCode) {
                        code = part.executableCode.code || '';
                    }
                    
                    // Extract execution result from codeExecutionResult part
                    if (part.codeExecutionResult) {
                        const output = part.codeExecutionResult.output || '';
                        
                        // Check if output contains SVG
                        if (output.includes('<svg')) {
                            const svgMatch = output.match(/<svg[\s\S]*<\/svg>/);
                            if (svgMatch) {
                                svg = svgMatch[0];
                            }
                        }
                    }
                    
                    // Check text parts for SVG (fallback)
                    if (part.text && part.text.includes('<svg')) {
                        const svgMatch = part.text.match(/<svg[\s\S]*<\/svg>/);
                        if (svgMatch) {
                            svg = svgMatch[0];
                        }
                    }
                }
            }
            
            // Also check top-level text property (some SDK versions)
            if (!svg && response.text && typeof response.text === 'string') {
                if (response.text.includes('<svg')) {
                    const svgMatch = response.text.match(/<svg[\s\S]*<\/svg>/);
                    if (svgMatch) {
                        svg = svgMatch[0];
                    }
                }
            }
        } catch (error: any) {
            console.warn(`[GEMINI-CODE-DRONE] Failed to parse response: ${error.message}`);
        }

        return { svg, code };
    }

    /**
     * Validate SVG output
     */
    private validateSvgOutput(
        svg: string,
        opts: Required<CodeDroneOptions>
    ): CodeDroneValidation {
        const errors: string[] = [];
        const warnings: string[] = [];
        let dimensions = { width: 0, height: 0 };
        let elementsCount = 0;

        try {
            // Extract dimensions
            const widthMatch = svg.match(/width=["']?(\d+)/);
            const heightMatch = svg.match(/height=["']?(\d+)/);
            
            if (widthMatch) dimensions.width = parseInt(widthMatch[1]);
            if (heightMatch) dimensions.height = parseInt(heightMatch[1]);

            // Check bounds if validation enabled
            if (opts.validateBounds) {
                if (dimensions.width > opts.targetDimensions.width * 1.2) {
                    errors.push(`Width ${dimensions.width} exceeds target ${opts.targetDimensions.width}`);
                }
                if (dimensions.height > opts.targetDimensions.height * 1.2) {
                    errors.push(`Height ${dimensions.height} exceeds target ${opts.targetDimensions.height}`);
                }
            }

            // Count elements
            elementsCount = (svg.match(/<(rect|circle|path|text|line|polygon|ellipse)/g) || []).length;
            
            if (elementsCount === 0) {
                errors.push('SVG contains no visual elements');
            }

            // Check for common issues
            if (svg.includes('NaN')) {
                errors.push('SVG contains NaN values');
            }
            if (svg.includes('undefined')) {
                warnings.push('SVG contains undefined values');
            }

        } catch (error: any) {
            errors.push(`Validation error: ${error.message}`);
        }

        return {
            passed: errors.length === 0,
            errors,
            warnings,
            dimensions,
            elementsCount
        };
    }
}

// Singleton instance
let geminiCodeDroneInstance: GeminiCodeDrone | null = null;

/**
 * Get the singleton Gemini Code Drone instance
 */
export function getGeminiCodeDrone(): GeminiCodeDrone {
    if (!geminiCodeDroneInstance) {
        geminiCodeDroneInstance = new GeminiCodeDrone();
    }
    return geminiCodeDroneInstance;
}

/**
 * Check if Gemini Code Drone is available
 */
export function isGeminiCodeDroneAvailable(): boolean {
    return getGeminiCodeDrone().isAvailable();
}

// ============================================================================
// CONVENIENCE FUNCTION FOR DIAGRAM ORCHESTRATOR
// ============================================================================

/**
 * Generate a custom visualization using Gemini code execution
 * 
 * This is the entry point called from diagramOrchestrator when Tier 3 is selected.
 * 
 * @param data - Data to visualize
 * @param visualIntent - Natural language description
 * @param costTracker - Cost tracking
 */
export async function generateCustomVisualization(
    data: any,
    visualIntent: string,
    costTracker?: CostTracker
): Promise<{ svg: string; validation: CodeDroneValidation }> {
    const drone = getGeminiCodeDrone();
    
    if (!drone.isAvailable()) {
        throw new Error('Gemini Code Drone not available');
    }

    const result = await drone.generateCustomDiagram(data, visualIntent, costTracker);
    
    return {
        svg: result.svg,
        validation: result.validation
    };
}
