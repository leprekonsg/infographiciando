
# InfographIQ - Agentic Slide Builder

InfographIQ is an advanced Single Page Application (SPA) that uses a swarm of autonomous AI agents to build professional, data-driven slide decks from a simple topic prompt. It leverages Google's Gemini 3 models (Flash, Pro, and Imagen) for research, structural planning, layout routing, and asset generation.

## 🧠 Architecture: The Agent Swarm

The application is built on a "Recursive Language Model" (RLM) architecture where specialized agents hand off context to one another.

### 1. Researcher Agent (`gemini-3-flash`)
*   **Role:** Technical Researcher.
*   **Task:** Uses Google Search grounding to extract 10 verified, high-impact facts and statistics about the user's topic.
*   **Output:** A structured "Knowledge Sheet" (JSON) containing claims, values, sources, and confidence levels.

### 2. Architect Agent (`gemini-3-pro`)
*   **Role:** Principal System Architect.
*   **Task:** Analyzes the Knowledge Sheet and structures a narrative flow (Intro -> Problem -> Solution -> Data -> Conclusion).
*   **Output:** An `OutlineSchema` defining the slide list, purpose of each slide, and specific "Fact Clusters" assigned to each slide to prevent hallucination.

### 3. Router Agent (`gemini-3-flash`)
*   **Role:** Visual Designer.
*   **Task:** Analyzes the intent of a single slide and assigns a `RenderMode` (e.g., 'data-viz', 'infographic') and `LayoutVariant` (e.g., 'split-left-text', 'bento-grid').
*   **Output:** A `RouterDecision` payload containing density budgets and layout constraints.

### 4. Generator Agent (RLM Loop) (`gemini-3-pro`)
*   **Role:** Information Designer.
*   **Task:** Generates the actual JSON content structure for the slide, adhering to the Router's constraints and the Architect's assigned facts.
*   **Features:**
    *   **Self-Correction:** Includes a `Repairer` loop that attempts to fix validation errors (text overflow, missing icons, repetition) automatically.
    *   **Deterministic Repair:** A sanitizer layer aggressively deduplicates content and injects missing assets before validation.
    *   **Circuit Breaker:** Automatically downgrades to lighter models if rate limits (429) are hit repeatedly.

## 🛠 Tech Stack

*   **Frontend:** React 18, TypeScript, Tailwind CSS.
*   **AI Models:** Google Gemini 3 Pro Preview, Gemini 3 Flash Preview, Gemini 3 Pro Image Preview.
*   **SDK:** `@google/genai` (Official Google GenAI SDK).
*   **Validation:** Zod (Runtime schema validation).
*   **Export:** `pptxgenjs` (Client-side PowerPoint generation).
*   **Icons:** Lucide React (Rendered to PNG for PPTX export).

## 🚀 Key Features

*   **Quick Generate:** One-shot generation of infographics, stickers, and assets.
*   **Agentic Builder:** Full deck generation with live activity feed of agent thoughts.
*   **High-Fidelity Rendering:** Custom canvas renderer that simulates PowerPoint layouts in the browser.
*   **PPTX Export:** Native export preserving layouts, images, and speaker notes.
*   **Robust Error Handling:** 
    *   Exponential backoff for API calls.
    *   JSON repair for truncated responses.
    *   Model circuit breakers for stability.

## 📦 Setup & Usage

1.  **Environment:** Ensure you have a valid Google GenAI API Key with access to the Gemini 3 Preview models.
2.  **Run:** Open the application.
3.  **API Key:** Click "Connect AI Key" and select your project.
4.  **Create:** Enter a topic (e.g., "Future of Quantum Computing") and watch the agents work.

## 🛡️ Quality Assurance

The `validateSlide` function acts as a "Delight QA" gate. It checks for:
*   **Text Density:** Ensures slides aren't walls of text.
*   **Visual Balance:** Enforces icon usage in grids/cards.
*   **Repetition:** Detects and rejects hallucinated loops.
*   **Schema Integrity:** Ensures valid JSON structure.

If validation fails, the RLM loop triggers the **Repairer Agent** to fix the JSON specifically addressing the error codes returned by the validator.
