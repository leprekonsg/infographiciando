import React, { useState, useEffect } from 'react';
import Header from './components/Header';
import MarkdownInput from './components/MarkdownInput';
import ResultPreview from './components/ResultPreview';
import SlideDeckBuilder from './components/SlideDeckBuilder';
import { generateVisualContent, GeneratedImageResult, GenerationMode } from './services/geminiService';
import { Key, ArrowRight, ExternalLink, Presentation, LayoutTemplate, Box, FileCode, Sticker } from 'lucide-react';

const DEFAULT_MARKDOWN = `## Cloud Computing Architecture

### Cloud Storage
Redundant storage systems across multiple data centers.

### Edge Computing
Processing data closer to the source to reduce latency.

### Virtualization
Running multiple isolated operating systems on one physical server.`;

const App: React.FC = () => {
  const [markdown, setMarkdown] = useState<string>(DEFAULT_MARKDOWN);
  
  const [resultsHistory, setResultsHistory] = useState<Record<GenerationMode, GeneratedImageResult[]>>({
    'infographic': [],
    'presentation': [],
    'visual-asset': [],
    'vector-svg': [],
    'sticker': []
  });

  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [hasApiKey, setHasApiKey] = useState<boolean>(false);
  const [checkingKey, setCheckingKey] = useState<boolean>(true);
  const [mode, setMode] = useState<GenerationMode>('infographic');
  const [error, setError] = useState<string | null>(null);
  
  // UX CHANGE: Default to Agentic View
  const [view, setView] = useState<'quick' | 'agentic'>('agentic');

  useEffect(() => {
    const checkKey = async () => {
      try {
        if ((window as any).aistudio?.hasSelectedApiKey) {
          const hasKey = await (window as any).aistudio.hasSelectedApiKey();
          setHasApiKey(hasKey);
        } else {
          setHasApiKey(true);
        }
      } catch (e) {
        setHasApiKey(false);
      } finally {
        setCheckingKey(false);
      }
    };
    checkKey();
  }, []);

  const handleSelectKey = async () => {
    if ((window as any).aistudio?.openSelectKey) {
      await (window as any).aistudio.openSelectKey();
      setHasApiKey(true);
    }
  };

  const handleGenerate = async () => {
    if (!markdown.trim() || isGenerating) return;
    setIsGenerating(true);
    setError(null);
    
    try {
      await generateVisualContent(
        markdown,
        mode,
        (res) => {
          setResultsHistory(prev => ({
            ...prev,
            [mode]: [...prev[mode], res]
          }));
        },
        setStatusMessage
      );
    } catch (error: any) {
      console.error(error);
      setError(error.message || "An unexpected error occurred during generation.");
    } finally {
      setIsGenerating(false);
      setStatusMessage("");
    }
  };

  const getModeActiveStyle = (m: GenerationMode) => {
     switch(m) {
      case 'presentation': return 'bg-[#1e222d] text-blue-400 shadow-[0_0_20px_-5px_rgba(59,130,246,0.3)] border-blue-500/30';
      case 'visual-asset': return 'bg-[#1e222d] text-amber-400 shadow-[0_0_20px_-5px_rgba(245,158,11,0.3)] border-amber-500/30';
      case 'vector-svg': return 'bg-[#1e222d] text-purple-400 shadow-[0_0_20px_-5px_rgba(168,85,247,0.3)] border-purple-500/30';
      case 'sticker': return 'bg-[#1e222d] text-pink-400 shadow-[0_0_20px_-5px_rgba(236,72,153,0.3)] border-pink-500/30';
      default: return 'bg-[#1e222d] text-emerald-400 shadow-[0_0_20px_-5px_rgba(16,185,129,0.3)] border-emerald-500/30';
    }
  };

  if (checkingKey) return <div className="min-h-screen bg-[#0a0c10] flex items-center justify-center text-white font-mono">Checking Session...</div>;

  if (!hasApiKey) {
    return (
      <div className="min-h-screen bg-[#0a0c10] flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-[#12141c] border border-white/5 rounded-3xl p-10 text-center space-y-8 shadow-2xl animate-reveal">
          <div className="w-20 h-20 bg-emerald-500/10 rounded-2xl flex items-center justify-center mx-auto rotate-3">
            <Key className="w-10 h-10 text-emerald-500" />
          </div>
          <div className="space-y-2">
            <h2 className="text-3xl font-bold text-white tracking-tight">Access Pro Models</h2>
            <p className="text-slate-400 text-sm leading-relaxed">
              Unlock Gemini 3 Pro Design capabilities. High-fidelity rendering requires a professional API key session.
            </p>
          </div>
          <button onClick={handleSelectKey} className="w-full py-4 bg-emerald-500 hover:bg-emerald-400 text-black font-bold rounded-2xl transition-all transform hover:-translate-y-1 active:scale-95 flex items-center justify-center gap-2">
            Connect AI Key <ArrowRight className="w-4 h-4" />
          </button>
          <div className="pt-4 border-t border-white/5">
             <a href="https://ai.google.dev/gemini-api/docs/billing" target="_blank" rel="noopener noreferrer" className="text-xs text-slate-500 hover:text-emerald-400 flex items-center justify-center gap-1 transition-colors">
               Documentation & Billing <ExternalLink className="w-3 h-3" />
             </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-[#0a0c10] overflow-hidden">
      <Header view={view} setView={setView} />
      
      <main className="flex-1 w-full max-w-[1600px] mx-auto px-6 py-6 flex flex-col min-h-0">
        {view === 'quick' ? (
          <div className="flex flex-col h-full space-y-4 animate-reveal">
            
            {/* Quick Mode Toolbar */}
            <div className="flex items-center justify-center">
              <div className="bg-[#12141c] border border-white/5 p-1 rounded-2xl flex items-center gap-2 shadow-sm relative overflow-hidden">
                  <button onClick={() => setMode('infographic')} className={`px-4 py-2 rounded-xl flex items-center gap-2 text-xs font-bold transition-all border border-transparent ${mode === 'infographic' ? getModeActiveStyle('infographic') : 'text-slate-500 hover:text-slate-300 hover:bg-white/5'}`}>
                    <LayoutTemplate className="w-3.5 h-3.5" /> Infographic
                  </button>
                  <button onClick={() => setMode('presentation')} className={`px-4 py-2 rounded-xl flex items-center gap-2 text-xs font-bold transition-all border border-transparent ${mode === 'presentation' ? getModeActiveStyle('presentation') : 'text-slate-500 hover:text-slate-300 hover:bg-white/5'}`}>
                    <Presentation className="w-3.5 h-3.5" /> Slide Deck
                  </button>
                  <button onClick={() => setMode('visual-asset')} className={`px-4 py-2 rounded-xl flex items-center gap-2 text-xs font-bold transition-all border border-transparent ${mode === 'visual-asset' ? getModeActiveStyle('visual-asset') : 'text-slate-500 hover:text-slate-300 hover:bg-white/5'}`}>
                    <Box className="w-3.5 h-3.5" /> 3D Asset
                  </button>
                  <button onClick={() => setMode('vector-svg')} className={`px-4 py-2 rounded-xl flex items-center gap-2 text-xs font-bold transition-all border border-transparent ${mode === 'vector-svg' ? getModeActiveStyle('vector-svg') : 'text-slate-500 hover:text-slate-300 hover:bg-white/5'}`}>
                    <FileCode className="w-3.5 h-3.5" /> SVG
                  </button>
                  <button onClick={() => setMode('sticker')} className={`px-4 py-2 rounded-xl flex items-center gap-2 text-xs font-bold transition-all border border-transparent ${mode === 'sticker' ? getModeActiveStyle('sticker') : 'text-slate-500 hover:text-slate-300 hover:bg-white/5'}`}>
                    <Sticker className="w-3.5 h-3.5" /> Sticker
                  </button>
              </div>
            </div>

            {/* Quick Mode Split View */}
            <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-6 min-h-0">
              <div className="h-full min-h-[500px]">
                <MarkdownInput 
                  value={markdown} 
                  onChange={setMarkdown} 
                  isGenerating={isGenerating} 
                  onGenerate={handleGenerate}
                  mode={mode}
                />
              </div>
              <div className="h-full min-h-[500px]">
                <ResultPreview 
                  onGenerate={handleGenerate} 
                  isGenerating={isGenerating} 
                  results={resultsHistory[mode]} 
                  statusMessage={statusMessage} 
                  mode={mode}
                  error={error} 
                />
              </div>
            </div>
          </div>
        ) : (
          <SlideDeckBuilder onBack={() => setView('quick')} />
        )}
      </main>
    </div>
  );
};

export default App;