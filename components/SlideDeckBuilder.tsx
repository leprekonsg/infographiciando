
import React, { useState } from 'react';
import { EditableSlideDeck, StyleMode } from '../types/slideTypes';
import { generateAgenticDeck, regenerateSingleSlide } from '../services/slideAgentService';
import { generateImageFromPrompt } from '../services/geminiService';
import { InfographicRenderer, normalizeColor } from '../services/infographicRenderer';
import { Bot, Download, Play, Clock, ShieldCheck, Sparkles, BrainCircuit, AlertTriangle, ArrowRight, DollarSign, RefreshCw, AlertOctagon, Briefcase, Users, Zap } from 'lucide-react';
import pptxgen from 'pptxgenjs';
import ActivityFeed, { ActivityLogItem } from './ActivityFeed';
import BuilderCanvas from './BuilderCanvas';

/**
 * Style mode configuration for UI display
 */
const STYLE_MODE_CONFIG: Record<StyleMode, {
    label: string;
    description: string;
    icon: React.ReactNode;
    gradient: string;
    borderColor: string;
}> = {
    corporate: {
        label: 'Corporate',
        description: 'Board decks, investor presentations. Maximum clarity, strict alignment, zero chaos.',
        icon: <Briefcase className="w-5 h-5" />,
        gradient: 'from-slate-600 to-slate-700',
        borderColor: 'border-slate-500/50'
    },
    professional: {
        label: 'Professional',
        description: 'Team meetings, workshops. Balanced readability with moderate visual interest.',
        icon: <Users className="w-5 h-5" />,
        gradient: 'from-blue-600 to-indigo-600',
        borderColor: 'border-blue-500/50'
    },
    serendipitous: {
        label: 'Creative',
        description: 'Thought leadership, pitches. Bold visuals, dramatic layouts, memorable impact.',
        icon: <Zap className="w-5 h-5" />,
        gradient: 'from-purple-600 to-pink-600',
        borderColor: 'border-purple-500/50'
    }
};

interface SlideDeckBuilderProps {
    onBack: () => void;
}

const SlideDeckBuilder: React.FC<SlideDeckBuilderProps> = ({ onBack }) => {
    const [topic, setTopic] = useState("");
    const [styleMode, setStyleMode] = useState<StyleMode>('professional');
    const [isBuilding, setIsBuilding] = useState(false);
    const [progressVal, setProgressVal] = useState(0);
    const [deck, setDeck] = useState<EditableSlideDeck | null>(null);
    const [activeSlideIndex, setActiveSlideIndex] = useState(0);
    const [activityLog, setActivityLog] = useState<ActivityLogItem[]>([]);
    const [visRegen, setVisRegen] = useState(false);
    const [contentRegen, setContentRegen] = useState(false);

    // --- ACTIONS ---

    const handleBuild = async () => {
        if (!topic.trim()) return;
        setIsBuilding(true);
        setDeck(null);
        setProgressVal(0);
        setActivityLog([{ 
            id: 'init', 
            message: `Initializing RLM Agent Loop (Style: ${STYLE_MODE_CONFIG[styleMode].label})...`, 
            timestamp: new Date(), 
            type: 'info' 
        }]);

        try {
            const newDeck = await generateAgenticDeck(
                topic, 
                (status, percent) => {
                    if (percent !== undefined) setProgressVal(percent);

                    let type: ActivityLogItem['type'] = 'agent';
                    if (status.includes('RLM Loop')) type = 'validation';

                    setActivityLog(prev => [
                        ...prev,
                        { id: crypto.randomUUID(), message: status, timestamp: new Date(), type, agentName: status.split(':')[0] }
                    ]);
                },
                { styleMode } // Pass style mode to generation
            );
            setDeck(newDeck);
            setActiveSlideIndex(0);
            setActivityLog(prev => [...prev, { id: 'done', message: 'Generation Complete.', timestamp: new Date(), type: 'success' }]);
        } catch (e: any) {
            // Log the full error to console for debugging
            console.error('[SLIDE DECK BUILDER] Generation failed:', e);
            console.error('[SLIDE DECK BUILDER] Error stack:', e.stack);
            setActivityLog(prev => [...prev, { id: 'err', message: e.message, timestamp: new Date(), type: 'error' }]);
        } finally {
            setIsBuilding(false);
        }
    };

    const handleRegenerateVisual = async () => {
        if (!deck || visRegen) return;
        const slide = deck.slides[activeSlideIndex];
        if (!slide.visualPrompt) return;

        setVisRegen(true);
        try {
            const result = await generateImageFromPrompt(slide.visualPrompt, "16:9");
            if (result && result.imageUrl) {
                const newSlides = [...deck.slides];
                newSlides[activeSlideIndex] = { ...slide, backgroundImageUrl: result.imageUrl };
                setDeck({ ...deck, slides: newSlides });
            }
        } catch (e: any) {
            console.error('[VISUAL REGENERATION] Failed:', e);
            console.error('[VISUAL REGENERATION] Error stack:', e.stack);
        } finally { setVisRegen(false); }
    };

    const handleRegenerateContent = async () => {
        if (!deck || contentRegen) return;
        const slideIndex = activeSlideIndex;
        const currentSlide = deck.slides[slideIndex];
        // Get the original meta from the outline structure, assuming order matches
        const meta = deck.meta.slides[slideIndex];

        if (!meta) return;

        setContentRegen(true);
        try {
            // Use the new exposed service function
            const newSlideNode = await regenerateSingleSlide(
                meta,
                currentSlide,
                deck.meta.knowledgeSheet
            );

            // Preserve background if the new one doesn't have one (though usually we want new visuals if content changes)
            // But here, regenerateSingleSlide generates new visual prompts too.
            // Let's keep the old image if the user liked it, unless they explicitly regen visuals later?
            // Actually, let's keep the existing image for continuity unless it failed before.
            if (currentSlide.backgroundImageUrl && !newSlideNode.backgroundImageUrl) {
                newSlideNode.backgroundImageUrl = currentSlide.backgroundImageUrl;
            }

            const newSlides = [...deck.slides];
            newSlides[slideIndex] = newSlideNode;
            setDeck({ ...deck, slides: newSlides });

        } catch (e: any) {
            console.error("Failed to regenerate slide content", e);
            alert("Regeneration failed: " + e.message);
        } finally {
            setContentRegen(false);
        }
    };

    const handleExport = async () => {
        if (!deck) return;
        const pres = new pptxgen();
        const renderer = new InfographicRenderer();
        pres.title = deck.meta.title;

        pres.defineSlideMaster({
            title: "MASTER",
            background: {
                color: normalizeColor(deck.meta.styleGuide?.colorPalette?.background, "0F172A")
            }
        });

        await renderer.prepareIconsForDeck(deck.slides, deck.meta.styleGuide.colorPalette);
        await renderer.prepareDiagramsForDeck(deck.slides, deck.meta.styleGuide);

        for (const slide of deck.slides) {
            const pSlide = pres.addSlide({ masterName: "MASTER" });
            if (slide.backgroundImageUrl) {
                // FIX: Explicit dimensions in inches (standard 16:9 PPTX) to avoid 100% bug
                pSlide.addImage({
                    data: slide.backgroundImageUrl,
                    x: 0, y: 0, w: 10, h: 5.625,
                    transparency: 15  // Reduced from 60 to show background properly (85% opacity)
                });
            }
            await renderer.renderSlideFromPlan({ slide, styleGuide: deck.meta.styleGuide, pptSlide: pSlide, pres });
            // Notes handled within renderer to account for new array format
        }
        pres.writeFile({ fileName: `InfographIQ-${deck.meta.title}.pptx` });
    };

    // --- RENDER START SCREEN ---

    if (!deck) {
        return (
            <div className="flex-1 w-full h-full flex flex-col lg:flex-row gap-6 animate-reveal">
                {/* LEFT: INPUT */}
                <div className="lg:w-2/3 flex flex-col bg-[#12141c] rounded-[2rem] border border-white/5 shadow-2xl overflow-hidden relative group">
                    {/* Background Decoration */}
                    <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-blue-500/5 rounded-full blur-[100px] pointer-events-none -translate-y-1/2 translate-x-1/2"></div>

                    <div className="flex-1 p-12 flex flex-col justify-center max-w-3xl mx-auto w-full z-10">
                        <div className="mb-8 space-y-4">
                            <div className="w-16 h-16 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-2xl flex items-center justify-center shadow-lg shadow-blue-500/20 mb-6">
                                <BrainCircuit className="w-8 h-8 text-white" />
                            </div>
                            <h1 className="text-4xl font-extrabold text-white tracking-tight">Agentic Deck Builder</h1>
                            <p className="text-slate-400 text-lg leading-relaxed">
                                Describe your topic, audience, and goals. Our swarm of autonomous agents will research, structure, design, and validate a professional slide deck for you.
                            </p>
                        </div>

                        <div className="space-y-6">
                            <div className="relative">
                                <textarea
                                    value={topic} onChange={(e) => setTopic(e.target.value)} disabled={isBuilding}
                                    placeholder="Example: Create a pitch deck for a Series A AI startup focusing on healthcare efficiency..."
                                    className="w-full h-40 bg-black/40 text-slate-200 p-6 rounded-3xl resize-none focus:outline-none focus:ring-2 focus:ring-blue-500/50 border border-white/10 text-lg placeholder:text-slate-600 transition-all"
                                />
                                {topic.length > 0 && !isBuilding && (
                                    <div className="absolute bottom-4 right-4">
                                        <span className="text-[10px] uppercase font-bold text-slate-500 bg-black/60 px-2 py-1 rounded border border-white/5">
                                            Cmd + Enter to Submit
                                        </span>
                                    </div>
                                )}
                            </div>

                            {/* STYLE MODE SELECTOR */}
                            <div className="space-y-3">
                                <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">
                                    Presentation Style
                                </label>
                                <div className="grid grid-cols-3 gap-3">
                                    {(Object.keys(STYLE_MODE_CONFIG) as StyleMode[]).map((mode) => {
                                        const config = STYLE_MODE_CONFIG[mode];
                                        const isSelected = styleMode === mode;
                                        return (
                                            <button
                                                key={mode}
                                                type="button"
                                                onClick={() => setStyleMode(mode)}
                                                disabled={isBuilding}
                                                className={`
                                                    p-4 rounded-2xl border-2 transition-all text-left
                                                    ${isSelected 
                                                        ? `bg-gradient-to-br ${config.gradient} ${config.borderColor} shadow-lg` 
                                                        : 'bg-black/30 border-white/10 hover:border-white/20 hover:bg-black/40'
                                                    }
                                                    ${isBuilding ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
                                                `}
                                            >
                                                <div className="flex items-center gap-2 mb-2">
                                                    <div className={`
                                                        p-1.5 rounded-lg
                                                        ${isSelected ? 'bg-white/20' : 'bg-white/10'}
                                                    `}>
                                                        {config.icon}
                                                    </div>
                                                    <span className={`
                                                        font-bold text-sm
                                                        ${isSelected ? 'text-white' : 'text-slate-300'}
                                                    `}>
                                                        {config.label}
                                                    </span>
                                                </div>
                                                <p className={`
                                                    text-[10px] leading-relaxed
                                                    ${isSelected ? 'text-white/80' : 'text-slate-500'}
                                                `}>
                                                    {config.description}
                                                </p>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>

                            <button onClick={handleBuild} disabled={isBuilding || !topic} className="w-full py-5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-lg font-bold rounded-2xl flex items-center justify-center gap-3 shadow-xl transition-all hover:scale-[1.01] active:scale-[0.99]">
                                {isBuilding ? (
                                    <>
                                        <Sparkles className="w-5 h-5 animate-spin" /> Agents Working...
                                    </>
                                ) : (
                                    <>
                                        Launch Agent Swarm <ArrowRight className="w-5 h-5" />
                                    </>
                                )}
                            </button>
                        </div>
                    </div>
                </div>

                {/* RIGHT: LOG */}
                <div className="lg:w-1/3 h-full min-h-[500px]">
                    <ActivityFeed logs={activityLog} progress={progressVal} />
                </div>
            </div>
        );
    }

    // --- RENDER DASHBOARD ---

    const activeSlide = deck.slides[activeSlideIndex];
    const hasCriticalWarnings = activeSlide.warnings?.some(w => w.includes('Error') || w.includes('Safe Mode'));

    // Format speaker notes for display (handle array or string legacy)
    const displayNotes = activeSlide.speakerNotesLines && Array.isArray(activeSlide.speakerNotesLines)
        ? activeSlide.speakerNotesLines.join('\n\n')
        : "No notes.";

    return (
        <div className="flex flex-col h-full animate-reveal">
            {/* HEADER */}
            <div className="flex items-center justify-between mb-6 flex-shrink-0">
                <div className="flex items-center gap-4">
                    <div className="p-3 bg-blue-500/10 rounded-2xl border border-blue-500/20 shadow-lg shadow-blue-500/10">
                        <Bot className="w-6 h-6 text-blue-500" />
                    </div>
                    <div>
                        <h2 className="text-xl font-bold text-white tracking-tight">{deck.meta.title}</h2>
                        <div className="flex gap-4 text-slate-400 text-xs mt-1 font-medium">
                            <span className="flex items-center gap-1.5"><Clock className="w-3.5 h-3.5" /> {(deck.metrics.totalDurationMs / 1000).toFixed(1)}s</span>
                            <span className="flex items-center gap-1.5"><ShieldCheck className="w-3.5 h-3.5 text-emerald-500" /> QA Score: {activeSlide.validation?.score || 100}</span>
                            {deck.metrics.totalCost !== undefined && (
                                <span className="flex items-center gap-1.5 text-amber-500"><DollarSign className="w-3.5 h-3.5" /> Cost: ${deck.metrics.totalCost.toFixed(4)}</span>
                            )}
                        </div>
                    </div>
                </div>
                <div className="flex gap-3">
                    <button onClick={onBack} className="px-5 py-2.5 bg-[#1e222d] border border-white/5 text-slate-300 hover:text-white font-bold rounded-xl transition-all text-xs">
                        Start New
                    </button>
                    <button onClick={handleExport} className="px-6 py-2.5 bg-emerald-500 text-black font-bold rounded-xl flex items-center gap-2 hover:bg-emerald-400 transition-all shadow-lg shadow-emerald-500/20 text-xs">
                        <Download className="w-4 h-4" /> Export PPTX
                    </button>
                </div>
            </div>

            {/* MAIN WORKSPACE */}
            <div className="flex-1 grid grid-cols-12 gap-6 min-h-0">
                {/* LEFT: SLIDE LIST */}
                <div className="col-span-3 bg-[#12141c] rounded-3xl border border-white/5 p-2 overflow-y-auto space-y-1 custom-scrollbar">
                    {deck.slides.map((s, i) => {
                        const hasWarnings = s.warnings && s.warnings.length > 0;
                        const isCrit = s.warnings?.some(w => w.includes('Safe Mode'));
                        return (
                            <div key={i} onClick={() => setActiveSlideIndex(i)}
                                className={`p-4 rounded-2xl cursor-pointer border transition-all group relative ${i === activeSlideIndex ? 'bg-blue-600/10 border-blue-500/50 shadow-md' : 'bg-transparent border-transparent hover:bg-white/5'}`}>
                                <div className="flex justify-between mb-1.5">
                                    <span className={`text-[9px] font-black px-1.5 py-0.5 rounded uppercase tracking-wider ${i === activeSlideIndex ? 'bg-blue-500 text-white' : 'bg-white/10 text-slate-500 group-hover:text-slate-300'}`}>#{i + 1}</span>
                                    {isCrit ? (
                                        <AlertOctagon className="w-3.5 h-3.5 text-red-500" />
                                    ) : hasWarnings ? (
                                        <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
                                    ) : (
                                        <span className="text-[9px] font-bold text-slate-500 uppercase tracking-wider truncate max-w-[80px] text-right">{s.routerConfig?.renderMode}</span>
                                    )}
                                </div>
                                <p className={`text-xs font-bold leading-snug ${i === activeSlideIndex ? 'text-white' : 'text-slate-400 group-hover:text-slate-200'}`}>{s.title}</p>
                            </div>
                        );
                    })}
                </div>

                {/* CENTER: EDITOR */}
                <div className="col-span-9 grid grid-cols-1 lg:grid-cols-2 gap-6 h-full min-h-0">
                    {/* EDITOR CONTROLS */}
                    <div className="bg-[#12141c] rounded-3xl border border-white/5 p-6 flex flex-col h-full min-h-0 overflow-hidden">
                        <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2">
                            <Sparkles className="w-4 h-4 text-amber-500" /> Insight Engine
                        </h3>

                        <div className="overflow-y-auto space-y-6 flex-1 pr-2 custom-scrollbar">
                            <div className="space-y-2">
                                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Router Logic</label>
                                <div className="bg-black/30 p-4 rounded-2xl border border-white/5 space-y-3">
                                    <div className="flex justify-between text-xs text-slate-300 border-b border-white/5 pb-2">
                                        <span>Density Budget</span>
                                        <span className="font-mono text-emerald-400 font-bold">{activeSlide.routerConfig?.densityBudget.maxChars} chars</span>
                                    </div>
                                    <div className="flex justify-between text-xs text-slate-300 border-b border-white/5 pb-2">
                                        <span>Layout Intent</span>
                                        <span className="font-mono text-blue-400 font-bold text-right max-w-[150px] truncate">{activeSlide.routerConfig?.layoutIntent}</span>
                                    </div>
                                    <div className="flex justify-between text-xs text-slate-300">
                                        <span>Visual Focus</span>
                                        <span className="font-mono text-amber-400 font-bold text-right max-w-[150px] truncate">{activeSlide.routerConfig?.visualFocus}</span>
                                    </div>
                                </div>
                            </div>

                            <div className="space-y-2">
                                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Speaker Notes</label>
                                <div className="bg-black/30 p-4 rounded-2xl border border-white/5 text-slate-300 text-xs leading-relaxed italic whitespace-pre-wrap">
                                    "{displayNotes}"
                                </div>
                            </div>

                            {/* WARNINGS & ERROR HANDLING */}
                            {activeSlide.warnings && activeSlide.warnings.length > 0 && (
                                <div className={`p-4 rounded-2xl border ${hasCriticalWarnings ? 'bg-red-500/10 border-red-500/30' : 'bg-amber-500/5 border-amber-500/20'}`}>
                                    <h4 className={`${hasCriticalWarnings ? 'text-red-400' : 'text-amber-500'} text-xs font-bold flex items-center gap-2 mb-2`}>
                                        <AlertTriangle className="w-3.5 h-3.5" />
                                        {hasCriticalWarnings ? 'Generation Recovered (Errors)' : 'Quality Assurance Notes'}
                                    </h4>
                                    <ul className={`text-[10px] space-y-1.5 list-disc pl-3 mb-4 ${hasCriticalWarnings ? 'text-red-200/70' : 'text-amber-200/70'}`}>
                                        {activeSlide.warnings.map((w, i) => <li key={i}>{w}</li>)}
                                    </ul>

                                    <button
                                        onClick={handleRegenerateContent}
                                        disabled={contentRegen}
                                        className={`w-full py-2 rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition-all ${hasCriticalWarnings
                                            ? 'bg-red-500 hover:bg-red-400 text-white shadow-lg shadow-red-900/20'
                                            : 'bg-amber-500/10 hover:bg-amber-500/20 text-amber-500'
                                            }`}
                                    >
                                        <RefreshCw className={`w-3 h-3 ${contentRegen ? 'animate-spin' : ''}`} />
                                        {contentRegen ? 'Fixing Slide...' : 'Regenerate Content'}
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* VISUAL PREVIEW */}
                    <div className="h-full min-h-0">
                        <BuilderCanvas
                            slide={activeSlide}
                            styleGuide={deck.meta.styleGuide}
                            onRegenerateVisual={handleRegenerateVisual}
                            isRegeneratingVisual={visRegen}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
};

export default SlideDeckBuilder;
